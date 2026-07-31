import { describe, it, expect } from "vitest";
import {
  CONTEXT_REFERENCE_SCHEMA,
  CONTEXT_REFERENCE_VERSION,
  validateContextReference,
  createContextReference,
  serializeReference,
  parseSerializedReference,
  referenceToJson,
  referenceFromJson,
  formatContextReference,
  referencesEqual,
  dedupeContextReferences,
} from "../../src/context-reference.js";
import type { ContextReference } from "../../src/context-reference.js";

// Pure-function coverage for the canonical context reference format (Issue
// #332): validation, construction, serialization round-trips, JSON
// round-trips, display formatting, equality, and deduplication.

describe("validateContextReference", () => {
  const valid: ContextReference = {
    schema: CONTEXT_REFERENCE_SCHEMA,
    v: CONTEXT_REFERENCE_VERSION,
    path: "src/index.ts",
    provenance: "tree",
  };

  it("accepts a minimal valid reference", () => {
    expect(validateContextReference(valid)).toEqual({ valid: true });
  });

  it("accepts a reference with lines and symbol", () => {
    const ref = { ...valid, lines: { start: 10, end: 25 }, symbol: "main" };
    expect(validateContextReference(ref)).toEqual({ valid: true });
  });

  it("rejects non-objects", () => {
    expect(validateContextReference(null).valid).toBe(false);
    expect(validateContextReference("str").valid).toBe(false);
    expect(validateContextReference(42).valid).toBe(false);
  });

  it("rejects wrong schema", () => {
    const ref = { ...valid, schema: "wrong" };
    const result = validateContextReference(ref);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("schema");
  });

  it("rejects wrong version", () => {
    const ref = { ...valid, v: 99 };
    const result = validateContextReference(ref);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("version");
  });

  it("rejects empty path", () => {
    const ref = { ...valid, path: "" };
    expect(validateContextReference(ref).valid).toBe(false);
  });

  it("rejects absolute path", () => {
    const ref = { ...valid, path: "/etc/passwd" };
    const result = validateContextReference(ref);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("relative");
  });

  it("rejects path with ..", () => {
    const ref = { ...valid, path: "../escape.ts" };
    const result = validateContextReference(ref);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("..");
  });

  it("rejects path with backslashes", () => {
    const ref = { ...valid, path: "src\\index.ts" };
    const result = validateContextReference(ref);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("/");
  });

  it("rejects path with NUL", () => {
    const ref = { ...valid, path: "src/\0evil.ts" };
    expect(validateContextReference(ref).valid).toBe(false);
  });

  it("rejects invalid line ranges", () => {
    expect(validateContextReference({ ...valid, lines: { start: 0, end: 5 } }).valid).toBe(false);
    expect(validateContextReference({ ...valid, lines: { start: 10, end: 5 } }).valid).toBe(false);
    expect(validateContextReference({ ...valid, lines: { start: 1.5, end: 5 } }).valid).toBe(false);
  });

  it("rejects unknown provenance", () => {
    const ref = { ...valid, provenance: "unknown" };
    const result = validateContextReference(ref);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("provenance");
  });

  it("accepts all valid provenance values", () => {
    for (const p of ["tree", "recent", "search", "manual", "picker"] as const) {
      expect(validateContextReference({ ...valid, provenance: p })).toEqual({ valid: true });
    }
  });
});

describe("createContextReference", () => {
  it("creates a minimal reference", () => {
    const ref = createContextReference("src/app.ts", "manual");
    expect(ref.path).toBe("src/app.ts");
    expect(ref.provenance).toBe("manual");
    expect(ref.lines).toBeUndefined();
    expect(ref.symbol).toBeUndefined();
  });

  it("creates a reference with lines and symbol", () => {
    const ref = createContextReference("src/app.ts", "search", { start: 5, end: 10 }, "handler");
    expect(ref.lines).toEqual({ start: 5, end: 10 });
    expect(ref.symbol).toBe("handler");
  });

  it("throws on invalid path", () => {
    expect(() => createContextReference("/abs/path.ts", "manual")).toThrow();
    expect(() => createContextReference("../escape.ts", "manual")).toThrow();
  });
});

describe("serializeReference / parseSerializedReference", () => {
  const cases: Array<{ ref: ContextReference; wire: string }> = [
    {
      ref: createContextReference("src/index.ts", "manual"),
      wire: "src/index.ts",
    },
    {
      ref: createContextReference("src/index.ts", "manual", { start: 10, end: 10 }),
      wire: "src/index.ts:10",
    },
    {
      ref: createContextReference("src/index.ts", "manual", { start: 10, end: 25 }),
      wire: "src/index.ts:10-25",
    },
    {
      ref: createContextReference("src/index.ts", "manual", { start: 10, end: 25 }, "main"),
      wire: "src/index.ts:10-25#main",
    },
    {
      ref: createContextReference("src/index.ts", "manual", undefined, "main"),
      wire: "src/index.ts#main",
    },
  ];

  it("serializes to the expected wire format", () => {
    for (const { ref, wire } of cases) {
      expect(serializeReference(ref)).toBe(wire);
    }
  });

  it("round-trips through parse", () => {
    for (const { ref, wire } of cases) {
      const parsed = parseSerializedReference(wire, ref.provenance);
      expect(parsed).not.toBeNull();
      expect(parsed!.path).toBe(ref.path);
      expect(parsed!.lines).toEqual(ref.lines);
      expect(parsed!.symbol).toBe(ref.symbol);
    }
  });

  it("returns null for empty input", () => {
    expect(parseSerializedReference("")).toBeNull();
  });

  it("returns null for malformed line ranges", () => {
    expect(parseSerializedReference("file.ts:abc")).toBeNull();
    expect(parseSerializedReference("file.ts:10-5")).toBeNull();
    expect(parseSerializedReference("file.ts:0")).toBeNull();
  });

  it("defaults provenance to manual", () => {
    const parsed = parseSerializedReference("src/a.ts");
    expect(parsed!.provenance).toBe("manual");
  });

  it("handles paths with colons in directory names", () => {
    // The colon after the last slash is the line separator; colons in
    // directory names (before the last slash) are part of the path.
    const parsed = parseSerializedReference("src/a:b/file.ts:5");
    expect(parsed).not.toBeNull();
    expect(parsed!.path).toBe("src/a:b/file.ts");
    expect(parsed!.lines).toEqual({ start: 5, end: 5 });
  });
});

describe("referenceToJson / referenceFromJson", () => {
  it("round-trips a full reference through JSON", () => {
    const ref = createContextReference("lib/mod.rs", "picker", { start: 1, end: 42 }, "init");
    const json = referenceToJson(ref);
    const parsed = referenceFromJson(json);
    expect(parsed).toEqual(ref);
  });

  it("returns null for invalid JSON", () => {
    expect(referenceFromJson("not json")).toBeNull();
  });

  it("returns null for structurally invalid JSON", () => {
    expect(referenceFromJson('{"path":"a.ts"}')).toBeNull();
  });
});

describe("formatContextReference", () => {
  it("formats a file-only reference", () => {
    const ref = createContextReference("src/main.ts", "tree");
    expect(formatContextReference(ref)).toBe("▸ src/main.ts [tree]");
  });

  it("formats a reference with lines and symbol", () => {
    const ref = createContextReference("src/main.ts", "search", { start: 5, end: 15 }, "run");
    expect(formatContextReference(ref)).toBe("▸ src/main.ts:5-15 (run) [search]");
  });

  it("formats a single-line reference without a range dash", () => {
    const ref = createContextReference("a.ts", "manual", { start: 7, end: 7 });
    expect(formatContextReference(ref)).toBe("▸ a.ts:7 [manual]");
  });
});

describe("referencesEqual", () => {
  it("considers same path/lines/symbol equal regardless of provenance", () => {
    const a = createContextReference("a.ts", "tree", { start: 1, end: 5 });
    const b = createContextReference("a.ts", "search", { start: 1, end: 5 });
    expect(referencesEqual(a, b)).toBe(true);
  });

  it("distinguishes different paths", () => {
    const a = createContextReference("a.ts", "tree");
    const b = createContextReference("b.ts", "tree");
    expect(referencesEqual(a, b)).toBe(false);
  });

  it("distinguishes different line ranges", () => {
    const a = createContextReference("a.ts", "tree", { start: 1, end: 5 });
    const b = createContextReference("a.ts", "tree", { start: 1, end: 10 });
    expect(referencesEqual(a, b)).toBe(false);
  });

  it("distinguishes different symbols", () => {
    const a = createContextReference("a.ts", "tree", undefined, "foo");
    const b = createContextReference("a.ts", "tree", undefined, "bar");
    expect(referencesEqual(a, b)).toBe(false);
  });
});

describe("dedupeContextReferences", () => {
  it("removes duplicates preserving first occurrence", () => {
    const a = createContextReference("a.ts", "tree", { start: 1, end: 1 });
    const b = createContextReference("a.ts", "search", { start: 1, end: 1 });
    const c = createContextReference("b.ts", "tree");
    const result = dedupeContextReferences([a, b, c]);
    expect(result).toHaveLength(2);
    expect(result[0].provenance).toBe("tree");
    expect(result[1].path).toBe("b.ts");
  });

  it("keeps references with different lines", () => {
    const a = createContextReference("a.ts", "tree", { start: 1, end: 1 });
    const b = createContextReference("a.ts", "tree", { start: 2, end: 2 });
    expect(dedupeContextReferences([a, b])).toHaveLength(2);
  });
});
