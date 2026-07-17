import type { Config } from "./config.js";
import type { SessionMessage } from "./session.js";
import type { ToolDef, ToolResult } from "./tools.js";
import { createTools, toolSchemasForOpenAI } from "./tools.js";
import { streamChat } from "./provider.js";
import type { Workspace } from "./workspace.js";
import type { ApprovalMode } from "./approval.js";
import { needsApproval, promptApproval } from "./approval.js";
import { evaluateCommandPolicy, policyDenialMessage } from "./command-policy.js";
import { folderTrustDenialMessage } from "./folder-trust.js";
import { estimateCostUsd, lookupModelPrice, formatCostUsd } from "./cost.js";
import { buildEffectiveSystemPrompt } from "./instruction-context.js";
import { compactMessages, buildCompactedTranscript } from "./compaction.js";
import type { LoadedImage } from "./image-input.js";

const MAX_ROUNDS = 30;

export interface AgentOptions {
  config: Config;
  workspace: Workspace;
  approvalMode: ApprovalMode;
  sessionId: string;
  onMessage: (msg: SessionMessage) => void;
  sink?: AgentSink;
  // Optional spend budget in USD. When the running cost estimate reaches this
  // cap, the loop stops before issuing further provider calls. Null disables it.
  budgetUsd?: number | null;
  // Folder-trust enforcement. When false, every mutating tool (file or shell)
  // fails closed before approval is even considered, regardless of approvalMode
  // (so yolo cannot widen the boundary). Defaults to true (no enforcement) so
  // callers that do not opt in keep the existing behaviour.
  mutatingAllowed?: boolean;
  // Context-pressure threshold in tokens. When the most recent provider call's
  // prompt size reaches this, the in-memory transcript is compacted before the
  // next provider call (the on-disk transcript is untouched). Undefined or <= 0
  // disables auto-compaction.
  compactThreshold?: number;
  // Image attachments for the initial user prompt. They are sent to the provider
  // as multimodal content parts; only a non-secret reference is persisted (the
  // data URL never reaches the session log).
  images?: LoadedImage[];
}

// Cumulative usage and cost reported after each round. `estimatedCostUsd` is an
// estimate (never authoritative billing); `costKnown` reports whether the model
// price was found in the bundled table. `budgetReached` is true once the running
// estimate has met or exceeded `budgetUsd`.
export interface AgentUsage {
  round: number;
  tokens: { prompt: number; completion: number; total: number };
  estimatedCostUsd: number;
  costKnown: boolean;
  budgetUsd: number | null;
  budgetReached: boolean;
}

// A transient provider failure is being retried within a round. Metadata only —
// which attempt, the transient reason class, and the scheduled wait — so a
// consumer can observe resilience without seeing error text or secrets.
export interface AgentRetry {
  round: number;
  attempt: number;
  maxAttempts: number;
  reasonClass: string;
  delayMs: number;
}

// The in-memory transcript was compacted to relieve context pressure. Metadata
// only — how many messages were summarized and how many completed-action
// receipts were retained — so a consumer can observe the event without seeing
// content or secrets.
export interface AgentCompaction {
  round: number;
  summarizedMessages: number;
  receipts: number;
  promptTokens: number;
}

// Output sink for the agent loop. The default console sink reproduces the
// existing terminal behaviour; the headless sink (see headless-protocol.ts)
// renders the same lifecycle as a versioned JSON event stream.
export interface AgentSink {
  assistantDelta(delta: string): void;
  assistantTurn(text: string, round: number, opts: { final: boolean }): void;
  toolStart(info: { id: string; name: string; round: number }): void;
  toolResult(info: { id: string; name: string; result: ToolResult; round: number }): void;
  providerError(message: string): void;
  // Cumulative token usage and cost estimate, reported once per round.
  usage(info: AgentUsage): void;
  // A transient provider failure is being retried (bounded backoff).
  retry(info: AgentRetry): void;
  // The in-memory transcript was compacted to relieve context pressure.
  compaction?(info: AgentCompaction): void;
}

export function createConsoleSink(): AgentSink {
  return {
    assistantDelta: (delta) => {
      process.stdout.write(delta);
    },
    assistantTurn: (_text, _round, opts) => {
      if (opts.final) process.stdout.write("\n");
    },
    toolStart: () => {},
    toolResult: () => {},
    providerError: (message) => {
      process.stderr.write(`\nProvider error: ${message}\n`);
    },
    usage: (info) => {
      // Keep normal output uncluttered; surface only the actionable budget stop.
      if (info.budgetReached && info.budgetUsd !== null) {
        process.stderr.write(
          `\nSpend budget reached: estimated ${formatCostUsd(info.estimatedCostUsd)} ` +
            `>= ${formatCostUsd(info.budgetUsd)}; stopping before further provider calls.\n`,
        );
      }
    },
    retry: (info) => {
      // A brief stderr note so the wait is visible without polluting stdout.
      process.stderr.write(
        `\nProvider retry ${info.attempt}/${info.maxAttempts} after ${info.reasonClass} ` +
          `(waiting ${info.delayMs}ms).\n`,
      );
    },
    compaction: (info) => {
      // Surface the compaction so the context reduction is observable.
      process.stderr.write(
        `\nContext compacted: summarized ${info.summarizedMessages} message(s) ` +
          `(${info.receipts} completed-action receipt(s)) after ${info.promptTokens} prompt tokens.\n`,
      );
    },
  };
}

export interface AgentResult {
  text: string;
  ok: boolean;
  reason: "completed" | "provider_error" | "max_rounds" | "budget_reached";
  rounds: number;
  // Total transient provider retries across the run (0 when the provider never
  // failed transiently). Lets a consumer distinguish "exhausted retries"
  // (retries > 0, then provider_error) from "non-retryable" (retries 0).
  retries: number;
  // Bounded per-tool activity counts for the whole run. Each tool execution is
  // counted exactly once (no double-counted retries).
  stats: {
    toolCalls: Record<string, number>;
    toolFailures: Record<string, number>;
  };
  // Aggregated token totals across all rounds, or null when the provider never
  // reported usage.
  tokens: { prompt: number; completion: number; total: number } | null;
  // Estimated provider cost (USD) across the run, or null when the provider
  // never reported usage. An estimate, not authoritative billing.
  estimatedCostUsd: number | null;
  // Whether the model price was found in the bundled table (false ⇒ the
  // conservative fallback rate was used).
  costKnown: boolean;
}

export async function runAgent(
  userPrompt: string,
  existingMessages: SessionMessage[],
  opts: AgentOptions,
): Promise<AgentResult> {
  const sink = opts.sink ?? createConsoleSink();
  const tools = createTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const schemas = toolSchemasForOpenAI(tools);

  const messages: SessionMessage[] = [...existingMessages];

  if (messages.length === 0) {
    // Fresh session: seed with the effective repository instruction context
    // (bounded identity + Git state + trusted instruction hierarchy) instead of
    // a generic prompt. Resumed sessions keep their original system message.
    const { text } = buildEffectiveSystemPrompt({ workspace: opts.workspace.root });
    const system: SessionMessage = { role: "system", content: text };
    messages.push(system);
    opts.onMessage(system);
  }

  const userMsg: SessionMessage = { role: "user", content: userPrompt };
  if (opts.images && opts.images.length > 0) {
    // In-memory copy carries the data URLs the provider needs.
    userMsg.images = opts.images.map((img) => ({
      name: img.name,
      mediaType: img.mediaType,
      bytes: img.bytes,
      dataUrl: img.dataUrl,
    }));
  }
  messages.push(userMsg);
  // Persist a privacy-safe copy: the data URL (raw image bytes) never reaches
  // the session log; only the non-secret reference (name, type, size) is kept.
  opts.onMessage(
    userMsg.images
      ? { ...userMsg, images: userMsg.images.map(({ name, mediaType, bytes }) => ({ name, mediaType, bytes })) }
      : userMsg,
  );

  let finalText = "";

  const toolCalls: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};
  const tokens = { prompt: 0, completion: 0, total: 0 };
  let hasUsage = false;
  // Total transient provider retries observed across the run.
  let retries = 0;
  // Running cost estimate (USD) across the run. Recomputed from cumulative
  // tokens each round; null in snapshots until the provider reports usage.
  let costUsd = 0;
  const costKnown = lookupModelPrice(opts.config.model).known;
  const budgetUsd = opts.budgetUsd ?? null;
  // Context-pressure auto-compaction. Null disables it. `lastPromptTokens` is the
  // most recent provider call's prompt size — the live context pressure that
  // drives compaction at the next round boundary.
  const compactThreshold =
    typeof opts.compactThreshold === "number" && opts.compactThreshold > 0
      ? opts.compactThreshold
      : null;
  let lastPromptTokens = 0;
  const bump = (map: Record<string, number>, name: string) => {
    map[name] = (map[name] ?? 0) + 1;
  };
  const statsSnapshot = () => ({
    toolCalls: { ...toolCalls },
    toolFailures: { ...toolFailures },
  });
  const tokensSnapshot = () => (hasUsage ? { ...tokens } : null);
  const costSnapshot = () => (hasUsage ? costUsd : null);
  const budgetReached = () => budgetUsd !== null && costUsd >= budgetUsd;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Spend budget gate: once the running estimate has reached the cap, stop
    // before issuing a new provider call so no further billable calls are made.
    if (budgetReached()) {
      return {
        text: finalText,
        ok: false,
        reason: "budget_reached",
        rounds: round,
        retries,
        stats: statsSnapshot(),
        tokens: tokensSnapshot(),
        estimatedCostUsd: costSnapshot(),
        costKnown,
      };
    }

    // Context-pressure gate: when the most recent provider call's prompt size has
    // reached the threshold, compact the in-memory transcript before the next
    // provider call. Only the live `messages` window is replaced with a bounded
    // summary; the on-disk transcript is untouched (every message was already
    // persisted via onMessage). This runs at a round boundary where every prior
    // tool call already has its result, so no orphan tool_call is produced. The
    // threshold is reset so we do not re-compact until the context grows again.
    if (compactThreshold !== null && lastPromptTokens >= compactThreshold && messages.length > 1) {
      const triggeredAt = lastPromptTokens;
      const { summary } = compactMessages(messages);
      const compacted = buildCompactedTranscript(messages, summary);
      messages.length = 0;
      messages.push(...compacted);
      lastPromptTokens = 0;
      sink.compaction?.({
        round,
        summarizedMessages: summary.messageCount,
        receipts: summary.receipts.length,
        promptTokens: triggeredAt,
      });
    }

    let assistantText = "";
    const assistantToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    try {
      for await (const event of streamChat(opts.config, messages, { tools: schemas })) {
        if (event.type === "text") {
          assistantText += event.delta;
          sink.assistantDelta(event.delta);
        } else if (event.type === "tool_call") {
          assistantToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === "usage") {
          hasUsage = true;
          tokens.prompt += event.promptTokens;
          tokens.completion += event.completionTokens;
          tokens.total += event.totalTokens;
          lastPromptTokens = event.promptTokens;
        } else if (event.type === "retry") {
          retries++;
          sink.retry({
            round,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            reasonClass: event.reasonClass,
            delayMs: event.delayMs,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sink.providerError(msg);
      return {
        text: assistantText,
        ok: false,
        reason: "provider_error",
        rounds: round,
        retries,
        stats: statsSnapshot(),
        tokens: tokensSnapshot(),
        estimatedCostUsd: costSnapshot(),
        costKnown,
      };
    }

    // Refresh the running cost estimate from cumulative tokens and report usage.
    if (hasUsage) {
      costUsd = estimateCostUsd(opts.config.model, {
        prompt: tokens.prompt,
        completion: tokens.completion,
      }).usd;
    }
    sink.usage({
      round,
      tokens: { ...tokens },
      estimatedCostUsd: costUsd,
      costKnown,
      budgetUsd,
      budgetReached: budgetReached(),
    });

    const final = assistantToolCalls.length === 0;
    sink.assistantTurn(assistantText, round, { final });

    if (final) {
      // Final answer
      finalText = assistantText;
      const assistantMsg: SessionMessage = { role: "assistant", content: assistantText };
      messages.push(assistantMsg);
      opts.onMessage(assistantMsg);
      return {
        text: finalText,
        ok: true,
        reason: "completed",
        rounds: round + 1,
        retries,
        stats: statsSnapshot(),
        tokens: tokensSnapshot(),
        estimatedCostUsd: costSnapshot(),
        costKnown,
      };
    }

    // Record assistant message with tool calls
    const assistantMsg: SessionMessage = {
      role: "assistant",
      content: assistantText || null,
      tool_calls: assistantToolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);
    opts.onMessage(assistantMsg);

    // Execute each tool call
    for (const tc of assistantToolCalls) {
      sink.toolStart({ id: tc.id, name: tc.name, round });
      const result = await executeToolCall(
        tc,
        toolMap,
        opts.approvalMode,
        opts.workspace,
        opts.mutatingAllowed ?? true,
      );
      sink.toolResult({ id: tc.id, name: tc.name, result, round });
      bump(toolCalls, tc.name);
      if (result.isError) bump(toolFailures, tc.name);

      const toolMsg: SessionMessage = {
        role: "tool",
        content: result.content,
        tool_call_id: tc.id,
      };
      messages.push(toolMsg);
      opts.onMessage(toolMsg);
    }
  }

  return {
    text: finalText,
    ok: false,
    reason: "max_rounds",
    rounds: MAX_ROUNDS,
    retries,
    stats: statsSnapshot(),
    tokens: tokensSnapshot(),
    estimatedCostUsd: costSnapshot(),
    costKnown,
  };
}

// Resolve a single tool call to its result, applying approval gating and
// uniform error handling. Approval is sought only when required; a denial or an
// unknown tool yields an error result rather than throwing.
async function executeToolCall(
  tc: { id: string; name: string; arguments: string },
  toolMap: Map<string, ToolDef>,
  approvalMode: ApprovalMode,
  workspace: Workspace,
  mutatingAllowed: boolean,
): Promise<ToolResult> {
  const tool = toolMap.get(tc.name);
  if (!tool) {
    return { content: `Error: unknown tool "${tc.name}"`, isError: true };
  }

  // Folder-trust enforcement runs first and regardless of approval mode, so an
  // untrusted workspace fails closed for every mutating tool — yolo cannot widen
  // the boundary. Read-only tools (list/glob/grep/read) are always permitted.
  if (!mutatingAllowed && tool.category !== "read") {
    return { content: folderTrustDenialMessage(), isError: true };
  }

  // Deterministic command policy runs before approval and regardless of mode,
  // so a known-dangerous shape is denied even under yolo. Commands that pass
  // keep the existing approval/yolo behaviour unchanged.
  if (tool.category === "mutate-shell") {
    let command = "";
    try {
      const parsed = JSON.parse(tc.arguments);
      if (typeof parsed.command === "string") command = parsed.command;
    } catch { /* ignore */ }
    const decision = evaluateCommandPolicy(command, {
      provenance: "repository",
      workspace: workspace.root,
    });
    if (!decision.allowed) {
      return { content: policyDenialMessage(decision), isError: true };
    }
  }

  if (needsApproval(approvalMode, tool.category)) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(tc.arguments);
    } catch { /* ignore */ }
    const approved = await promptApproval(tc.name, parsed);
    if (!approved) {
      return { content: "Tool execution denied by user", isError: true };
    }
  }

  try {
    const parsed = JSON.parse(tc.arguments);
    return await tool.execute(parsed, workspace);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Tool error: ${msg}`, isError: true };
  }
}
