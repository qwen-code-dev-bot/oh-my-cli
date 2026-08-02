import { describe, it, expect } from "vitest";
import {
  AnswerRouter,
  formatAnswerRouter,
} from "../../src/answer-routing.js";

// Pure-function coverage for answer routing (Issue #428): answer routing,
// pending/consumed tracking, bounding, and determinism.

// --- answer routing ---------------------------------------------------------

describe("routeAnswer", () => {
  it("routes an answer to a waiting Goal", () => {
    const router = new AnswerRouter();
    const route = router.routeAnswer("Yes, use OAuth2", 1, 1, 1000);

    expect(route).not.toBeNull();
    expect(route!.id).toBe("answer-1");
    expect(route!.answerText).toBe("Yes, use OAuth2");
    expect(route!.goalRevision).toBe(1);
    expect(route!.attempt).toBe(1);
    expect(route!.consumed).toBe(false);
    expect(router.size).toBe(1);
  });

  it("assigns incrementing IDs", () => {
    const router = new AnswerRouter();
    const r1 = router.routeAnswer("First", 1, 1, 1000);
    const r2 = router.routeAnswer("Second", 1, 1, 2000);

    expect(r1!.id).toBe("answer-1");
    expect(r2!.id).toBe("answer-2");
  });

  it("redacts secrets in answer text", () => {
    const router = new AnswerRouter();
    const route = router.routeAnswer("Use --token=supersecretvalue123", 1, 1);

    expect(route!.answerText).toContain("[REDACTED]");
    expect(route!.answerText).not.toContain("supersecretvalue123");
  });

  it("bounds answer text at 500 chars", () => {
    const router = new AnswerRouter();
    const route = router.routeAnswer("x".repeat(1000), 1, 1);

    expect(route!.answerText.length).toBeLessThanOrEqual(500);
  });
});

// --- bounding ---------------------------------------------------------------

describe("bounding", () => {
  it("bounds at 50 routes", () => {
    const router = new AnswerRouter();
    for (let i = 0; i < 55; i++) {
      router.routeAnswer(`Answer ${i}`, 1, 1, i * 1000);
    }

    expect(router.size).toBe(50);
  });

  it("returns null when at capacity", () => {
    const router = new AnswerRouter();
    for (let i = 0; i < 50; i++) {
      router.routeAnswer(`Answer ${i}`, 1, 1, i * 1000);
    }

    const result = router.routeAnswer("One more", 1, 1);
    expect(result).toBeNull();
  });
});

// --- pending/consumed tracking ----------------------------------------------

describe("pending/consumed tracking", () => {
  it("tracks pending routes", () => {
    const router = new AnswerRouter();
    router.routeAnswer("Answer 1", 1, 1, 1000);
    router.routeAnswer("Answer 2", 1, 1, 2000);

    expect(router.pendingCount).toBe(2);
    expect(router.getPendingAnswerRoutes()).toHaveLength(2);
  });

  it("consumes an answer route", () => {
    const router = new AnswerRouter();
    const route = router.routeAnswer("Answer 1", 1, 1, 1000);
    const consumed = router.consumeAnswer(route!.id, 5000);

    expect(consumed).not.toBeNull();
    expect(consumed!.consumed).toBe(true);
    expect(consumed!.consumedAt).toBe(5000);
    expect(router.pendingCount).toBe(0);
  });

  it("returns null when consuming already consumed route", () => {
    const router = new AnswerRouter();
    const route = router.routeAnswer("Answer 1", 1, 1, 1000);
    router.consumeAnswer(route!.id, 5000);
    const result = router.consumeAnswer(route!.id, 6000);

    expect(result).toBeNull();
  });

  it("returns null for unknown route ID", () => {
    const router = new AnswerRouter();
    expect(router.consumeAnswer("unknown")).toBeNull();
  });
});

// --- revision filtering -----------------------------------------------------

describe("getRoutesForRevision", () => {
  it("filters by revision", () => {
    const router = new AnswerRouter();
    router.routeAnswer("Rev 1 answer", 1, 1, 1000);
    router.routeAnswer("Rev 2 answer", 2, 1, 2000);
    router.routeAnswer("Another rev 1", 1, 2, 3000);

    const rev1 = router.getRoutesForRevision(1);
    expect(rev1).toHaveLength(2);

    const rev2 = router.getRoutesForRevision(2);
    expect(rev2).toHaveLength(1);
  });
});

// --- copy isolation ---------------------------------------------------------

describe("copy isolation", () => {
  it("returns copies, not references", () => {
    const router = new AnswerRouter();
    router.routeAnswer("Original", 1, 1, 1000);

    const routes = router.getPendingAnswerRoutes();
    routes[0].answerText = "Modified";

    expect(router.getPendingAnswerRoutes()[0].answerText).toBe("Original");
  });
});

// --- formatting -------------------------------------------------------------

describe("formatAnswerRouter", () => {
  it("renders pending routes", () => {
    const router = new AnswerRouter();
    router.routeAnswer("Yes, use OAuth2", 1, 1, 1000);
    router.routeAnswer("Target Node 20+", 1, 2, 2000);

    const output = formatAnswerRouter(router);
    expect(output).toContain("Answer Routes");
    expect(output).toContain("Total: 2  Pending: 2");
    expect(output).toContain("Yes, use OAuth2");
    expect(output).toContain("Target Node 20+");
    expect(output).toContain("Read-only");
  });

  it("shows no pending when all consumed", () => {
    const router = new AnswerRouter();
    const route = router.routeAnswer("Answer", 1, 1, 1000);
    router.consumeAnswer(route!.id, 5000);

    const output = formatAnswerRouter(router);
    expect(output).toContain("No pending answers");
  });

  it("is deterministic", () => {
    const router = new AnswerRouter();
    router.routeAnswer("Test", 1, 1, 1000);

    const a = formatAnswerRouter(router);
    const b = formatAnswerRouter(router);
    expect(a).toBe(b);
  });
});
