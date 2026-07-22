// A versioned, deterministic task fixture for reproducible unattended-run
// evaluation (roadmap #38). A fixture declares a bounded prompt and a
// deterministic script of provider responses (text or tool calls); replaying it
// drives one unattended run whose run-summary (#40) fields are reproducible — the
// same fixture yields the same tool-call sequence, rounds, and token totals, so
// before/after scorecards (#44) compare like-for-like inputs. Loading fails closed
// with a redacted error, and the fixture format rejects raw-credential fields.

import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import type { SessionMessage } from "./session.js";
import type { ProviderOptions, StreamEvent, StreamProvider } from "./provider.js";

export const TASK_FIXTURE_SCHEMA = "oh-my-cli.task-fixture";
export const TASK_FIXTURE_VERSION = 1;
export const SUPPORTED_TASK_FIXTURE_VERSIONS: readonly number[] = [1];

// Deterministic usage emitted per scripted response so token totals are
// reproducible across replays (mirrors the test fake provider's fixed usage).
const FIXTURE_USAGE = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };

// Raw secret field names that must never appear in a fixture; rejected (not
// ignored) so a plaintext secret cannot become a supported fixture path. Mirrors
// the other settings contracts.
const FORBIDDEN_FIXTURE_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

const FixtureToolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    arguments: z.string().max(65_536),
  })
  .strict();

const FixtureStepSchema = z
  .object({
    type: z.enum(["text", "tool_calls"]),
    content: z.string().max(65_536).optional(),
    toolCalls: z.array(FixtureToolCallSchema).max(64).optional(),
  })
  .strict();

const TaskFixtureBodySchema = z
  .object({
    schema: z.literal(TASK_FIXTURE_SCHEMA).optional(),
    version: z.number().int(),
    prompt: z.string().min(1).max(8_192),
    script: z.array(FixtureStepSchema).min(1).max(256),
  })
  .strict();

export interface TaskFixtureToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface TaskFixtureStep {
  type: "text" | "tool_calls";
  content?: string;
  toolCalls?: TaskFixtureToolCall[];
}

export interface TaskFixture {
  version: number;
  prompt: string;
  script: TaskFixtureStep[];
}

function assertNoForbiddenKeys(obj: Record<string, unknown>, where: string): void {
  for (const key of FORBIDDEN_FIXTURE_KEYS) {
    if (key in obj) {
      throw new Error(
        `Task fixture error: ${where} contains raw credential field "${key}"; ` +
          "reference secrets via the environment, not the fixture",
      );
    }
  }
}

// Parse and validate a task fixture, failing closed on a malformed fixture, an
// unsupported version, a step whose payload does not match its type, or a raw
// credential field.
export function parseTaskFixture(raw: unknown): TaskFixture {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Task fixture error: fixture must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  assertNoForbiddenKeys(obj, "fixture");
  if (!("version" in obj)) {
    throw new Error("Task fixture error: version is required");
  }
  // Reject credential fields in each raw step before schema validation so the
  // error names the offending step rather than a generic "unrecognized key".
  if (Array.isArray(obj.script)) {
    obj.script.forEach((step, i) => {
      if (step && typeof step === "object" && !Array.isArray(step)) {
        assertNoForbiddenKeys(step as Record<string, unknown>, `script[${i}]`);
      }
    });
  }
  const parsed = TaskFixtureBodySchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Task fixture error: ${issues}`);
  }
  const body = parsed.data;
  if (!SUPPORTED_TASK_FIXTURE_VERSIONS.includes(body.version)) {
    throw new Error(
      `Task fixture error: task fixture version ${body.version} is not supported; ` +
        `supported: ${SUPPORTED_TASK_FIXTURE_VERSIONS.join(", ")}`,
    );
  }
  const script: TaskFixtureStep[] = [];
  body.script.forEach((step, i) => {
    if (step.type === "text") {
      if (typeof step.content !== "string") {
        throw new Error(`Task fixture error: script[${i}] text step requires "content"`);
      }
      script.push({ type: "text", content: step.content });
    } else {
      if (!Array.isArray(step.toolCalls) || step.toolCalls.length === 0) {
        throw new Error(`Task fixture error: script[${i}] tool_calls step requires non-empty "toolCalls"`);
      }
      script.push({
        type: "tool_calls",
        toolCalls: step.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      });
    }
  });
  return { version: body.version, prompt: body.prompt, script };
}

// Read and parse a task fixture file, failing closed on a missing/unreadable file
// or invalid JSON.
export function readTaskFixtureFile(path: string): TaskFixture {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Task fixture error: cannot read fixture file: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Task fixture error: fixture file contains invalid JSON");
  }
  return parseTaskFixture(parsed);
}

// A deterministic stream provider that replays the fixture's scripted responses,
// one per agent round, so the same fixture always yields the same tool-call
// sequence, rounds, and token totals. When the script is exhausted it yields a
// final empty-text response so the run terminates instead of looping.
export function fixtureStreamProvider(fixture: TaskFixture): StreamProvider {
  let callIndex = 0;
  return async function* fixtureStream(
    _config: Config,
    _messages: SessionMessage[],
    _options?: ProviderOptions,
  ): AsyncGenerator<StreamEvent> {
    const step: TaskFixtureStep =
      callIndex < fixture.script.length ? fixture.script[callIndex] : { type: "text", content: "" };
    callIndex++;
    if (step.type === "text") {
      yield { type: "text", delta: step.content ?? "" };
    } else {
      for (const tc of step.toolCalls ?? []) {
        yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
      }
    }
    yield { type: "usage", ...FIXTURE_USAGE };
  };
}
