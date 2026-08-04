import { describe, it, expect, afterEach } from "vitest";
import { installSigintCancel, SIGINT_EXIT_CODE } from "../../src/sigint-cancel.js";

// Drive the handler deterministically: process.emit("SIGINT") invokes the
// installed listeners synchronously without delivering a real signal, so the
// test process itself never terminates.
function emitSigint(): void {
  process.emit("SIGINT");
}

describe("installSigintCancel (#552)", () => {
  const handles: Array<ReturnType<typeof installSigintCancel>> = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.dispose();
  });

  function install(opts: Parameters<typeof installSigintCancel>[0] = {}) {
    const handle = installSigintCancel({ exit: opts?.exit ?? (() => {}), ...opts });
    handles.push(handle);
    return handle;
  }

  it("first signal requests a cancel without exiting", () => {
    let interrupts = 0;
    const exits: number[] = [];
    const h = install({ onInterrupt: () => interrupts++, exit: (c) => exits.push(c) });

    expect(h.cancelRequested()).toBe(false);
    emitSigint();

    expect(h.cancelRequested()).toBe(true);
    expect(interrupts).toBe(1);
    expect(exits).toEqual([]);
  });

  it("second signal escalates to an immediate SIGINT-code exit", () => {
    const exits: number[] = [];
    const h = install({ exit: (c) => exits.push(c) });

    emitSigint();
    emitSigint();

    expect(exits).toEqual([SIGINT_EXIT_CODE]);
    // Further signals keep escalating; the exit hook owns the termination.
    emitSigint();
    expect(exits).toEqual([SIGINT_EXIT_CODE, SIGINT_EXIT_CODE]);
  });

  it("repeats of the first signal never re-run the notice", () => {
    let interrupts = 0;
    const h = install({ onInterrupt: () => interrupts++ });
    emitSigint();
    // A second signal escalates instead of noticing again.
    emitSigint();
    expect(interrupts).toBe(1);
  });

  it("a failing notice still requests the cancel", () => {
    const exits: number[] = [];
    const h = install({
      onInterrupt: () => {
        throw new Error("stderr unavailable");
      },
      exit: (c) => exits.push(c),
    });

    emitSigint();
    expect(h.cancelRequested()).toBe(true);
    emitSigint();
    expect(exits).toEqual([SIGINT_EXIT_CODE]);
  });

  it("dispose detaches the handler completely", () => {
    let interrupts = 0;
    const exits: number[] = [];
    const h = install({ onInterrupt: () => interrupts++, exit: (c) => exits.push(c) });
    h.dispose();

    emitSigint();
    expect(interrupts).toBe(0);
    expect(exits).toEqual([]);
    expect(h.cancelRequested()).toBe(false);
  });

  it("exposes the conventional SIGINT exit code", () => {
    expect(SIGINT_EXIT_CODE).toBe(130);
  });
});
