import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildEvidenceBundle,
  serializeEvidenceBundle,
  parseEvidenceBundle,
  readEvidenceBundle,
  writeEvidenceBundle,
  readCommandOutcomes,
  verifyEvidenceBundle,
  formatEvidenceExport,
  formatEvidenceVerification,
  EvidenceArchiveError,
  EVIDENCE_ARCHIVE_SCHEMA,
  EVIDENCE_ARCHIVE_VERSION,
} from "../../src/evidence-archive.js";
import type { EvidenceBundle, EvidenceInput } from "../../src/evidence-archive.js";
import { buildRunSummary } from "../../src/run-summary.js";
import { hashEvidence } from "../../src/run-recovery.js";
import type { RecoveryCheckpoint } from "../../src/run-recovery.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ea-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

function summary(over: Partial<Parameters<typeof buildRunSummary>[0]> = {}) {
  return buildRunSummary({
    ok: true,
    exitCode: 0,
    reason: "completed",
    elapsedMs: 1234,
    rounds: 3,
    toolCalls: { read_file: 2, edit: 1 },
    toolFailures: {},
    tokens: { prompt: 100, completion: 50, total: 150 },
    sessionId: "sess-1",
    sessionPath: null,
    ...over,
  });
}

function checkpoint(over: Partial<RecoveryCheckpoint> = {}): RecoveryCheckpoint {
  return {
    schema: "oh-my-cli.recovery",
    v: 1,
    taskIdentity: "task-A",
    repoHead: "abc123",
    steps: [
      { id: "build", digest: hashEvidence("artifact-1") },
      { id: "test", digest: hashEvidence("artifact-2") },
    ],
    ...over,
  };
}

function fullInput(over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    source: { task: "task-A" },
    summary: summary(),
    checkpoint: checkpoint(),
    outcomes: [
      { command: "npm run build", exitCode: 0, ok: true },
      { command: "npm test", exitCode: 1, ok: false },
    ],
    contentDigests: { "write:src/foo.ts": hashEvidence("content-1") },
    ...over,
  };
}

describe("buildEvidenceBundle", () => {
  it("creates one entry per present kind, sorted by name", () => {
    const bundle = buildEvidenceBundle(fullInput());
    expect(bundle.schema).toBe(EVIDENCE_ARCHIVE_SCHEMA);
    expect(bundle.v).toBe(EVIDENCE_ARCHIVE_VERSION);
    expect(bundle.entries.map((e) => e.name)).toEqual([
      "checkpoint",
      "command-outcomes",
      "content-digests",
      "run-summary",
    ]);
    expect(bundle.entries.map((e) => e.kind)).toEqual([
      "checkpoint-metadata",
      "command-outcomes",
      "content-digests",
      "run-summary",
    ]);
    expect(bundle.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("only includes entries for the kinds supplied", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    expect(bundle.entries.map((e) => e.name)).toEqual(["run-summary"]);
    expect(bundle.source.outcome).toBe("success");
  });

  it("derives source from artifacts when not given explicitly", () => {
    const bundle = buildEvidenceBundle({
      summary: summary({ ok: false, exitCode: 1 }),
      checkpoint: checkpoint({ taskIdentity: "task-Z", repoHead: "deadbeef" }),
    });
    expect(bundle.source.task).toBe("task-Z");
    expect(bundle.source.repoHead).toBe("deadbeef");
    expect(bundle.source.outcome).toBe("failure");
  });
});

describe("determinism", () => {
  it("produces byte-identical serialization for identical input", () => {
    const a = serializeEvidenceBundle(buildEvidenceBundle(fullInput()));
    const b = serializeEvidenceBundle(buildEvidenceBundle(fullInput()));
    expect(a).toBe(b);
  });

  it("is independent of the insertion order of input kinds", () => {
    const a = serializeEvidenceBundle(
      buildEvidenceBundle({ summary: summary(), checkpoint: checkpoint() }),
    );
    const b = serializeEvidenceBundle(
      buildEvidenceBundle({ checkpoint: checkpoint(), summary: summary() }),
    );
    expect(a).toBe(b);
  });

  it("serializes with sorted keys and a trailing newline", () => {
    const text = serializeEvidenceBundle(buildEvidenceBundle(fullInput()));
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});

describe("round-trip and verification", () => {
  it("verifies a freshly built bundle as valid", () => {
    const bundle = buildEvidenceBundle(fullInput());
    const result = verifyEvidenceBundle(bundle);
    expect(result.ok).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("survives serialize -> parse -> verify", () => {
    const text = serializeEvidenceBundle(buildEvidenceBundle(fullInput()));
    const parsed = parseEvidenceBundle(JSON.parse(text));
    const result = verifyEvidenceBundle(parsed);
    expect(result.ok).toBe(true);
  });

  it("survives write -> read -> verify", () => {
    const dir = tmp();
    const file = path.join(dir, "bundle.json");
    writeEvidenceBundle(file, buildEvidenceBundle(fullInput()));
    const result = verifyEvidenceBundle(readEvidenceBundle(file));
    expect(result.ok).toBe(true);
  });
});

describe("tamper detection", () => {
  it("fails when an entry's content is modified", () => {
    const bundle = buildEvidenceBundle(fullInput());
    bundle.entries[0].content = bundle.entries[0].content.replace(/"abc123"/, '"deadbeef"') + " ";
    const result = verifyEvidenceBundle(bundle);
    expect(result.ok).toBe(false);
    expect(result.entries.some((e) => !e.ok && e.reason?.includes("digest"))).toBe(true);
  });

  it("fails the manifest signature when an entry is added", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    bundle.entries.push({
      name: "injected",
      kind: "content-digests",
      digest: hashEvidence("x"),
      content: "{}",
    });
    const result = verifyEvidenceBundle(bundle);
    expect(result.signatureValid).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("fails the manifest signature when an entry is removed", () => {
    const bundle = buildEvidenceBundle(fullInput());
    bundle.entries.pop();
    const result = verifyEvidenceBundle(bundle);
    expect(result.signatureValid).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("fails the manifest signature when entries are reordered", () => {
    const bundle = buildEvidenceBundle(fullInput());
    bundle.entries.reverse();
    const result = verifyEvidenceBundle(bundle);
    expect(result.signatureValid).toBe(false);
  });

  it("flags a duplicate entry name", () => {
    const bundle = buildEvidenceBundle(fullInput());
    const dup = { ...bundle.entries[0] };
    bundle.entries.push(dup);
    // re-sign so the only remaining problem is the duplicate name
    const result = verifyEvidenceBundle(bundle);
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("detects content tampering in a bundle file even when the signature is intact", () => {
    const dir = tmp();
    const file = path.join(dir, "bundle.json");
    writeEvidenceBundle(file, buildEvidenceBundle(fullInput()));
    // An attacker edits one entry's content but cannot recompute its digest.
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    obj.entries[0].content = obj.entries[0].content + " ";
    fs.writeFileSync(file, JSON.stringify(obj), "utf8");
    const result = verifyEvidenceBundle(readEvidenceBundle(file));
    // The manifest signature still matches (digests unchanged), but the entry's
    // recomputed content digest no longer matches — verification fails closed.
    expect(result.signatureValid).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.entries.some((e) => !e.ok && e.reason?.includes("digest"))).toBe(true);
  });
});

describe("redaction", () => {
  it("never leaks a secret or absolute home path into the bundle", () => {
    const home = os.homedir();
    const bundle = buildEvidenceBundle({
      source: { task: `deploy ${SECRET}` },
      summary: summary({ sessionPath: path.join(home, ".qwen", "sessions", "abc.jsonl") }),
      checkpoint: checkpoint({
        taskIdentity: `task ${SECRET}`,
        steps: [{ id: `run ${SECRET}`, digest: hashEvidence("a") }],
      }),
      outcomes: [{ command: `curl -H "Authorization: Bearer ${SECRET}"`, exitCode: 0, ok: true }],
      contentDigests: { [`key ${SECRET}`]: hashEvidence("c") },
    });
    const text = serializeEvidenceBundle(bundle);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(home);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("~");
  });
});

describe("parse / compatibility / malformed", () => {
  it("rejects a non-object", () => {
    expect(() => parseEvidenceBundle(null)).toThrow(EvidenceArchiveError);
    expect(() => parseEvidenceBundle("nope")).toThrow(EvidenceArchiveError);
  });

  it("rejects an unknown schema", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    const bad = { ...JSON.parse(serializeEvidenceBundle(bundle)), schema: "other.schema" };
    expect(() => parseEvidenceBundle(bad)).toThrow(/schema/);
  });

  it("rejects an incompatible version", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    const bad = { ...JSON.parse(serializeEvidenceBundle(bundle)), v: 999 };
    expect(() => parseEvidenceBundle(bad)).toThrow(/version/);
  });

  it("rejects a missing signature", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    const bad = JSON.parse(serializeEvidenceBundle(bundle));
    delete bad.signature;
    expect(() => parseEvidenceBundle(bad)).toThrow(/signature/);
  });

  it("rejects a malformed entry", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    const bad = JSON.parse(serializeEvidenceBundle(bundle));
    bad.entries[0] = { name: "x" };
    expect(() => parseEvidenceBundle(bad)).toThrow(/malformed entry/);
  });

  it("rejects an unknown entry kind", () => {
    const bundle = buildEvidenceBundle({ summary: summary() });
    const bad = JSON.parse(serializeEvidenceBundle(bundle));
    bad.entries[0].kind = "bogus";
    expect(() => parseEvidenceBundle(bad)).toThrow(/unknown entry kind/);
  });

  it("readEvidenceBundle reports a missing file clearly", () => {
    expect(() => readEvidenceBundle(path.join(tmp(), "nope.json"))).toThrow(/file not found/);
  });

  it("readEvidenceBundle rejects invalid JSON", () => {
    const dir = tmp();
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{not json", "utf8");
    expect(() => readEvidenceBundle(file)).toThrow(/not valid JSON/);
  });
});

describe("readCommandOutcomes", () => {
  it("reads a valid outcomes array", () => {
    const dir = tmp();
    const file = path.join(dir, "outcomes.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ command: "npm test", exitCode: 0, ok: true }]),
      "utf8",
    );
    expect(readCommandOutcomes(file)).toEqual([{ command: "npm test", exitCode: 0, ok: true }]);
  });

  it("rejects a non-array", () => {
    const dir = tmp();
    const file = path.join(dir, "outcomes.json");
    fs.writeFileSync(file, "{}", "utf8");
    expect(() => readCommandOutcomes(file)).toThrow(/JSON array/);
  });

  it("rejects a malformed entry", () => {
    const dir = tmp();
    const file = path.join(dir, "outcomes.json");
    fs.writeFileSync(file, JSON.stringify([{ command: "x" }]), "utf8");
    expect(() => readCommandOutcomes(file)).toThrow(/string command, number exitCode, boolean ok/);
  });

  it("reports a missing file clearly", () => {
    expect(() => readCommandOutcomes(path.join(tmp(), "nope.json"))).toThrow(/file not found/);
  });
});

describe("formatting", () => {
  it("renders a human export summary", () => {
    const out = formatEvidenceExport(buildEvidenceBundle(fullInput()));
    expect(out).toContain("Evidence archive");
    expect(out).toContain("run-summary");
    expect(out).toContain("signature:");
  });

  it("renders a valid verification result", () => {
    const result = verifyEvidenceBundle(buildEvidenceBundle(fullInput()));
    const out = formatEvidenceVerification(result);
    expect(out).toContain("result:    valid");
    expect(out).toContain("signature: ok");
  });

  it("renders an invalid verification result with errors", () => {
    const bundle = buildEvidenceBundle(fullInput());
    bundle.entries.pop();
    const out = formatEvidenceVerification(verifyEvidenceBundle(bundle));
    expect(out).toContain("result:    invalid");
    expect(out).toContain("MISMATCH");
  });
});
