// Workflow contract: declare one or more reusable, named workflows as a versioned
// section of the unified user settings file (settings.ts), then negotiate the
// contract version, select a workflow by name, and resolve its ordered steps —
// all without changing core code. A workflow is a named, ordered list of steps
// and each step is a bounded non-interactive prompt that the runner feeds through
// the existing headless `-p` execution path (workflow-runner.ts).
//
// Trust boundary: workflow definitions are untrusted input read ONLY from the
// user-owned settings scope (resolveSettingsPath never resolves a project-local
// path), so an untrusted repository cannot define or run a workflow. Raw
// credential fields inside a workflow or a step are rejected rather than ignored,
// matching the model/provider contracts: a credential is supplied by an
// environment-variable name at the model layer, never inline in a workflow. An
// unsupported contract version, an unknown/misspelled key, or a malformed step
// fails closed before any side effect, consistent with the effective-settings
// registry (effective-settings.ts).

import fs from "node:fs";
import { z } from "zod";
import { resolveSettingsPath } from "./settings.js";
import { redactHomePath } from "./permission-impact.js";

export const WORKFLOW_CONTRACT_SCHEMA = "oh-my-cli.workflow-contract";
export const WORKFLOW_CONTRACT_VERSION = 1;

// The contract versions this build can negotiate. A settings file declaring a
// version outside this range is refused (fail closed) rather than coerced, so a
// future format change cannot silently reinterpret an older or newer definition.
export const SUPPORTED_WORKFLOW_CONTRACT_VERSIONS: readonly number[] = [1];

// Raw secret field names that must never appear in a workflow or step. The parser
// rejects (rather than ignores) them so a plaintext secret cannot become a
// supported configuration path. Mirrors the model/provider contracts.
const FORBIDDEN_WORKFLOW_KEYS = [
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "credential",
];

// A workflow name is a portable, shell-safe identifier: it is used as a CLI
// argument (`--run-workflow <name>`) and as a settings map key, so it cannot
// carry whitespace, path separators, or leading punctuation.
export const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_NAME = 128;
const MAX_DESCRIPTION = 500;
const MAX_PROMPT = 100_000;

// One declared workflow step: a single bounded, non-interactive prompt. Anything
// richer (artifacts, conditionals, retries) is an explicit non-goal of this slice.
export interface WorkflowStep {
  prompt: string;
}

// One declared workflow: an ordered, non-empty list of steps plus optional
// human-readable metadata.
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

// The validated `workflows` section: a negotiated contract version and the
// validated definitions (names guaranteed unique by construction as map keys).
export interface WorkflowContract {
  contractVersion: number;
  definitions: WorkflowDefinition[];
}

const StepSchema = z
  .object({
    prompt: z
      .string()
      .min(1, "step.prompt must be a non-empty string")
      .max(MAX_PROMPT, "step.prompt is too long"),
  })
  .strict();

const DefinitionSchema = z
  .object({
    description: z.string().max(MAX_DESCRIPTION, "workflow description is too long").optional(),
    steps: z.array(StepSchema).min(1, "workflow steps must be a non-empty array"),
  })
  .strict();

function assertNoForbiddenKeys(obj: Record<string, unknown>, label: string): void {
  for (const forbidden of FORBIDDEN_WORKFLOW_KEYS) {
    if (forbidden in obj) {
      throw new Error(
        `Settings error: ${label} field "${forbidden}" is a raw credential field; ` +
          "reference credentials via the environment-variable model, never inline in a workflow",
      );
    }
  }
}

interface WorkflowsSection {
  found: boolean;
  section?: unknown;
}

// Read and return only the optional `workflows` section of the user settings
// file. Throws a redacted, actionable error on invalid JSON or a non-object root
// — before any workflow request. A missing file or absent `workflows` section is
// not an error here; the caller decides how to treat that.
function readWorkflowsSection(settingsPath: string): WorkflowsSection {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return { found: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Settings error: ${redactHomePath(settingsPath)} contains invalid JSON`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings error: ${redactHomePath(settingsPath)} must contain a JSON object`);
  }

  const root = parsed as Record<string, unknown>;
  const workflows = root.workflows;
  if (workflows === undefined) {
    return { found: true };
  }
  return { found: true, section: workflows };
}

// Validate an untrusted `workflows` section into a WorkflowContract. Negotiates
// the contract version (fail closed on an unsupported version), rejects unknown
// envelope keys, raw credential fields per workflow and per step, malformed
// steps, and invalid names. Every failure raises a redacted, deterministic error.
export function parseWorkflowContract(section: unknown): WorkflowContract {
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Settings error: settings.workflows must be an object");
  }
  const obj = section as Record<string, unknown>;

  // Envelope: only contractVersion + definitions are allowed. An unknown key is a
  // typo (e.g. "version", "defs") and is rejected rather than silently ignored.
  for (const key of Object.keys(obj)) {
    if (key !== "contractVersion" && key !== "definitions") {
      throw new Error(`Settings error: settings.workflows has unknown key "${key}"`);
    }
  }

  // Version negotiation: a required integer within the supported range.
  const version = obj.contractVersion;
  if (version === undefined) {
    throw new Error("Settings error: settings.workflows.contractVersion is required");
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Settings error: settings.workflows.contractVersion must be an integer");
  }
  if (!SUPPORTED_WORKFLOW_CONTRACT_VERSIONS.includes(version)) {
    throw new Error(
      `Settings error: workflow contract version ${version} is not supported; ` +
        `supported versions: ${SUPPORTED_WORKFLOW_CONTRACT_VERSIONS.join(", ")}`,
    );
  }

  const rawDefs = obj.definitions;
  if (rawDefs === null || typeof rawDefs !== "object" || Array.isArray(rawDefs)) {
    throw new Error("Settings error: settings.workflows.definitions must be an object");
  }
  const defEntries = Object.entries(rawDefs as Record<string, unknown>);
  if (defEntries.length === 0) {
    throw new Error("Settings error: settings.workflows.definitions must define at least one workflow");
  }

  const definitions: WorkflowDefinition[] = [];
  for (const [name, raw] of defEntries) {
    if (name.length > MAX_NAME || !WORKFLOW_NAME_RE.test(name)) {
      throw new Error(
        `Settings error: workflow name "${name}" must match ${WORKFLOW_NAME_RE.source} ` +
          "(a portable, shell-safe identifier)",
      );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Settings error: workflow "${name}" must be an object`);
    }
    const defObj = raw as Record<string, unknown>;
    assertNoForbiddenKeys(defObj, `workflow "${name}"`);

    // Reject raw credential fields in any step before structural validation so the
    // error names the credential rather than reporting a generic unknown key.
    const rawSteps = defObj.steps;
    if (Array.isArray(rawSteps)) {
      rawSteps.forEach((step, index) => {
        if (step !== null && typeof step === "object" && !Array.isArray(step)) {
          assertNoForbiddenKeys(step as Record<string, unknown>, `workflow "${name}" step ${index}`);
        }
      });
    }

    const result = DefinitionSchema.safeParse(defObj);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.message).join("; ");
      throw new Error(`Settings error: workflow "${name}": ${issues}`);
    }
    definitions.push({
      name,
      description: result.data.description,
      steps: result.data.steps.map((s) => ({ prompt: s.prompt })),
    });
  }

  return { contractVersion: version, definitions };
}

// Resolve a workflow by name. The name is required (workflows run by explicit
// selection); an unknown name fails closed with an actionable reason.
export function selectWorkflowDefinition(
  contract: WorkflowContract,
  name: string,
): WorkflowDefinition {
  const wanted = name.trim();
  if (wanted === "") {
    throw new Error("Workflow error: workflow name must be a non-empty string");
  }
  const found = contract.definitions.find((d) => d.name === wanted);
  if (!found) {
    throw new Error(
      `Workflow error: workflow "${wanted}" is not defined in settings.workflows.definitions`,
    );
  }
  return found;
}

// The readiness state of a declared workflow contract. A workflow has no external
// entrypoint to probe — its steps are bounded prompts fed through the headless
// `-p` path (workflow-runner.ts) — so a contract that negotiates and validates is
// immediately resolvable by the runner. Discovery never executes a workflow, so
// the only present readiness state is "ready"; a malformed contract fails closed
// in parseWorkflowContract rather than resolving to a not-ready state.
export type WorkflowReadinessState = "ready";

export interface WorkflowReadiness {
  state: WorkflowReadinessState;
  reason: string;
}

// Resolve the readiness of the declared workflow contract. Unlike the tool and MCP
// contracts (which probe a command), a workflow's readiness is fully decided by
// successful contract negotiation: every definition has at least one step and no
// external dependency to resolve. Never throws — the contract is already validated
// by parseWorkflowContract before this is called.
export function resolveWorkflowReadiness(contract: WorkflowContract): WorkflowReadiness {
  const count = contract.definitions.length;
  return {
    state: "ready",
    reason: `${count} workflow definition${count === 1 ? "" : "s"} resolvable`,
  };
}

export interface ResolvedWorkflow {
  contractVersion: number;
  definition: WorkflowDefinition;
  settingsPath: string;
  settingsFound: boolean;
}

// Read the user settings file, negotiate the workflow contract, and select one
// workflow by name. Throws a redacted error when no `workflows` section exists or
// the contract / selection is invalid. Reads only the user-owned scope.
export function resolveWorkflow(
  name: string,
  opts: { settingsPath?: string } = {},
): ResolvedWorkflow {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, section } = readWorkflowsSection(settingsPath);
  if (section === undefined) {
    throw new Error(
      found
        ? "Workflow error: settings file has no settings.workflows section"
        : `Workflow error: settings file not found at ${redactHomePath(settingsPath)}`,
    );
  }
  const contract = parseWorkflowContract(section);
  const definition = selectWorkflowDefinition(contract, name);
  return {
    contractVersion: contract.contractVersion,
    definition,
    settingsPath,
    settingsFound: found,
  };
}

// The redacted, serializable result of listing the declared workflows. No step
// prompt content, no secret, and no unredacted home path.
export interface WorkflowListEntry {
  name: string;
  description?: string;
  steps: number;
}

export interface WorkflowListReport {
  schema: string;
  version: number;
  contractVersion: number;
  workflows: WorkflowListEntry[];
  settings: string;
}

// Read the user settings file, negotiate the workflow contract, and build the
// redacted list report. Unlike resolution, listing never throws when no
// `workflows` section exists — it reports an empty inventory — but a
// present-but-malformed section still fails closed, mirroring collectProfileList.
export function collectWorkflowList(opts: { settingsPath?: string } = {}): WorkflowListReport {
  const settingsPath = resolveSettingsPath(opts.settingsPath);
  const { found, section } = readWorkflowsSection(settingsPath);
  const contract = section === undefined ? undefined : parseWorkflowContract(section);
  const workflows: WorkflowListEntry[] = (contract?.definitions ?? [])
    .map((d) => ({ name: d.name, description: d.description, steps: d.steps.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    schema: WORKFLOW_CONTRACT_SCHEMA,
    version: WORKFLOW_CONTRACT_VERSION,
    contractVersion: contract?.contractVersion ?? WORKFLOW_CONTRACT_VERSION,
    workflows,
    settings: found
      ? redactHomePath(settingsPath)
      : `${redactHomePath(settingsPath)} (not found)`,
  };
}

// A redacted, human-readable summary of the declared workflows.
export function formatWorkflowList(report: WorkflowListReport): string {
  const lines: string[] = [];
  lines.push("Workflows");
  lines.push("─".repeat(40));
  lines.push(
    `Contract:  ${report.schema} v${report.version} (settings contract version ${report.contractVersion})`,
  );
  lines.push(`Settings:  ${report.settings}`);
  if (report.workflows.length === 0) {
    lines.push("Workflows: (none)");
  } else {
    lines.push(`Workflows: ${report.workflows.length}`);
    for (const w of report.workflows) {
      const stepWord = w.steps === 1 ? "step" : "steps";
      lines.push(`  ${w.name} — ${w.steps} ${stepWord}${w.description ? `: ${w.description}` : ""}`);
    }
  }
  return lines.join("\n");
}
