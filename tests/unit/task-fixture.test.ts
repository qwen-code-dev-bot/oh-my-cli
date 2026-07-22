import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTaskFixture,
  readTaskFixtureFile,
  fixtureStreamProvider,
  TASK_FIXTURE_SCHEMA,
  TASK_FIXTURE_VERSION,
  SUPPORTED_TASK_FIXTURE_VERSIONS,
} from "../../src/task-fixture.js";
import type { StreamEvent, StreamProvider, Config } from "../../src/provider.js";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-task-fixture-"));
  tmpDirs.push(d);
  return d;
}
function writeFixture(obj: unknown): string {
  const p = path.join(tmpDir(), "fixture.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

const VALID = {
  schema: TASK_FIXTURE_SCHEMA,
  version: 1,
  prompt: "do the thing",
  script: [
    { type: "tool_calls", toolCalls: [{ id: "c1", name: "write", arguments: "{\"path\":\"a.txt\",\"content\":\"hi\"}" }] },
    { type: "text", content: "done" },
  ],
};

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// Simulate a full replay: call the provider once per round until a round produces
// no tool call (the terminal text response).
async function replayAll(provider: StreamProvider): Promise<StreamEvent[][]> {
  const rounds: StreamEvent[][] = [];
  const config = {} as Config;
  for (let i = 0; i < 100; i++) {
    const events = await drain(provider(config, [], undefined));
    rounds.push(events);
    if (!events.some((e) => e.type === "tool_call")) break;
  }
  return rounds;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("parseTaskFixture", () => {
  it("parses a valid fixture with tool_calls and text steps", () => {
    const fixture = parseTaskFixture(VALID);
    expect(fixture.version).toBe(TASK_FIXTURE_VERSION);
    expect(fixture.prompt).toBe("do the thing");
    expect(fixture.script).toHaveLength(2);
    expect(fixture.script[0].type).toBe("tool_calls");
    expect(fixture.script[0].toolCalls?.[0].name).toBe("write");
    expect(fixture.script[1]).toEqual({ type: "text", content: "done" });
    expect(SUPPORTED_TASK_FIXTURE_VERSIONS).toContain(TASK_FIXTURE_VERSION);
  });

  it("fails closed when version is missing", () => {
    const { version, ...rest } = VALID;
    void version;
    expect(() => parseTaskFixture(rest)).toThrow(/version is required/);
  });

  it("fails closed on an unsupported version", () => {
    expect(() => parseTaskFixture({ ...VALID, version: 99 })).toThrow(/not supported/);
  });

  it("fails closed on a non-object fixture", () => {
    expect(() => parseTaskFixture([])).toThrow(/must be a JSON object/);
  });

  it("fails closed on an unknown top-level key", () => {
    expect(() => parseTaskFixture({ ...VALID, extra: 1 })).toThrow(/unrecognized|unknown/i);
  });

  it("fails closed on a text step without content", () => {
    expect(() =>
      parseTaskFixture({ ...VALID, script: [{ type: "text" }] }),
    ).toThrow(/content/);
  });

  it("fails closed on a tool_calls step without toolCalls", () => {
    expect(() =>
      parseTaskFixture({ ...VALID, script: [{ type: "tool_calls" }] }),
    ).toThrow(/toolCalls/);
  });

  it("fails closed on a raw credential field at the top level", () => {
    expect(() => parseTaskFixture({ ...VALID, apiKey: "leaked" })).toThrow(/raw credential field/);
  });

  it("fails closed on a raw credential field in a step", () => {
    expect(() =>
      parseTaskFixture({ ...VALID, script: [{ type: "text", content: "x", token: "leaked" }] }),
    ).toThrow(/raw credential field/);
  });
});

describe("readTaskFixtureFile", () => {
  it("reads and parses a valid fixture file", () => {
    const p = writeFixture(VALID);
    expect(readTaskFixtureFile(p).prompt).toBe("do the thing");
  });

  it("fails closed on a missing file", () => {
    expect(() => readTaskFixtureFile(path.join(tmpDir(), "nope.json"))).toThrow(/cannot read fixture file/);
  });

  it("fails closed on invalid JSON", () => {
    const p = path.join(tmpDir(), "bad.json");
    fs.writeFileSync(p, "{ not json");
    expect(() => readTaskFixtureFile(p)).toThrow(/invalid JSON/);
  });
});

describe("fixtureStreamProvider", () => {
  it("replays scripted responses in order with deterministic usage", async () => {
    const provider = fixtureStreamProvider(parseTaskFixture(VALID));
    const rounds = await replayAll(provider);
    // Round 0: the write tool call + usage. Round 1: the final text + usage.
    expect(rounds).toHaveLength(2);
    expect(rounds[0].find((e) => e.type === "tool_call")).toMatchObject({ name: "write" });
    expect(rounds[0].find((e) => e.type === "usage")).toMatchObject({ totalTokens: 10 });
    expect(rounds[1].find((e) => e.type === "text")).toMatchObject({ delta: "done" });
  });

  it("is deterministic: two replays of the same fixture are identical", async () => {
    const fixture = parseTaskFixture(VALID);
    const a = await replayAll(fixtureStreamProvider(fixture));
    const b = await replayAll(fixtureStreamProvider(fixture));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("terminates when the script is exhausted (final empty text)", async () => {
    // A script of only tool calls would loop; the provider must yield a terminal
    // empty-text response once the script runs out so the run ends.
    const fixture = parseTaskFixture({
      version: 1,
      prompt: "loop",
      script: [{ type: "tool_calls", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] }],
    });
    const provider = fixtureStreamProvider(fixture);
    const rounds = await replayAll(provider);
    // Round 0: the read tool call. Round 1: terminal empty text (no tool call).
    expect(rounds).toHaveLength(2);
    const last = rounds[rounds.length - 1];
    expect(last.some((e) => e.type === "tool_call")).toBe(false);
    expect(last.find((e) => e.type === "text")).toMatchObject({ delta: "" });
  });
});
