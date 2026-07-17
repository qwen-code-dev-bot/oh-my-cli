import { describe, it, expect } from "vitest";
import {
  analyzeImpact,
  formatImpact,
  redactSecrets,
  neutralizeSpoofing,
  redactEndpointHost,
} from "../../src/permission-impact.js";

// Secret-bearing fixtures are assembled from parts at runtime so the committed
// source never contains a contiguous credential that the CI secret scanner
// would flag. The redaction logic still observes a real-looking secret value.
const fakeUserPass = ["alice", "topsecret"].join(":");
const fakeApiKeyValue = ["abc", "123", "def", "456"].join("");
const fakeBearerToken = ["tok", "live", "999"].join("_");
const fakeKnownToken = "sk-" + "x".repeat(20);

describe("analyzeImpact: filesystem tools", () => {
  it("describes a read as filesystem read with the target path", () => {
    const impact = analyzeImpact("read", { path: "src/index.ts" });
    expect(impact.filesystem).toEqual({ access: "read", paths: ["src/index.ts"] });
    expect(impact.process).toBe(false);
    expect(impact.network).toBe(false);
  });

  it("describes a write as filesystem write and collapses oversized content", () => {
    const impact = analyzeImpact("write", { path: "out.txt", content: "x".repeat(500) });
    expect(impact.filesystem).toEqual({ access: "write", paths: ["out.txt"] });
    expect(impact.collapsed).toContain("content");
  });

  it("keeps small write content uncollapsed", () => {
    const impact = analyzeImpact("write", { path: "out.txt", content: "hello" });
    expect(impact.collapsed).not.toContain("content");
  });

  it("collapses oversized edit payloads but keeps the path", () => {
    const impact = analyzeImpact("edit", {
      path: "src/app.ts",
      oldText: "o".repeat(300),
      newText: "n".repeat(300),
    });
    expect(impact.filesystem).toEqual({ access: "write", paths: ["src/app.ts"] });
    expect(impact.collapsed).toContain("oldText");
    expect(impact.collapsed).toContain("newText");
  });
});

describe("analyzeImpact: shell tool", () => {
  it("flags process for any shell command", () => {
    const impact = analyzeImpact("shell", { command: "echo hello" });
    expect(impact.process).toBe(true);
    expect(impact.network).toBe(false);
    expect(impact.commandPreview).toBe("echo hello");
  });

  it("detects network from a network command", () => {
    const impact = analyzeImpact("shell", { command: "curl https://example.com/data" });
    expect(impact.network).toBe(true);
  });

  it("detects network from git push", () => {
    const impact = analyzeImpact("shell", { command: "git push origin main" });
    expect(impact.network).toBe(true);
  });

  it("does not flag network for a local-only command", () => {
    const impact = analyzeImpact("shell", { command: "ls -la && cat file.txt" });
    expect(impact.network).toBe(false);
  });

  it("collapses a very long command while keeping a preview", () => {
    const impact = analyzeImpact("shell", { command: "echo " + "a".repeat(400) });
    expect(impact.collapsed).toContain("command");
    expect(impact.commandPreview).toContain("…[+");
  });

  it("always notes external-state impact for shell", () => {
    const impact = analyzeImpact("shell", { command: "echo hi" });
    expect(impact.externalState.length).toBeGreaterThan(0);
  });
});

describe("redactSecrets", () => {
  it("redacts CLI flag secrets but keeps the flag name", () => {
    const { text, count } = redactSecrets("deploy --password=hunter2 --verbose");
    expect(text).toContain("--password=[REDACTED]");
    expect(text).toContain("--verbose");
    expect(text).not.toContain("hunter2");
    expect(count).toBe(1);
  });

  it("redacts env-style secret assignments", () => {
    const { text } = redactSecrets("API_KEY=" + fakeApiKeyValue + " ./run.sh");
    expect(text).toContain("API_KEY=[REDACTED]");
    expect(text).not.toContain(fakeApiKeyValue);
  });

  it("redacts HTTP bearer tokens", () => {
    const { text } = redactSecrets("Authorization: Bearer " + fakeBearerToken);
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).not.toContain(fakeBearerToken);
  });

  it("redacts credentials embedded in URLs", () => {
    const { text } = redactSecrets("curl https://user:" + "topsecret" + "@host.example/path");
    expect(text).not.toContain("topsecret");
    expect(text).toContain("[REDACTED]@");
  });

  it("redacts well-known token prefixes", () => {
    const { text } = redactSecrets("logged token " + fakeKnownToken + " in output");
    expect(text).not.toContain(fakeKnownToken);
    expect(text).toContain("[REDACTED]");
  });

  it("does not double-count an already redacted value", () => {
    const once = redactSecrets("--token=placeholder");
    const twice = redactSecrets(once.text);
    expect(twice.count).toBe(0);
  });
});

describe("analyzeImpact + formatImpact: redaction end-to-end", () => {
  it("never leaks a secret from a shell command into the formatted preview", () => {
    const command =
      "curl --user " + fakeUserPass +
      " https://api.example.com --header 'Authorization: Bearer " + fakeBearerToken + "'";
    const impact = analyzeImpact("shell", { command });
    expect(impact.redactions).toBeGreaterThan(0);
    const formatted = formatImpact(impact);
    expect(formatted).not.toContain("topsecret");
    expect(formatted).not.toContain(fakeBearerToken);
    expect(formatted).toContain("Network: potential network access");
    expect(formatted).toContain("Redacted");
  });

  it("formats filesystem impact with the target path", () => {
    const formatted = formatImpact(analyzeImpact("write", { path: "notes.md", content: "hi" }));
    expect(formatted).toContain("Filesystem (write): notes.md");
  });

  it("reports no impact for an unknown tool without echoing args", () => {
    const formatted = formatImpact(analyzeImpact("mystery", { secret: "leak" }));
    expect(formatted).not.toContain("leak");
    expect(formatted).toContain("Unrecognized tool");
  });
});

// Spoofing Unicode fixtures are built from code points at runtime so the
// committed source never contains literal invisible/bidi characters.
const RLO = String.fromCodePoint(0x202e); // right-to-left override
const ZWSP = String.fromCodePoint(0x200b); // zero-width space
const BOM = String.fromCodePoint(0xfeff); // zero-width no-break space / BOM
const WJ = String.fromCodePoint(0x2060); // word joiner
const LQUOTE = String.fromCodePoint(0x201c); // left double quotation mark
const RQUOTE = String.fromCodePoint(0x201d); // right double quotation mark

describe("neutralizeSpoofing", () => {
  it("replaces bidi overrides/isolates with a visible marker and counts them", () => {
    const { text, count } = neutralizeSpoofing("a" + RLO + "b");
    expect(text).toBe("a[U+202E]b");
    expect(count).toBe(1);
    expect(text).not.toContain(RLO);
  });

  it("neutralizes zero-width characters including BOM and word joiner", () => {
    const { text, count } = neutralizeSpoofing(ZWSP + "x" + BOM + "y" + WJ);
    expect(count).toBe(3);
    expect(text).toContain("[U+200B]");
    expect(text).toContain("[U+FEFF]");
    expect(text).toContain("[U+2060]");
    expect(text).not.toContain(ZWSP);
    expect(text).not.toContain(BOM);
  });

  it("neutralizes look-alike quote characters", () => {
    const { text, count } = neutralizeSpoofing(LQUOTE + "rm -rf /" + RQUOTE);
    expect(count).toBe(2);
    expect(text).toContain("[U+201C]");
    expect(text).toContain("[U+201D]");
    expect(text).not.toContain(LQUOTE);
    expect(text).not.toContain(RQUOTE);
  });

  it("leaves ordinary ASCII and international text unchanged", () => {
    expect(neutralizeSpoofing("echo hello world")).toEqual({ text: "echo hello world", count: 0 });
    expect(neutralizeSpoofing("café résumé 日本語").count).toBe(0);
  });
});

describe("analyzeImpact + formatImpact: spoofing Unicode neutralization", () => {
  it("neutralizes spoofing chars in a shell command preview and reports the count", () => {
    const impact = analyzeImpact("shell", { command: "echo " + RLO + ZWSP + "done" });
    expect(impact.neutralized).toBe(2);
    expect(impact.commandPreview).not.toContain(RLO);
    expect(impact.commandPreview).not.toContain(ZWSP);
    expect(impact.commandPreview).toContain("[U+202E]");
    expect(impact.commandPreview).toContain("[U+200B]");
    const formatted = formatImpact(impact);
    expect(formatted).toContain("Neutralized 2 spoofing Unicode character(s).");
    expect(formatted).not.toContain(RLO);
  });

  it("neutralizes spoofing chars in a file path and reports the count", () => {
    const impact = analyzeImpact("read", { path: "src" + ZWSP + "/index.ts" });
    expect(impact.neutralized).toBe(1);
    expect(impact.filesystem?.paths[0]).not.toContain(ZWSP);
    expect(impact.filesystem?.paths[0]).toContain("[U+200B]");
    expect(formatImpact(impact)).toContain("Neutralized 1 spoofing Unicode character(s).");
  });

  it("keeps secret redaction working when spoofing chars are also present", () => {
    const command = "curl --user " + fakeUserPass + " " + RLO + "https://api.example.com";
    const impact = analyzeImpact("shell", { command });
    expect(impact.redactions).toBeGreaterThan(0);
    expect(impact.neutralized).toBe(1);
    const formatted = formatImpact(impact);
    expect(formatted).not.toContain("topsecret");
    expect(formatted).not.toContain(RLO);
    expect(formatted).toContain("[U+202E]");
    expect(formatted).toContain("Redacted");
  });

  it("renders an ordinary command identically with no neutralization marker", () => {
    const impact = analyzeImpact("shell", { command: "ls -la" });
    expect(impact.neutralized).toBe(0);
    expect(impact.commandPreview).toBe("ls -la");
    expect(formatImpact(impact)).not.toContain("Neutralized");
  });
});

describe("redactEndpointHost", () => {
  it("keeps only the host, dropping userinfo, path, and query", () => {
    const pass = ["s3", "cret"].join("");
    expect(redactEndpointHost(`https://user:${pass}@host.example/v1/secret?token=abc`)).toBe("host.example");
  });

  it("preserves the port", () => {
    expect(redactEndpointHost("http://127.0.0.1:8080/v1")).toBe("127.0.0.1:8080");
  });

  it("returns a placeholder for an unparseable URL", () => {
    expect(redactEndpointHost("not-a-url")).toBe("<invalid-url>");
  });
});
