// Bounded corruption warnings for the readline surface (Issue #739). The
// full-screen shell already surfaces corrupt draft/history stores as
// transcript notices (#556/#723 wiring); the readline wiring used to swallow
// both silently. One bounded warning per corrupt store at startup: the fact,
// the consequence (starting empty), and the preserved file path for
// inspection — never store content.

import { redactHomePath } from "./permission-impact.js";

export type CorruptStoreKind = "composer draft" | "prompt history";

// Same convention as the other diagnostics modules (home collapsed to ~).
export function redactStorePath(
  p: string,
  home: string | undefined = process.env.HOME ?? process.env.USERPROFILE,
): string {
  return redactHomePath(p, home);
}

export function corruptStoreWarning(kind: CorruptStoreKind, filePath: string): string {
  const shown = redactStorePath(filePath);
  if (kind === "composer draft") {
    return `Warning: composer draft could not be restored; starting with an empty composer (file kept for inspection: ${shown})`;
  }
  return `Warning: prompt history could not be restored; starting with an empty recall (file kept for inspection: ${shown})`;
}
