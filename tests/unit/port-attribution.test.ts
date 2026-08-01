import { describe, it, expect } from "vitest";
import {
  PortRegistry,
  derivePreviewLink,
  assembleAttributionView,
  formatAttributionView,
} from "../../src/port-attribution.js";

// Pure-function coverage for port attribution (Issue #356): port lifecycle,
// orphan detection, multi-process, preview links, and read-only guarantee.

// --- port lifecycle ---------------------------------------------------------

describe("port lifecycle", () => {
  it("records open ports", () => {
    const reg = new PortRegistry();
    const entry = reg.recordOpen({
      port: 3000,
      protocol: "http",
      processId: "p1",
      sessionId: "s1",
      openedAt: 1000,
    });

    expect(entry.port).toBe(3000);
    expect(entry.state).toBe("open");
    expect(entry.processAlive).toBe(true);
    expect(reg.size).toBe(1);
  });

  it("records port close", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.recordClose(3000, "p1", 2000);

    const entries = reg.getByProcess("p1");
    expect(entries[0].state).toBe("closed");
    expect(entries[0].closedAt).toBe(2000);
  });

  it("tracks multiple ports per process", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.recordOpen({ port: 3001, protocol: "ws", processId: "p1", sessionId: "s1", openedAt: 1000 });

    expect(reg.getByProcess("p1")).toHaveLength(2);
  });
});

// --- orphan detection -------------------------------------------------------

describe("orphan detection", () => {
  it("flags open ports as orphaned when process exits", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.markProcessExited("p1");

    const orphaned = reg.getOrphaned();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].port).toBe(3000);
    expect(orphaned[0].state).toBe("orphaned");
    expect(orphaned[0].processAlive).toBe(false);
  });

  it("does not orphan already-closed ports", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.recordClose(3000, "p1", 1500);
    reg.markProcessExited("p1");

    expect(reg.getOrphaned()).toHaveLength(0);
    expect(reg.getByProcess("p1")[0].state).toBe("closed");
  });
});

// --- multi-process fixture --------------------------------------------------

describe("multi-process fixture", () => {
  it("tracks ports across processes and sessions", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "dev-server", sessionId: "s1", openedAt: 1000 });
    reg.recordOpen({ port: 5432, protocol: "tcp", processId: "db", sessionId: "s1", openedAt: 1000 });
    reg.recordOpen({ port: 8080, protocol: "http", processId: "api", sessionId: "s2", openedAt: 2000 });

    expect(reg.getBySession("s1")).toHaveLength(2);
    expect(reg.getBySession("s2")).toHaveLength(1);
    expect(reg.getActive()).toHaveLength(3);

    // Kill the dev server.
    reg.markProcessExited("dev-server");
    expect(reg.getOrphaned()).toHaveLength(1);
    expect(reg.getActive()).toHaveLength(3); // orphaned still active
  });
});

// --- preview links ----------------------------------------------------------

describe("preview links", () => {
  it("derives preview links from open ports", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.recordOpen({ port: 443, protocol: "https", processId: "p2", sessionId: "s1", openedAt: 1000 });

    const links = reg.getPreviewLinks();
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("http://localhost:3000");
    expect(links[1].url).toBe("https://localhost:443");
    expect(links[0].processId).toBe("p1");
  });

  it("excludes orphaned ports from preview links", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.markProcessExited("p1");

    expect(reg.getPreviewLinks()).toHaveLength(0);
  });

  it("derives link from a single entry", () => {
    const entry = {
      port: 8080,
      protocol: "http" as const,
      processId: "p1",
      sessionId: "s1",
      state: "open" as const,
      openedAt: 1000,
      processAlive: true,
    };
    const link = derivePreviewLink(entry);
    expect(link.url).toBe("http://localhost:8080");
    expect(link.processId).toBe("p1");
  });
});

// --- attribution view -------------------------------------------------------

describe("assembleAttributionView", () => {
  it("assembles view with counts and orphan flag", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });
    reg.recordOpen({ port: 5432, protocol: "tcp", processId: "p2", sessionId: "s1", openedAt: 1000 });
    reg.recordClose(5432, "p2", 2000);
    reg.recordOpen({ port: 8080, protocol: "http", processId: "p3", sessionId: "s1", openedAt: 1000 });
    reg.markProcessExited("p3");

    const view = assembleAttributionView(reg);
    expect(view.openCount).toBe(1);
    expect(view.closedCount).toBe(1);
    expect(view.orphanedCount).toBe(1);
    expect(view.hasOrphans).toBe(true);
    expect(view.previewLinks).toHaveLength(1);
  });
});

// --- formatting -------------------------------------------------------------

describe("formatAttributionView", () => {
  it("renders ports, orphans, and preview links", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "dev", sessionId: "s1", openedAt: 1000 });
    reg.recordOpen({ port: 8080, protocol: "http", processId: "api", sessionId: "s1", openedAt: 1000 });
    reg.markProcessExited("api");

    const view = assembleAttributionView(reg);
    const output = formatAttributionView(view);

    expect(output).toContain("Port Attribution");
    expect(output).toContain(":3000");
    expect(output).toContain(":8080");
    expect(output).toContain("orphaned");
    expect(output).toContain("Orphaned ports detected");
    expect(output).toContain("http://localhost:3000");
    expect(output).toContain("Read-only");
  });
});

// --- read-only guarantee ----------------------------------------------------

describe("read-only guarantee", () => {
  it("view assembly does not mutate registry", () => {
    const reg = new PortRegistry();
    reg.recordOpen({ port: 3000, protocol: "http", processId: "p1", sessionId: "s1", openedAt: 1000 });

    const before = reg.size;
    assembleAttributionView(reg);
    expect(reg.size).toBe(before);
    expect(reg.getActive()).toHaveLength(1);
  });
});
