import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKFLOW_CONTRACT_SCHEMA,
  WORKFLOW_CONTRACT_VERSION,
  SUPPORTED_WORKFLOW_CONTRACT_VERSIONS,
  parseWorkflowContract,
  selectWorkflowDefinition,
  resolveWorkflow,
  collectWorkflowList,
  formatWorkflowList,
} from "../../src/workflow-contract.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "omc-workflow-contract-"));
  tmpDirs.push(d);
  return d;
}

function writeSettings(obj: unknown): string {
  const p = path.join(tmpDir(), "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function missingPath(): string {
  return path.join(tmpDir(), "does-not-exist.json");
}

const VALID = {
  contractVersion: 1,
  definitions: {
    "ci-check": {
      description: "Read-only CI sequence",
      steps: [{ prompt: "List files" }, { prompt: "Summarize README" }],
    },
  },
};

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseWorkflowContract: version negotiation", () => {
  it("accepts a supported contract version with one workflow", () => {
    const contract = parseWorkflowContract(VALID);
    expect(contract.contractVersion).toBe(1);
    expect(contract.definitions).toHaveLength(1);
    expect(contract.definitions[0].name).toBe("ci-check");
    expect(contract.definitions[0].steps).toHaveLength(2);
    expect(SUPPORTED_WORKFLOW_CONTRACT_VERSIONS).toContain(WORKFLOW_CONTRACT_VERSION);
  });

  it("fails closed when contractVersion is missing", () => {
    expect(() => parseWorkflowContract({ definitions: VALID.definitions })).toThrow(
      /contractVersion is required/,
    );
  });

  it("rejects a non-integer contractVersion", () => {
    expect(() =>
      parseWorkflowContract({ contractVersion: "1", definitions: VALID.definitions }),
    ).toThrow(/contractVersion must be an integer/);
  });

  it("fails closed on an unsupported contract version", () => {
    expect(() =>
      parseWorkflowContract({ contractVersion: 99, definitions: VALID.definitions }),
    ).toThrow(/workflow contract version 99 is not supported/);
  });

  it("rejects a non-object workflows section", () => {
    expect(() => parseWorkflowContract([1, 2, 3])).toThrow(/workflows must be an object/);
  });

  it("rejects an unknown envelope key (typo)", () => {
    expect(() =>
      parseWorkflowContract({ contractVersion: 1, defs: VALID.definitions }),
    ).toThrow(/unknown key "defs"/);
  });

  it("requires a definitions object with at least one workflow", () => {
    expect(() => parseWorkflowContract({ contractVersion: 1, definitions: [] })).toThrow(
      /definitions must be an object/,
    );
    expect(() => parseWorkflowContract({ contractVersion: 1, definitions: {} })).toThrow(
      /must define at least one workflow/,
    );
  });
});

describe("parseWorkflowContract: trust boundary and validation", () => {
  it("rejects a raw credential field at the workflow level, naming the workflow", () => {
    for (const field of ["apiKey", "token", "secret", "password", "key"]) {
      expect(() =>
        parseWorkflowContract({
          contractVersion: 1,
          definitions: { wf: { steps: [{ prompt: "x" }], [field]: "leaked" } },
        }),
      ).toThrow(/raw credential field/);
    }
  });

  it("rejects a raw credential field at the step level", () => {
    expect(() =>
      parseWorkflowContract({
        contractVersion: 1,
        definitions: { wf: { steps: [{ prompt: "x", token: "leaked" }] } },
      }),
    ).toThrow(/raw credential field/);
  });

  it("never echoes the raw credential value in the error", () => {
    let message = "";
    try {
      parseWorkflowContract({
        contractVersion: 1,
        definitions: { wf: { steps: [{ prompt: "x" }], apiKey: "sk-super-secret" } },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("sk-super-secret");
  });

  it("rejects malformed steps: empty array, empty prompt, and unknown step key", () => {
    expect(() =>
      parseWorkflowContract({ contractVersion: 1, definitions: { wf: { steps: [] } } }),
    ).toThrow(/steps must be a non-empty array/);
    expect(() =>
      parseWorkflowContract({ contractVersion: 1, definitions: { wf: { steps: [{ prompt: "" }] } } }),
    ).toThrow(/prompt must be a non-empty string/);
    expect(() =>
      parseWorkflowContract({
        contractVersion: 1,
        definitions: { wf: { steps: [{ prompt: "x", when: "always" }] } },
      }),
    ).toThrow(/Unrecognized key|when/);
  });

  it("rejects an invalid workflow name", () => {
    expect(() =>
      parseWorkflowContract({ contractVersion: 1, definitions: { "bad name": { steps: [{ prompt: "x" }] } } }),
    ).toThrow(/workflow name "bad name" must match/);
  });

  it("rejects an unknown workflow-level key", () => {
    expect(() =>
      parseWorkflowContract({
        contractVersion: 1,
        definitions: { wf: { steps: [{ prompt: "x" }], retries: 3 } },
      }),
    ).toThrow(/Unrecognized key|retries/);
  });
});

describe("selectWorkflowDefinition: named selection", () => {
  const contract = parseWorkflowContract({
    contractVersion: 1,
    definitions: {
      a: { steps: [{ prompt: "one" }] },
      b: { steps: [{ prompt: "two" }] },
    },
  });

  it("selects a workflow by exact name", () => {
    expect(selectWorkflowDefinition(contract, "b").name).toBe("b");
  });

  it("rejects an unknown workflow name", () => {
    expect(() => selectWorkflowDefinition(contract, "ghost")).toThrow(
      /workflow "ghost" is not defined/,
    );
  });

  it("rejects an empty workflow name", () => {
    expect(() => selectWorkflowDefinition(contract, "   ")).toThrow(/non-empty string/);
  });
});

describe("collectWorkflowList: real settings file", () => {
  it("lists declared workflows sorted by name with step counts", () => {
    const settings = writeSettings({
      workflows: {
        contractVersion: 1,
        definitions: {
          zeta: { steps: [{ prompt: "z1" }, { prompt: "z2" }] },
          alpha: { description: "first", steps: [{ prompt: "a1" }] },
        },
      },
    });
    const report = collectWorkflowList({ settingsPath: settings });
    expect(report.schema).toBe(WORKFLOW_CONTRACT_SCHEMA);
    expect(report.contractVersion).toBe(1);
    expect(report.workflows.map((w) => w.name)).toEqual(["alpha", "zeta"]);
    expect(report.workflows[0].steps).toBe(1);
    expect(report.workflows[1].steps).toBe(2);
  });

  it("reports an empty inventory (no throw) when no workflows section exists", () => {
    const settings = writeSettings({ model: { name: "m", apiKeyEnv: "K" } });
    const report = collectWorkflowList({ settingsPath: settings });
    expect(report.workflows).toEqual([]);
    expect(report.contractVersion).toBe(WORKFLOW_CONTRACT_VERSION);
    expect(formatWorkflowList(report)).toContain("Workflows: (none)");
  });

  it("reports an empty inventory (no throw) when the settings file is missing", () => {
    const report = collectWorkflowList({ settingsPath: missingPath() });
    expect(report.workflows).toEqual([]);
    expect(report.contractVersion).toBe(WORKFLOW_CONTRACT_VERSION);
    expect(report.settings).toContain("(not found)");
  });

  it("still fails closed on a present-but-malformed workflows section", () => {
    const settings = writeSettings({ workflows: { contractVersion: 99, definitions: {} } });
    expect(() => collectWorkflowList({ settingsPath: settings })).toThrow(/not supported/);
  });
});

describe("resolveWorkflow: named resolution from user scope", () => {
  it("resolves a named workflow and its steps", () => {
    const settings = writeSettings({ workflows: VALID });
    const resolved = resolveWorkflow("ci-check", { settingsPath: settings });
    expect(resolved.contractVersion).toBe(1);
    expect(resolved.definition.steps.map((s) => s.prompt)).toEqual(["List files", "Summarize README"]);
    expect(resolved.settingsFound).toBe(true);
  });

  it("throws on an unknown workflow name", () => {
    const settings = writeSettings({ workflows: VALID });
    expect(() => resolveWorkflow("ghost", { settingsPath: settings })).toThrow(
      /workflow "ghost" is not defined/,
    );
  });
});

describe("formatWorkflowList: redaction", () => {
  it("shows names and step counts and redacts the home path", () => {
    const home = tmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const settingsPath = path.join(home, ".oh-my-cli", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ workflows: VALID }));
      const report = collectWorkflowList({ settingsPath });
      const out = formatWorkflowList(report);
      expect(out).toContain("ci-check");
      expect(out).toContain("2 steps");
      expect(out).toContain(WORKFLOW_CONTRACT_SCHEMA);
      expect(out).toContain("~");
      expect(out).not.toContain(home);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
