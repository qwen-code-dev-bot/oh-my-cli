import { describe, it, expect } from "vitest";
import {
  normalizeFatalError,
  stripTerminalControl,
  installFatalBoundary,
  FATAL_EXIT_CODE,
  TERMINAL_RESTORE_SEQUENCE,
} from "../../src/fatal-boundary.js";

const SECRET = ["ghp", "_", "a".repeat(24)].join("");

describe("stripTerminalControl (#246)", () => {
  it("removes CSI cursor/clear sequences", () => {
    expect(stripTerminalControl("ok\x1b[2J\x1b[H\x1b[1;1Hdone")).toBe("okdone");
  });

  it("removes OSC and alternate-screen sequences", () => {
    expect(stripTerminalControl("a\x1b]0;title\x07b\x1b[?1049hc")).toBe("abc");
  });

  it("removes stray control characters but keeps newline and tab", () => {
    expect(stripTerminalControl("line1\nline2\tcol\x00\x08end")).toBe("line1\nline2\tcolend");
  });
});

describe("normalizeFatalError (#246)", () => {
  it("uses an Error message", () => {
    expect(normalizeFatalError(new Error("boom"))).toBe("boom");
  });

  it("uses a string value directly", () => {
    expect(normalizeFatalError("plain failure")).toBe("plain failure");
  });

  it("serializes a non-Error, non-string value", () => {
    expect(normalizeFatalError({ code: 42 })).toContain("42");
  });

  it("redacts secret-like values", () => {
    expect(normalizeFatalError(new Error(`failed with ${SECRET}`))).not.toContain(SECRET);
    expect(normalizeFatalError(new Error(`failed with ${SECRET}`))).toContain("[REDACTED]");
  });

  it("neutralizes terminal-control spoofing in thrown values", () => {
    const normalized = normalizeFatalError(new Error("bad\x1b[2J\x1b[Hspoof"));
    expect(normalized).not.toContain("\x1b[");
    expect(normalized).toContain("badspoof");
  });

  it("bounds an oversized message", () => {
    const normalized = normalizeFatalError("x".repeat(5000));
    expect(normalized.length).toBeLessThan(600);
    expect(normalized).toContain("chars]");
  });

  it("does not split an emoji/astral char at the fatal-message bound (Issue #826)", () => {
    // MAX_FATAL_MESSAGE is 500; position the emoji so it straddles the bound.
    const normalized = normalizeFatalError("y".repeat(499) + "🚀" + "more");
    expect(normalized).toContain("chars]");
    const prefix = normalized.split(" …[+")[0];
    expect(prefix).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("falls back when there is no usable detail", () => {
    expect(normalizeFatalError("")).toBe("unknown internal runtime failure");
  });

  it("uses the error name when the message is empty", () => {
    expect(normalizeFatalError(new Error(""))).toBe("Error");
  });
});

describe("installFatalBoundary (#246)", () => {
  it("runs cleanup, emits one terminal record, and exits on an unhandled rejection", () => {
    const events: string[] = [];
    const uninstall = installFatalBoundary({
      cleanup: () => events.push("cleanup"),
      emitTerminalRecord: (msg) => events.push(`record:${msg}`),
      exit: (code) => events.push(`exit:${code}`),
    });
    try {
      process.emit("unhandledRejection", new Error(`async boom ${SECRET}`), Promise.resolve());
      expect(events[0]).toBe("cleanup");
      expect(events.filter((e) => e.startsWith("record:")).length).toBe(1);
      expect(events).toContain(`exit:${FATAL_EXIT_CODE}`);
      // The emitted detail is redacted.
      const record = events.find((e) => e.startsWith("record:"))!;
      expect(record).not.toContain(SECRET);
    } finally {
      uninstall();
    }
  });

  it("handles an uncaught exception the same way", () => {
    const events: string[] = [];
    const uninstall = installFatalBoundary({
      emitTerminalRecord: (msg) => events.push(`record:${msg}`),
      exit: (code) => events.push(`exit:${code}`),
    });
    try {
      process.emit("uncaughtException", new Error("sync boom"));
      expect(events.filter((e) => e.startsWith("record:")).length).toBe(1);
      expect(events).toContain(`exit:${FATAL_EXIT_CODE}`);
      expect(events.find((e) => e.startsWith("record:"))).toContain("sync boom");
    } finally {
      uninstall();
    }
  });

  it("does not recurse or double-emit when cleanup and emit themselves fail", () => {
    let cleanups = 0;
    let records = 0;
    let exits = 0;
    const uninstall = installFatalBoundary({
      cleanup: () => {
        cleanups++;
        throw new Error("cleanup failed");
      },
      emitTerminalRecord: () => {
        records++;
        // A secondary synchronous failure during emit must not recurse.
        process.emit("uncaughtException", new Error("secondary"));
      },
      exit: () => {
        exits++;
      },
    });
    try {
      process.emit("unhandledRejection", new Error("primary"), Promise.resolve());
      expect(cleanups).toBe(1);
      expect(records).toBe(1);
      expect(exits).toBe(1);
    } finally {
      uninstall();
    }
  });

  it("stops handling once uninstalled (handlers do not accumulate)", () => {
    let exits = 0;
    const uninstall = installFatalBoundary({ exit: () => exits++ });
    uninstall();
    // After uninstall, the boundary's handler is gone; emit a benign event that a
    // no-op default handler absorbs without touching our counter.
    const noop = () => {};
    process.on("unhandledRejection", noop);
    try {
      process.emit("unhandledRejection", new Error("after uninstall"), Promise.resolve());
      expect(exits).toBe(0);
    } finally {
      process.removeListener("unhandledRejection", noop);
    }
  });

  it("exposes a terminal restore sequence that shows the cursor and leaves alt-screen", () => {
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?25h"); // show cursor
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[0m"); // reset attributes
    expect(TERMINAL_RESTORE_SEQUENCE).toContain("\x1b[?1049l"); // exit alt screen
  });
});
