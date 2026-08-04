// Offline-mode guard for provider dispatch (Issue #576, roadmap #287's
// offline-enforcement step). With offline mode active (--offline or
// OMC_OFFLINE=1), provider dispatch to non-loopback endpoints is refused
// fail-closed BEFORE any network I/O, while loopback endpoints (a local
// OpenAI-compatible server) keep working. The loopback decision is purely
// lexical — no DNS resolution, no probes — and unparseable endpoints fail
// closed (never treated as loopback). Offline mode adds a boundary; it never
// removes approvals, spend limits, or any other safety gate.

import { redactEndpointHost } from "./permission-impact.js";

export const OFFLINE_ENV = "OMC_OFFLINE";

export function isOfflineRequested(env: Record<string, string | undefined>): boolean {
  return env[OFFLINE_ENV] === "1";
}

/**
 * Lexical loopback classification of a base URL host. Recognized local forms:
 * `localhost`, `127.0.0.1`, and bracketed IPv6 loopback (`[::1]`,
 * `[0:0:0:0:0:0:0:1]`), all case-insensitive. Unparseable URLs (including
 * bare unbracketed IPv6, which the URL spec rejects) and hostname aliases
 * fail closed (not loopback). No DNS resolution or probes.
 */
export function isLoopbackBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  );
}

export type OfflineDispatchDecision =
  | { allowed: true }
  | { allowed: false; redactedHost: string };

/** Decide whether a provider dispatch may proceed under offline mode. */
export function offlineDispatchDecision(opts: {
  offline: boolean;
  baseUrl: string | null | undefined;
}): OfflineDispatchDecision {
  if (!opts.offline) return { allowed: true };
  if (isLoopbackBaseUrl(opts.baseUrl)) return { allowed: true };
  return { allowed: false, redactedHost: redactEndpointHost(opts.baseUrl ?? "") };
}

export function offlineRefusalMessage(redactedHost: string): string {
  return (
    `Offline mode is active; the provider route to ${redactedHost} was blocked before any network I/O. ` +
    `Point OPENAI_BASE_URL at a loopback endpoint (a local OpenAI-compatible server), ` +
    `or disable offline mode (remove --offline / unset ${OFFLINE_ENV}).`
  );
}

/** Thrown before any network I/O; callers must not retry it. */
export class OfflineRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineRefusalError";
  }
}
