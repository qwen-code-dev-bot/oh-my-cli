import { describe, it, expect } from "vitest";
import { analyzeImpact, formatImpact, redactSecrets } from "../../src/permission-impact.js";

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
