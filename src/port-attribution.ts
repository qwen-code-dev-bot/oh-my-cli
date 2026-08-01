// Read-only port and preview attribution: links network ports and preview
// URLs to the background process that opened them.
//
// Port entries expose number, protocol, owning process id, session id, and
// open/close state. Preview links derive from attributed ports. Orphaned
// ports (process exited but port still recorded) are flagged with visible
// reasons. The view is read-only and never opens, closes, or binds ports.

export const PORT_ATTRIBUTION_SCHEMA = "oh-my-cli.port-attribution";
export const PORT_ATTRIBUTION_VERSION = 1;

// --- port entries -----------------------------------------------------------

export type PortState = "open" | "closed" | "orphaned";
export type PortProtocol = "tcp" | "udp" | "http" | "https" | "ws";

export interface PortEntry {
  /** Port number. */
  port: number;
  protocol: PortProtocol;
  /** Process that opened this port. */
  processId: string;
  /** Session that owns the process. */
  sessionId: string;
  state: PortState;
  /** Epoch ms when the port was opened. */
  openedAt: number;
  /** Epoch ms when the port was closed (when known). */
  closedAt?: number;
  /** Whether the owning process is still running. */
  processAlive: boolean;
}

// --- preview links ----------------------------------------------------------

export interface PreviewLink {
  /** Derived URL (e.g. http://localhost:3000). */
  url: string;
  /** The port this link derives from. */
  port: number;
  /** Process that launched the server. */
  processId: string;
  sessionId: string;
}

// Derive a preview link from an attributed port.
export function derivePreviewLink(entry: PortEntry): PreviewLink {
  const scheme = entry.protocol === "https" ? "https" : "http";
  return {
    url: `${scheme}://localhost:${entry.port}`,
    port: entry.port,
    processId: entry.processId,
    sessionId: entry.sessionId,
  };
}

// --- port registry ----------------------------------------------------------

export class PortRegistry {
  private readonly entries: PortEntry[] = [];

  /** Record a port opened by a process. */
  recordOpen(opts: {
    port: number;
    protocol: PortProtocol;
    processId: string;
    sessionId: string;
    openedAt: number;
  }): PortEntry {
    const entry: PortEntry = {
      ...opts,
      state: "open",
      processAlive: true,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Record a port closed. */
  recordClose(port: number, processId: string, closedAt: number): void {
    const entry = this.entries.find(
      (e) => e.port === port && e.processId === processId && e.state === "open",
    );
    if (entry) {
      entry.state = "closed";
      entry.closedAt = closedAt;
    }
  }

  /** Mark a process as exited, orphaning its still-open ports. */
  markProcessExited(processId: string): void {
    for (const entry of this.entries) {
      if (entry.processId === processId) {
        entry.processAlive = false;
        if (entry.state === "open") {
          entry.state = "orphaned";
        }
      }
    }
  }

  /** Get all entries for a process. */
  getByProcess(processId: string): PortEntry[] {
    return this.entries.filter((e) => e.processId === processId);
  }

  /** Get all entries for a session. */
  getBySession(sessionId: string): PortEntry[] {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }

  /** Get all open or orphaned ports. */
  getActive(): PortEntry[] {
    return this.entries.filter((e) => e.state === "open" || e.state === "orphaned");
  }

  /** Get all orphaned ports. */
  getOrphaned(): PortEntry[] {
    return this.entries.filter((e) => e.state === "orphaned");
  }

  /** Derive preview links for all open ports. */
  getPreviewLinks(): PreviewLink[] {
    return this.entries
      .filter((e) => e.state === "open")
      .map(derivePreviewLink);
  }

  get size(): number {
    return this.entries.length;
  }
}

// --- attribution view -------------------------------------------------------

export interface AttributionView {
  schema: typeof PORT_ATTRIBUTION_SCHEMA;
  v: typeof PORT_ATTRIBUTION_VERSION;
  entries: PortEntry[];
  previewLinks: PreviewLink[];
  openCount: number;
  closedCount: number;
  orphanedCount: number;
  hasOrphans: boolean;
  snapshotAt: number;
}

// Assemble a read-only attribution view from a port registry.
export function assembleAttributionView(registry: PortRegistry): AttributionView {
  const entries = [...registry.getActive()];
  const previewLinks = registry.getPreviewLinks();
  const orphaned = registry.getOrphaned();

  // Include closed entries too for a complete picture.
  const allEntries = [...entries];
  const closedEntries = registry["entries"].filter((e: PortEntry) => e.state === "closed");
  allEntries.push(...closedEntries);

  return {
    schema: PORT_ATTRIBUTION_SCHEMA,
    v: PORT_ATTRIBUTION_VERSION,
    entries: allEntries,
    previewLinks,
    openCount: allEntries.filter((e) => e.state === "open").length,
    closedCount: closedEntries.length,
    orphanedCount: orphaned.length,
    hasOrphans: orphaned.length > 0,
    snapshotAt: Date.now(),
  };
}

// --- formatting -------------------------------------------------------------

// Format an attribution view as a compact TUI view.
export function formatAttributionView(view: AttributionView): string {
  const lines: string[] = [];
  lines.push("Port Attribution");
  lines.push("═".repeat(50));
  lines.push(`Open: ${view.openCount}  Closed: ${view.closedCount}  Orphaned: ${view.orphanedCount}`);

  if (view.hasOrphans) {
    lines.push("⚠ Orphaned ports detected (process exited, port still recorded)");
  }

  for (const entry of view.entries) {
    const icon = stateIcon(entry.state);
    const alive = entry.processAlive ? "" : " [process exited]";
    lines.push(`${icon} :${entry.port} [${entry.protocol}] ${entry.state} proc:${entry.processId} sess:${entry.sessionId}${alive}`);
  }

  if (view.previewLinks.length > 0) {
    lines.push("");
    lines.push("Preview links:");
    for (const link of view.previewLinks) {
      lines.push(`  → ${link.url} (proc:${link.processId})`);
    }
  }

  lines.push("");
  lines.push("Read-only: no ports opened, closed, or bound.");

  return lines.join("\n");
}

function stateIcon(state: PortState): string {
  switch (state) {
    case "open": return "●";
    case "closed": return "○";
    case "orphaned": return "⚠";
  }
}
