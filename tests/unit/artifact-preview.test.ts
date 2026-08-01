import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace.js";
import {
  previewArtifact,
  formatArtifactPreview,
  DEFAULT_PREVIEW_POLICY,
} from "../../src/artifact-preview.js";

// Fixture-based coverage for the safe static HTML artifact preview (Issue
// #344): script/network/navigation/form blocking, policy enforcement,
// content hash attribution, refusal paths, and formatting.

let tmpDir: string;
let ws: Workspace;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-test-"));
  ws = new Workspace(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

// --- safe artifact ----------------------------------------------------------

describe("safe artifact preview", () => {
  it("previews a clean HTML file with no blocked content", () => {
    write("report.html", "<html>\n<body>\n<h1>Hello</h1>\n</body>\n</html>\n");

    const result = previewArtifact(ws, "report.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked).toHaveLength(0);
      expect(result.hasBlockedContent).toBe(false);
      expect(result.sanitizedLines.length).toBe(6);
      expect(result.identity.path).toBe("report.html");
      expect(result.identity.contentHash).toHaveLength(64);
      expect(result.identity.sizeBytes).toBeGreaterThan(0);
      expect(result.policy).toEqual(DEFAULT_PREVIEW_POLICY);
    }
  });

  it("produces a deterministic content hash", () => {
    write("a.html", "<p>test</p>");

    const r1 = previewArtifact(ws, "a.html");
    const r2 = previewArtifact(ws, "a.html");
    expect(r1.renderStatus).toBe("ok");
    expect(r2.renderStatus).toBe("ok");
    if (r1.renderStatus === "ok" && r2.renderStatus === "ok") {
      expect(r1.identity.contentHash).toBe(r2.identity.contentHash);
    }
  });
});

// --- script blocking --------------------------------------------------------

describe("script blocking", () => {
  it("blocks script tags and reports them", () => {
    write("evil.html", '<html>\n<script>alert("xss")</script>\n<p>safe</p>\n</html>\n');

    const result = previewArtifact(ws, "evil.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.hasBlockedContent).toBe(true);
      expect(result.blocked.some((b) => b.reason === "script-tag")).toBe(true);
      const scriptLine = result.blocked.find((b) => b.reason === "script-tag");
      expect(scriptLine!.line).toBe(2);
      // Sanitized output should not contain the script.
      expect(result.sanitizedLines.join("\n")).not.toContain("alert");
      expect(result.sanitizedLines.join("\n")).toContain("BLOCKED: script");
    }
  });

  it("blocks inline event handlers", () => {
    write("evt.html", '<div onclick="steal()">click</div>\n');

    const result = previewArtifact(ws, "evt.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.some((b) => b.reason === "event-handler")).toBe(true);
      expect(result.sanitizedLines[0]).not.toContain("onclick");
    }
  });

  it("blocks javascript: URIs", () => {
    write("jsuri.html", '<a href="javascript:alert(1)">click</a>\n');

    const result = previewArtifact(ws, "jsuri.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.some((b) => b.reason === "javascript-uri")).toBe(true);
      expect(result.sanitizedLines[0]).toContain("about:blank");
    }
  });
});

// --- network blocking -------------------------------------------------------

describe("network blocking", () => {
  it("blocks remote URLs in src/href attributes", () => {
    write("remote.html", '<img src="https://evil.com/track.png">\n<link href="https://cdn.example.com/style.css">\n');

    const result = previewArtifact(ws, "remote.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.filter((b) => b.reason === "remote-url").length).toBeGreaterThanOrEqual(2);
      expect(result.sanitizedLines.join("\n")).not.toContain("evil.com");
      expect(result.sanitizedLines.join("\n")).toContain("about:blank");
    }
  });

  it("blocks iframes", () => {
    write("frame.html", '<iframe src="https://evil.com"></iframe>\n');

    const result = previewArtifact(ws, "frame.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.some((b) => b.reason === "iframe")).toBe(true);
    }
  });
});

// --- navigation blocking ----------------------------------------------------

describe("navigation blocking", () => {
  it("blocks meta refresh", () => {
    write("refresh.html", '<meta http-equiv="refresh" content="0;url=https://evil.com">\n');

    const result = previewArtifact(ws, "refresh.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.some((b) => b.reason === "meta-refresh")).toBe(true);
    }
  });
});

// --- form blocking ----------------------------------------------------------

describe("form blocking", () => {
  it("blocks forms", () => {
    write("form.html", '<form action="https://evil.com/steal">\n<input name="pw">\n</form>\n');

    const result = previewArtifact(ws, "form.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.some((b) => b.reason === "form")).toBe(true);
      expect(result.blocked.some((b) => b.reason === "remote-url")).toBe(true);
    }
  });

  it("blocks object/embed", () => {
    write("obj.html", '<object data="flash.swf"></object>\n<embed src="applet.jar">\n');

    const result = previewArtifact(ws, "obj.html");
    expect(result.renderStatus).toBe("ok");
    if (result.renderStatus === "ok") {
      expect(result.blocked.some((b) => b.reason === "object-embed")).toBe(true);
    }
  });
});

// --- refusal paths ----------------------------------------------------------

describe("refusals", () => {
  it("refuses untrusted workspace", () => {
    write("a.html", "<p>ok</p>");
    const result = previewArtifact(ws, "a.html", { trusted: false });
    expect(result.renderStatus).toBe("refused");
    if (result.renderStatus === "refused") {
      expect(result.reason).toBe("untrusted");
      expect(result.detail).toContain("--trust");
    }
  });

  it("refuses non-HTML extensions", () => {
    write("script.js", "alert(1)");
    const result = previewArtifact(ws, "script.js");
    expect(result.renderStatus).toBe("refused");
    if (result.renderStatus === "refused") {
      expect(result.reason).toBe("not-html");
    }
  });

  it("refuses oversized files", () => {
    write("big.html", "<p>" + "x".repeat(6_000_000) + "</p>");
    const result = previewArtifact(ws, "big.html");
    expect(result.renderStatus).toBe("refused");
    if (result.renderStatus === "refused") {
      expect(result.reason).toBe("oversized");
    }
  });

  it("refuses nonexistent files", () => {
    const result = previewArtifact(ws, "missing.html");
    expect(result.renderStatus).toBe("refused");
    if (result.renderStatus === "refused") {
      expect(result.reason).toBe("unreadable");
    }
  });

  it("refuses paths with ..", () => {
    const result = previewArtifact(ws, "../escape.html");
    expect(result.renderStatus).toBe("refused");
    if (result.renderStatus === "refused") {
      expect(result.reason).toBe("outside-workspace");
    }
  });

  it("refuses binary content", () => {
    const abs = path.join(tmpDir, "bin.html");
    fs.writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const result = previewArtifact(ws, "bin.html");
    expect(result.renderStatus).toBe("refused");
    if (result.renderStatus === "refused") {
      expect(result.reason).toBe("binary");
    }
  });
});

// --- formatting -------------------------------------------------------------

describe("formatArtifactPreview", () => {
  it("renders a successful preview with policy and blocked content", () => {
    write("test.html", '<p>ok</p>\n<script>bad()</script>\n');

    const result = previewArtifact(ws, "test.html");
    const output = formatArtifactPreview(result);

    expect(output).toContain("Artifact Preview");
    expect(output).toContain("test.html");
    expect(output).toContain("disabled");
    expect(output).toContain("script-tag");
    expect(output).toContain("open (safe)");
  });

  it("renders a refusal with recovery guidance", () => {
    const result = previewArtifact(ws, "missing.html");
    const output = formatArtifactPreview(result);

    expect(output).toContain("REFUSED");
    expect(output).toContain("unreadable");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("does not mutate the artifact", () => {
    write("a.html", "<p>original</p>");
    const before = fs.readFileSync(path.join(tmpDir, "a.html"), "utf-8");

    previewArtifact(ws, "a.html");

    expect(fs.readFileSync(path.join(tmpDir, "a.html"), "utf-8")).toBe(before);
  });
});
