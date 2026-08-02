// Model metadata display: shows detailed metadata for the active model
// including name, provider, context window, capabilities, and cost estimate.
//
// Read-only display derived from model profile configuration. Capabilities
// are shown as present/absent indicators. Cost is shown as estimated
// per-million-token rates. Deterministic and surface-independent.
//
// Source: community observation of aider v0.85.0 `/settings` model metadata.

export const MODEL_METADATA_SCHEMA = "oh-my-cli.model-metadata";
export const MODEL_METADATA_VERSION = 1;

// --- types ------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
}

export interface ModelCost {
  /** Cost per million input tokens (USD). */
  inputPerMillion: number;
  /** Cost per million output tokens (USD). */
  outputPerMillion: number;
}

export interface ModelMetadata {
  schema: typeof MODEL_METADATA_SCHEMA;
  v: typeof MODEL_METADATA_VERSION;
  /** Model identifier (e.g., "qwen3-max"). */
  modelId: string;
  /** Display name. */
  displayName: string;
  /** Provider name (e.g., "DashScope"). */
  provider: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Supported capabilities. */
  capabilities: ModelCapabilities;
  /** Cost estimate. */
  cost: ModelCost;
  /** Whether the model is the currently active model. */
  isActive: boolean;
}

// --- formatting -------------------------------------------------------------

// Format a capability as a present/absent indicator.
function capIndicator(present: boolean): string {
  return present ? "✓" : "✗";
}

// Format cost as a readable string.
function formatCost(cost: ModelCost): string {
  return `$${cost.inputPerMillion.toFixed(2)}/$${cost.outputPerMillion.toFixed(2)} per 1M tokens (in/out)`;
}

// Format context window as a readable string.
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K tokens`;
  return `${tokens} tokens`;
}

// Format model metadata as a compact display.
export function formatModelInfo(metadata: ModelMetadata): string {
  const lines: string[] = [];
  const active = metadata.isActive ? " (active)" : "";

  lines.push(`Model: ${metadata.displayName}${active}`);
  lines.push("─".repeat(40));
  lines.push(`  ID:       ${metadata.modelId}`);
  lines.push(`  Provider: ${metadata.provider}`);
  lines.push(`  Context:  ${formatContextWindow(metadata.contextWindow)}`);
  lines.push(`  Cost:     ${formatCost(metadata.cost)}`);
  lines.push("");
  lines.push("  Capabilities:");
  lines.push(`    Tools:            ${capIndicator(metadata.capabilities.tools)}`);
  lines.push(`    Vision:           ${capIndicator(metadata.capabilities.vision)}`);
  lines.push(`    Streaming:        ${capIndicator(metadata.capabilities.streaming)}`);
  lines.push(`    Structured output: ${capIndicator(metadata.capabilities.structuredOutput)}`);
  lines.push(`    Reasoning:        ${capIndicator(metadata.capabilities.reasoning)}`);

  return lines.join("\n");
}

// Format multiple models as a comparison table.
export function formatModelComparison(models: ModelMetadata[]): string {
  const lines: string[] = [];
  lines.push("Model Comparison");
  lines.push("═".repeat(60));

  for (const model of models) {
    const active = model.isActive ? " ●" : "";
    lines.push(`${model.displayName}${active} [${model.provider}]`);
    lines.push(`  ${formatContextWindow(model.contextWindow)} | ${formatCost(model.cost)}`);
    const caps = [
      model.capabilities.tools ? "tools" : null,
      model.capabilities.vision ? "vision" : null,
      model.capabilities.streaming ? "stream" : null,
      model.capabilities.structuredOutput ? "struct" : null,
      model.capabilities.reasoning ? "reason" : null,
    ].filter(Boolean).join(", ");
    lines.push(`  Caps: ${caps || "none"}`);
    lines.push("");
  }

  return lines.join("\n");
}
