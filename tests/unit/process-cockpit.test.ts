import { describe, it, expect } from "vitest";
import {
  ProcessCockpit,
  redactCommand,
  boundOutput,
  formatElapsed,
  formatCockpit,
} from "../../src/process-cockpit.js";

// Pure-function coverage for the read-only process cockpit (Issue #341):
// registration, output bounding, redaction, exit receipts, ownership,
// snapshot, formatting, and read-only guarantee.

// --- registration -----------------------------------------------------------

describe("registration", () => {
  it("registers a process with redacted command", () => {
    const cockpit = new ProcessCockpit("session-1");
    const entry = cockpit.register({
      id: "p1",
      pid: 1234,
      command: "npm run dev --token=secret123",
      cwd: "/workspace",
      startedAt: 1000,
      ports: [3000],
    });

    expect(entry.id).toBe("p1");
    expect(entry.pid).toBe(1234);
    expect(entry.command).toContain("[REDACTED]");
    expect(entry.command).not.toContain("secret123");
    expect(entry.status).toBe("running");
    expect(entry.cwd).toBe("/workspace");
    expect(entry.sessionId).toBe("session-1");
    expect(entry.ports).toEqual([3000]);
  });

  it("tracks multiple processes", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "a", cwd: "/ws", startedAt: 1000 });
    cockpit.register({ id: "p2", command: "b", cwd: "/ws", startedAt: 2000 });
    expect(cockpit.size).toBe(2);
  });
});

// --- output bounding --------------------------------------------------------

describe("output bounding", () => {
  it("bounds output to the configured limit", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "watch", cwd: "/ws", startedAt: 1000 });

    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    cockpit.appendOutput("p1", lines);

    const entry = cockpit.get("p1")!;
    expect(entry.outputLines.length).toBeLessThanOrEqual(50);
    expect(entry.totalOutputLines).toBe(100);
    expect(entry.outputTruncated).toBe(true);
    // Most recent lines are kept.
    expect(entry.outputLines[entry.outputLines.length - 1]).toBe("line 99");
  });

  it("does not append to exited processes", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "cmd", cwd: "/ws", startedAt: 1000 });
    cockpit.recordExit("p1", 0);
    cockpit.appendOutput("p1", ["late output"]);

    expect(cockpit.get("p1")!.outputLines).toHaveLength(0);
  });
});

describe("boundOutput", () => {
  it("truncates long lines", () => {
    const longLine = "x".repeat(20_000);
    const { bounded } = boundOutput([longLine]);
    expect(bounded[0].length).toBeLessThanOrEqual(10_000);
    expect(bounded[0].endsWith("…")).toBe(true);
  });
});

// --- redaction --------------------------------------------------------------

describe("redactCommand", () => {
  it("redacts token flags", () => {
    expect(redactCommand("deploy --token=abc123")).toContain("[REDACTED]");
    expect(redactCommand("deploy --token=abc123")).not.toContain("abc123");
  });

  it("redacts env-style secrets", () => {
    expect(redactCommand("MY_SECRET_TOKEN=placeholder-value cmd")).toContain("[REDACTED]");
  });

  it("redacts known token patterns", () => {
    // Use a value that matches the sk- pattern without triggering gitleaks.
    const token = "sk-" + "a".repeat(20);
    expect(redactCommand(`deploy --token=${token}`)).toContain("[REDACTED]");
  });

  it("preserves non-secret commands", () => {
    expect(redactCommand("npm run build")).toBe("npm run build");
  });

  it("truncates long commands", () => {
    const long = "a".repeat(300);
    expect(redactCommand(long).length).toBeLessThanOrEqual(200);
  });
});

// --- exit receipts ----------------------------------------------------------

describe("exit receipts", () => {
  it("records successful exit", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "build", cwd: "/ws", startedAt: 1000 });
    cockpit.recordExit("p1", 0);

    const entry = cockpit.get("p1")!;
    expect(entry.status).toBe("exited");
    expect(entry.receipt).toBeDefined();
    expect(entry.receipt!.exitCode).toBe(0);
    expect(entry.receipt!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("records failed exit", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "test", cwd: "/ws", startedAt: 1000 });
    cockpit.recordExit("p1", 1);

    expect(cockpit.get("p1")!.status).toBe("failed");
    expect(cockpit.get("p1")!.receipt!.exitCode).toBe(1);
  });

  it("records cancellation", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "serve", cwd: "/ws", startedAt: 1000 });
    cockpit.recordCancellation("p1");

    expect(cockpit.get("p1")!.status).toBe("cancelled");
    expect(cockpit.get("p1")!.receipt!.signal).toBe("SIGTERM");
  });
});

// --- snapshot ---------------------------------------------------------------

describe("snapshot", () => {
  it("produces a read-only snapshot with counts", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "a", cwd: "/ws", startedAt: 1000 });
    cockpit.register({ id: "p2", command: "b", cwd: "/ws", startedAt: 2000 });
    cockpit.recordExit("p2", 0);

    const snap = cockpit.snapshot(5000);
    expect(snap.sessionId).toBe("s1");
    expect(snap.runningCount).toBe(1);
    expect(snap.finishedCount).toBe(1);
    expect(snap.entries).toHaveLength(2);
    // Running processes sorted first.
    expect(snap.entries[0].status).toBe("running");
    expect(snap.entries[1].status).toBe("exited");
  });

  it("computes elapsed time for running processes", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "a", cwd: "/ws", startedAt: 1000 });

    const snap = cockpit.snapshot(6000);
    expect(snap.entries[0].elapsedMs).toBe(5000);
  });

  it("does not mutate the cockpit on snapshot", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "a", cwd: "/ws", startedAt: 1000 });

    cockpit.snapshot(5000);
    // The cockpit entry should still be running with original elapsedMs.
    expect(cockpit.get("p1")!.status).toBe("running");
    expect(cockpit.get("p1")!.elapsedMs).toBe(0);
  });
});

// --- ownership --------------------------------------------------------------

describe("ownership", () => {
  it("attributes processes to the session", () => {
    const cockpit = new ProcessCockpit("my-session");
    cockpit.register({ id: "p1", command: "a", cwd: "/ws", startedAt: 1000 });

    expect(cockpit.get("p1")!.sessionId).toBe("my-session");
    expect(cockpit.snapshot().sessionId).toBe("my-session");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatElapsed", () => {
  it("formats seconds", () => {
    expect(formatElapsed(5000)).toBe("5s");
  });

  it("formats minutes", () => {
    expect(formatElapsed(125_000)).toBe("2m5s");
  });

  it("formats hours", () => {
    expect(formatElapsed(3_700_000)).toBe("1h1m");
  });
});

describe("formatCockpit", () => {
  it("renders running and exited processes", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "watcher", pid: 100, command: "npm run watch", cwd: "/ws", startedAt: 1000, ports: [3000] });
    cockpit.appendOutput("watcher", ["compiling...", "done"]);
    cockpit.register({ id: "build", pid: 200, command: "npm run build", cwd: "/ws", startedAt: 500 });
    cockpit.recordExit("build", 0);

    const snap = cockpit.snapshot(10_000);
    const output = formatCockpit(snap);

    expect(output).toContain("Process Cockpit");
    expect(output).toContain("watcher");
    expect(output).toContain("running");
    expect(output).toContain("build");
    expect(output).toContain("exit: 0");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("snapshot does not modify entries", () => {
    const cockpit = new ProcessCockpit("s1");
    cockpit.register({ id: "p1", command: "a", cwd: "/ws", startedAt: 1000 });
    cockpit.appendOutput("p1", ["line1"]);

    const snap1 = cockpit.snapshot(2000);
    const snap2 = cockpit.snapshot(3000);

    // Both snapshots are independent; the cockpit is unchanged.
    expect(snap1.entries[0].elapsedMs).toBe(1000);
    expect(snap2.entries[0].elapsedMs).toBe(2000);
    expect(cockpit.get("p1")!.elapsedMs).toBe(0);
  });
});

// --- formatElapsed negative-elapsed clamp (Issue #810) ----------------------

describe("formatElapsed negative-elapsed clamp (Issue #810)", () => {
  it("renders a non-negative duration for negative elapsed ms (clock skew)", () => {
    expect(formatElapsed(-5000)).toBe("0s");
    expect(formatElapsed(-1)).toBe("0s");
  });

  it("leaves positive elapsed output unchanged (regression)", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(95000)).toBe("1m35s");
  });
});
