// Operator-settable run caps for bounded unattended execution (Issues #515,
// #517).
//
// Cost budgeting (`--budget`) only bounds a run when a model price is known,
// and the internal MAX_ROUNDS ceiling is a fixed safety bound, not user
// policy. These parsers give automation authors declarative turn, wall-time,
// and tool-call caps. They follow the `parseBudgetUsd` convention
// (src/cost.ts): unset/blank means "no cap" (null); an invalid value throws
// so the CLI can report an actionable usage error instead of silently
// disabling the cap.

// Parse a turn cap from a flag or env value. Returns null when unset. The cap
// stops the run before the (n+1)th provider round. Throws on a non-positive
// or non-integer value.
export function parseMaxTurns(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid max turns "${value}": expected a positive integer (e.g. 30)`,
    );
  }
  return n;
}

// Parse a cumulative tool-call cap from a flag or env value (Issue #517).
// Returns null when unset. Once the run's processed tool-call count reaches
// the cap, the run stops at the next round boundary. Throws on a non-positive
// or non-integer value.
export function parseMaxToolCalls(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid max tool calls "${value}": expected a positive integer (e.g. 50)`,
    );
  }
  return n;
}

const WALL_TIME_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

// Parse a wall-time budget from a flag or env value into milliseconds.
// Accepts bare seconds or an `s`/`m`/`h` suffix: `90`, `30s`, `5m`, `1h`,
// `1.5h`. Returns null when unset. Throws on an unparseable or non-positive
// duration.
export function parseWallTimeMs(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid wall-time budget "${value}": expected a duration like 90, 30s, 5m, 1h, or 1.5h`,
    );
  }
  const amount = Number(match[1]);
  const factor = WALL_TIME_UNITS_MS[match[2] ?? "s"];
  const ms = amount * factor;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `Invalid wall-time budget "${value}": expected a positive duration`,
    );
  }
  return ms;
}
