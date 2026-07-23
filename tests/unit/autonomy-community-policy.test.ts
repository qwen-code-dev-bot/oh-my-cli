import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const communityPolicy = fs.readFileSync(
  path.join(root, ".autonomy/community.yml"),
  "utf8",
);
const coordinatorContract = fs.readFileSync(
  path.join(root, ".autonomy/prompts/coordinator.md"),
  "utf8",
);
const normalizedCoordinatorContract = coordinatorContract.replace(/\s+/g, " ");

describe("community discovery governance", () => {
  it("runs every two hours with at most one hour of lateness", () => {
    expect(communityPolicy).toMatch(/^cadenceHours: 2$/m);
    expect(communityPolicy).toMatch(/^maximumLatenessHours: 1$/m);
    expect(coordinatorContract).toContain(
      "Community scanning is due every 2 hours and may be at most one hour late.",
    );
  });

  it("selects community discovery only after executable work and decomposition", () => {
    const roadmap = coordinatorContract.indexOf(
      "decompose the next dependency-ready roadmap parent",
    );
    const executable = coordinatorContract.indexOf(
      "acquire the next trusted executable Issue",
    );
    const community = coordinatorContract.indexOf("run the due community scan");

    expect(roadmap).toBeGreaterThan(-1);
    expect(executable).toBeGreaterThan(roadmap);
    expect(community).toBeGreaterThan(executable);
  });

  it("preserves a due scan until every true-idle blocker is absent", () => {
    for (const blocker of [
      "active lease",
      "resumable pull request, CI, or post-merge work",
      "pending user promotion or external intake",
      "normalized Issue awaiting activation",
      "agent-ready Issue",
      "roadmap parent awaiting decomposition",
    ]) {
      expect(normalizedCoordinatorContract).toContain(blocker);
    }
    expect(normalizedCoordinatorContract).toContain(
      "Keep a blocked due scan pending until the next truly idle coordinator tick.",
    );
  });
});
