import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { readStdinWithSilenceTimeout } from "../../src/stdin-reader.js";

describe("bounded stdin reading (Issue #761)", () => {
  it("drains a pipe that delivers and closes", async () => {
    const stream = new PassThrough();
    const pending = readStdinWithSilenceTimeout(stream, 500);
    stream.write("PIPED BODY");
    stream.end();
    expect(await pending).toBe("PIPED BODY");
  });

  it("returns the empty string for an immediately closed empty pipe", async () => {
    const stream = new PassThrough();
    const pending = readStdinWithSilenceTimeout(stream, 500);
    stream.end();
    expect(await pending).toBe("");
  });

  it("resolves null when the pipe stays silent past the window", async () => {
    const stream = new PassThrough();
    const pending = readStdinWithSilenceTimeout(stream, 50);
    expect(await pending).toBeNull();
    stream.end();
  });

  it("treats a read error as silence rather than a turn failure", async () => {
    const stream = new PassThrough();
    const pending = readStdinWithSilenceTimeout(stream, 500);
    stream.destroy(new Error("flaky pipe"));
    expect(await pending).toBe("");
  });

  it("keeps data that arrives in multiple chunks verbatim", async () => {
    const stream = new PassThrough();
    const pending = readStdinWithSilenceTimeout(stream, 500);
    stream.write("line one\n");
    stream.write("line two\n");
    stream.end();
    expect(await pending).toBe("line one\nline two\n");
  });
});
