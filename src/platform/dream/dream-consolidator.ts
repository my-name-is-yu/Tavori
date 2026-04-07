import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { Logger } from "../../runtime/logger.js";
import { DEFAULT_DREAM_CONFIG } from "./dream-config.js";
import {
  ConsolidationCategoryResultSchema,
  DreamReportSchema,
  type ConsolidationCategoryResult,
  type DreamLogConfig,
  type DreamReport,
  type DreamTier,
} from "./dream-types.js";

type DreamConsolidationCategory =
  | "memory"
  | "agentMemory"
  | "crossGoalTransfer"
  | "decisionHistory"
  | "stallHistory"
  | "sessionData"
  | "iterationLogs"
  | "gapHistory"
  | "observationLogs"
  | "reports"
  | "trustScores"
  | "strategyHistory"
  | "verificationArtifacts"
  | "archive"
  | "knowledgeOptimization";

const LIGHT_CATEGORIES: DreamConsolidationCategory[] = [
  "memory",
  "agentMemory",
  "knowledgeOptimization",
];

const DEEP_CATEGORIES: DreamConsolidationCategory[] = [
  "memory",
  "agentMemory",
  "crossGoalTransfer",
  "decisionHistory",
  "stallHistory",
  "sessionData",
  "iterationLogs",
  "gapHistory",
  "observationLogs",
  "reports",
  "trustScores",
  "strategyHistory",
  "verificationArtifacts",
  "archive",
  "knowledgeOptimization",
];

interface DreamConsolidatorDeps {
  baseDir: string;
  logger?: Logger;
  config?: Partial<DreamLogConfig["consolidation"]>;
}

export interface DreamConsolidatorRunOptions {
  tier?: DreamTier;
}

export class DreamConsolidator {
  private readonly logger?: Logger;
  private readonly config: DreamLogConfig["consolidation"];

  constructor(private readonly deps: DreamConsolidatorDeps) {
    this.logger = deps.logger;
    this.config = {
      ...DEFAULT_DREAM_CONFIG.consolidation,
      ...deps.config,
    };
  }

  async run(options: DreamConsolidatorRunOptions = {}): Promise<DreamReport> {
    const tier = options.tier ?? "deep";
    const categories = tier === "light" ? LIGHT_CATEGORIES : DEEP_CATEGORIES;
    const results: ConsolidationCategoryResult[] = [];

    for (const category of categories) {
      results.push(await this.runCategory(category, tier));
    }

    const failed = results.filter((result) => result.status === "failed").length;
    const partial = failed > 0;
    const status = failed === results.length ? "failed" : partial ? "partial" : "completed";
    const timestamp = new Date().toISOString();
    const report = DreamReportSchema.parse({
      timestamp,
      tier,
      status,
      categories: results,
      summary: this.buildSummary(tier, results, status),
    });

    await this.persistReport(report);
    return report;
  }

  private async runCategory(
    category: DreamConsolidationCategory,
    tier: DreamTier
  ): Promise<ConsolidationCategoryResult> {
    if (!this.isEnabled(category)) {
      return ConsolidationCategoryResultSchema.parse({
        category,
        status: "skipped",
        metrics: {},
        warnings: ["category disabled"],
        errors: [],
      });
    }

    try {
      const metrics = await this.collectCategoryMetrics(category, tier);
      return ConsolidationCategoryResultSchema.parse({
        category,
        status: "completed",
        metrics,
        warnings: [],
        errors: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("Dream consolidation category failed", { category, error: message });
      return ConsolidationCategoryResultSchema.parse({
        category,
        status: "failed",
        metrics: {},
        warnings: [],
        errors: [message],
      });
    }
  }

  private isEnabled(category: DreamConsolidationCategory): boolean {
    const value = this.config[category];
    return typeof value === "object" && value !== null && "enabled" in value
      ? Boolean(value.enabled)
      : true;
  }

  private async collectCategoryMetrics(
    category: DreamConsolidationCategory,
    tier: DreamTier
  ): Promise<Record<string, number>> {
    switch (category) {
      case "memory":
        return {
          goalsConsidered: await this.countGoalDirs(tier),
          latentFactsExtracted: 0,
          lessonsDistilled: 0,
          archivalItemsCollected: 0,
        };
      case "agentMemory":
        return {
          lintFindings: await this.countJsonArrayEntries("agent-memory/store.json"),
          autoAppliedConsolidations: 0,
          duplicatesMerged: 0,
        };
      case "crossGoalTransfer":
        return {
          goalPairsScanned: Math.max(0, await this.countGoalPairs()),
          candidatesFound: 0,
          transfersApplied: 0,
          transfersRejected: 0,
        };
      case "decisionHistory":
        return {
          decisionRecordsScanned: await this.countFilesNamed("decision-history.json"),
          clustersBuilt: 0,
          pivotCausesPromoted: 0,
          staleSuggestionsFlagged: 0,
        };
      case "stallHistory":
        return {
          stallEventsScanned: await this.countEventLines("StallDetected"),
          recurringLoopsDetected: 0,
          precursorsExtracted: 0,
        };
      case "sessionData":
        return {
          sessionsScanned: await this.countJsonlLines(path.join("dream", "session-logs.jsonl")),
          coldSessionsArchived: 0,
          bundlesCreated: 0,
          indexEntriesUpdated: 0,
        };
      case "iterationLogs":
        return {
          iterationLogsScanned: await this.countFilesNamed("iteration-logs.jsonl"),
          rotatedLogSegments: 0,
          archivedCompletedGoalLogs: 0,
          indexEntriesUpdated: 0,
        };
      case "gapHistory":
        return {
          goalsAnalyzed: await this.countFilesNamed("gap-history.json"),
          dimensionsModeled: 0,
          falseProgressCasesDetected: 0,
          archetypesEmitted: 0,
        };
      case "observationLogs":
        return {
          observationsScanned: await this.countFilesNamed("observations.json"),
          flakyMethodsDetected: 0,
          driftAlertsProduced: 0,
        };
      case "reports":
        return {
          reportsScanned: await this.countJsonFiles(path.join(this.deps.baseDir, "dream", "reports")),
          sequencesExtracted: 0,
          summaryReportsCreated: 0,
          lowSignalReportsCleanedUp: 0,
        };
      case "trustScores":
        return {
          trustDomainsAnalyzed: await this.countTrustDomains(),
          overrideEventsReplayed: 0,
          oscillationsDetected: 0,
          recalibrationRecommendations: 0,
        };
      case "strategyHistory":
        return {
          timelinesReconstructed: await this.countFilesNamed("strategy-history.json"),
          successfulPivotLaddersFound: 0,
          wastefulStrategyFamiliesFlagged: 0,
        };
      case "verificationArtifacts":
        return {
          artifactsScanned: await this.countVerificationArtifacts(),
          criterionFailurePatternsDetected: 0,
          verdictDistributionsComputed: 0,
        };
      case "archive":
        return {
          archivesScanned: await this.countJsonFiles(path.join(this.deps.baseDir, "archive")),
          postmortemLessonsExtracted: 0,
          solvedBeforeEntriesAdded: 0,
          reusableTemplatesEmitted: 0,
        };
      case "knowledgeOptimization":
        return {
          revalidationTasksGenerated: tier === "deep" ? 1 : 0,
          contradictionsFound: 0,
          graphEdgesInferred: 0,
          redundantEntriesMerged: 0,
        };
    }
  }

  private buildSummary(
    tier: DreamTier,
    results: ConsolidationCategoryResult[],
    status: DreamReport["status"]
  ): string {
    const completed = results.filter((result) => result.status === "completed").length;
    const failed = results.filter((result) => result.status === "failed").length;
    return `Dream consolidation (${tier}) ${status}: ${completed} categories completed, ${failed} failed.`;
  }

  private async persistReport(report: DreamReport): Promise<void> {
    const reportsDir = path.join(this.deps.baseDir, "dream", "reports");
    await fsp.mkdir(reportsDir, { recursive: true });
    const safeTimestamp = report.timestamp.replaceAll(":", "-");
    await writeJsonFileAtomic(path.join(reportsDir, `${safeTimestamp}.json`), report);
  }

  private async countGoalDirs(tier: DreamTier): Promise<number> {
    const goalsDir = path.join(this.deps.baseDir, "goals");
    const entries = await fsp.readdir(goalsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).length * (tier === "deep" ? 1 : 1);
  }

  private async countGoalPairs(): Promise<number> {
    const count = await this.countGoalDirs("deep");
    return count < 2 ? 0 : (count * (count - 1)) / 2;
  }

  private async countFilesNamed(fileName: string): Promise<number> {
    let count = 0;
    for await (const filePath of this.walk(this.deps.baseDir)) {
      if (path.basename(filePath) === fileName) {
        count += 1;
      }
    }
    return count;
  }

  private async countJsonFiles(root: string): Promise<number> {
    let count = 0;
    for await (const filePath of this.walk(root)) {
      if (filePath.endsWith(".json")) {
        count += 1;
      }
    }
    return count;
  }

  private async countJsonlLines(relativePath: string): Promise<number> {
    const filePath = path.join(this.deps.baseDir, relativePath);
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  }

  private async countJsonArrayEntries(relativePath: string): Promise<number> {
    const filePath = path.join(this.deps.baseDir, relativePath);
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  }

  private async countEventLines(eventType: string): Promise<number> {
    const dreamDir = path.join(this.deps.baseDir, "dream", "events");
    let total = 0;
    for await (const filePath of this.walk(dreamDir)) {
      if (!filePath.endsWith(".jsonl")) continue;
      const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
      total += raw
        .split(/\r?\n/)
        .filter((line) => line.includes(`"eventType":"${eventType}"`)).length;
    }
    return total;
  }

  private async countTrustDomains(): Promise<number> {
    const filePath = path.join(this.deps.baseDir, "trust-store.json");
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.keys(parsed).length;
  }

  private async countVerificationArtifacts(): Promise<number> {
    const verificationDir = path.join(this.deps.baseDir, "verification");
    let count = 0;
    for await (const _ of this.walk(verificationDir)) {
      count += 1;
    }
    return count;
  }

  private async *walk(root: string): AsyncGenerator<string> {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(fullPath);
      } else {
        yield fullPath;
      }
    }
  }
}
