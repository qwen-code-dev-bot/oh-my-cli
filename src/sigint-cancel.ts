// Cooperative SIGINT cancellation for non-interactive runs (#552). The first
// Ctrl+C during a headless run requests a cooperative cancel: the run stops at
// the next cancel boundary (#489/#550 semantics — the in-flight tool is never
// killed, pending batch calls persist cancelled placeholders, no further
// provider round runs) and settles with a truthful terminal record instead of
// dying mid-run. A second Ctrl+C escalates to an immediate exit so a long
// in-flight tool can never hold the user hostage; the append-only transcript
// stays crash-safe because a trailing torn line is recoverable as a partial
// session. The state machine is pure and the exit is injectable so tests never
// terminate the test process.

export const SIGINT_EXIT_CODE = 130;

export interface SigintCancelOptions {
  // Called exactly once when the first SIGINT requests a cancel (e.g. a bounded
  // stderr notice). A failing notice must not block the cooperative cancel.
  onInterrupt?: () => void;
  // Injectable immediate termination for the second SIGINT; defaults to
  // process.exit so production winds down nowhere else.
  exit?: (code: number) => void;
}

export interface SigintCancelHandle {
  // Wire as runAgent's cancelRequested: true once a cancel was requested.
  cancelRequested: () => boolean;
  // Remove the SIGINT listener; the run-scoped handler never outlives the run.
  dispose: () => void;
}

// Install a run-scoped SIGINT handler that escalates across a run's lifetime:
// first signal requests the cooperative cancel, second (or later) exits
// immediately with SIGINT_EXIT_CODE. Returns the cancelRequested predicate and
// a dispose that detaches the listener.
export function installSigintCancel(opts: SigintCancelOptions = {}): SigintCancelHandle {
  let requested = false;
  const handle = (): void => {
    if (!requested) {
      requested = true;
      try {
        opts.onInterrupt?.();
      } catch {
        /* a failed notice must not block the cooperative cancel */
      }
      return;
    }
    (opts.exit ?? process.exit)(SIGINT_EXIT_CODE);
  };
  process.on("SIGINT", handle);
  return {
    cancelRequested: () => requested,
    dispose: () => {
      process.removeListener("SIGINT", handle);
    },
  };
}
