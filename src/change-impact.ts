// Read-only change-impact analysis: identifies likely consumers, tests,
// and configuration surfaces affected by a proposed file or symbol change.
//
// Impact entries expose changed file, direct dependents, bounded
// transitive dependents, associated tests, and confidence level. The
// view is read-only and never executes code, modifies files, or applies
// changes.

export const CHANGE_IMPACT_SCHEMA = "oh-my-cli.change-impact";
export const CHANGE_IMPACT_VERSION = 1;

// --- types ------------------------------------------------------------------

export type ConfidenceLevel = "high" | "medium" | "low";
export type EvidenceQuality = "import-graph" | "naming-convention" | "heuristic";

export interface DependentEntry {
  /** File path of the dependent. */
  path: string;
  /** How the dependency was detected. */
  evidence: EvidenceQuality;
  /** Confidence in the dependency. */
  confidence: ConfidenceLevel;
  /** Depth from the changed file (1 = direct). */
  depth: number;
}

export interface ImpactEntry {
  /** The file being changed. */
  changedFile: string;
  /** Direct dependents (depth 1). */
  directDependents: DependentEntry[];
  /** Transitive dependents (depth 2+), bounded. */
  transitiveDependents: DependentEntry[];
  /** Associated test files. */
  testFiles: string[];
  /** Overall confidence in the impact analysis. */
  overallConfidence: ConfidenceLevel;
  /** Total number of affected files. */
  totalAffected: number;
}

// --- dependency graph (read-only model) -------------------------------------

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_DEPENDENTS = 50;

export class DependencyGraph {
  private readonly edges = new Map<string, Set<string>>();
  private readonly testAssociations = new Map<string, string[]>();

  /** Add a dependency edge: `dependent` depends on `dependency`. */
  addEdge(dependent: string, dependency: string): void {
    if (!this.edges.has(dependency)) {
      this.edges.set(dependency, new Set());
    }
    this.edges.get(dependency)!.add(dependent);
  }

  /** Associate a test file with a source file. */
  associateTest(sourceFile: string, testFile: string): void {
    if (!this.testAssociations.has(sourceFile)) {
      this.testAssociations.set(sourceFile, []);
    }
    this.testAssociations.get(sourceFile)!.push(testFile);
  }

  /** Get direct dependents of a file. */
  getDirectDependents(file: string): string[] {
    return [...(this.edges.get(file) ?? [])];
  }

  /** Get test files associated with a file. */
  getTestFiles(file: string): string[] {
    return [...(this.testAssociations.get(file) ?? [])];
  }

  /** Analyze the impact of changing a file. */
  analyzeImpact(
    changedFile: string,
    opts: { maxDepth?: number; maxDependents?: number } = {},
  ): ImpactEntry {
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxDependents = opts.maxDependents ?? DEFAULT_MAX_DEPENDENTS;

    const directDependents: DependentEntry[] = [];
    const transitiveDependents: DependentEntry[] = [];
    const visited = new Set<string>([changedFile]);

    // BFS to find dependents at each depth.
    let currentLevel = [changedFile];
    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextLevel: string[] = [];

      for (const file of currentLevel) {
        const deps = this.getDirectDependents(file);
        for (const dep of deps) {
          if (visited.has(dep)) continue;
          visited.add(dep);

          const evidence: EvidenceQuality = depth === 1 ? "import-graph" : "heuristic";
          const confidence: ConfidenceLevel = depth === 1 ? "high" : depth === 2 ? "medium" : "low";

          const entry: DependentEntry = { path: dep, evidence, confidence, depth };

          if (depth === 1) {
            directDependents.push(entry);
          } else {
            transitiveDependents.push(entry);
          }

          nextLevel.push(dep);

          if (directDependents.length + transitiveDependents.length >= maxDependents) break;
        }
        if (directDependents.length + transitiveDependents.length >= maxDependents) break;
      }

      if (directDependents.length + transitiveDependents.length >= maxDependents) break;
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    // Collect test files for the changed file and its direct dependents.
    const testFiles = new Set<string>();
    for (const tf of this.getTestFiles(changedFile)) testFiles.add(tf);
    for (const dep of directDependents) {
      for (const tf of this.getTestFiles(dep.path)) testFiles.add(tf);
    }

    // Overall confidence: high if all direct, medium if transitive, low if heuristic only.
    const overallConfidence: ConfidenceLevel =
      directDependents.length > 0 && transitiveDependents.length === 0 ? "high" :
      directDependents.length > 0 ? "medium" : "low";

    return {
      changedFile,
      directDependents,
      transitiveDependents,
      testFiles: [...testFiles],
      overallConfidence,
      totalAffected: directDependents.length + transitiveDependents.length,
    };
  }
}

// --- formatting -------------------------------------------------------------

export function formatImpactEntry(impact: ImpactEntry): string {
  const lines: string[] = [];
  lines.push(`Change impact: ${impact.changedFile} [${impact.overallConfidence} confidence]`);
  lines.push(`Affected: ${impact.totalAffected} files  Tests: ${impact.testFiles.length}`);

  if (impact.directDependents.length > 0) {
    lines.push("");
    lines.push("Direct dependents:");
    for (const dep of impact.directDependents) {
      lines.push(`  ● ${dep.path} [${dep.evidence}, ${dep.confidence}]`);
    }
  }

  if (impact.transitiveDependents.length > 0) {
    lines.push("");
    lines.push("Transitive dependents:");
    for (const dep of impact.transitiveDependents) {
      lines.push(`  ○ ${dep.path} [depth ${dep.depth}, ${dep.confidence}]`);
    }
  }

  if (impact.testFiles.length > 0) {
    lines.push("");
    lines.push("Associated tests:");
    for (const tf of impact.testFiles) {
      lines.push(`  ▸ ${tf}`);
    }
  }

  lines.push("");
  lines.push("Read-only: no code executed, no files modified.");

  return lines.join("\n");
}
