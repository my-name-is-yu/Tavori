import * as path from "node:path";
import type { DreamWorkflowRecord } from "../dream/dream-event-workflows.js";
import type { LearnedPattern } from "../knowledge/types/learning.js";
import type { SoilMemoryHealthSnapshot } from "./health.js";
import {
  baseFrontmatter,
  nowIso,
  SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
  sortByDate,
  sourceHashFromFileOrValue,
  sourceRefsFromPaths,
  trimText,
  type SoilProjectionOptions,
  writeProjectedPage,
} from "./projection-support.js";
import { SoilPageFrontmatterSchema } from "./types.js";

function bulletList(values: string[], emptyLabel: string): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(", ") : emptyLabel;
}

function learnedPatternSection(pattern: LearnedPattern): string {
  const lines = [
    `## ${pattern.pattern_id}`,
    "",
    `- Type: ${pattern.type}`,
    `- Description: ${trimText(pattern.description, 360)}`,
    `- Confidence: ${pattern.confidence}`,
    `- Evidence count: ${pattern.evidence_count}`,
    `- Source goals: ${bulletList(pattern.source_goal_ids, "global")}`,
    `- Applicable domains: ${bulletList(pattern.applicable_domains, "none")}`,
    `- Created: ${pattern.created_at}`,
    `- Last applied: ${pattern.last_applied_at ?? "none"}`,
    "",
  ];
  return lines.join("\n");
}

function dreamWorkflowScopes(workflow: DreamWorkflowRecord): string[] {
  if (workflow.applicability.scopes.length > 0) {
    return workflow.applicability.scopes.map((scope) => `${scope.goal_id ?? "global"}:${scope.task_id ?? "all-tasks"}`);
  }
  return [
    ...workflow.applicability.goal_ids.map((goalId) => `${goalId}:all-tasks`),
    ...workflow.applicability.task_ids.map((taskId) => `global:${taskId}`),
  ];
}

function sectionList(title: string, items: string[]): string[] {
  return [title, "", ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- none"]), ""];
}

function dreamWorkflowSection(workflow: DreamWorkflowRecord): string {
  const scopes = dreamWorkflowScopes(workflow);
  const lines = [
    `## ${workflow.workflow_id}`,
    "",
    `- Type: ${workflow.type}`,
    `- Title: ${workflow.title}`,
    `- Description: ${trimText(workflow.description, 360)}`,
    `- Confidence: ${workflow.confidence}`,
    `- Evidence count: ${workflow.evidence_count}`,
    `- Success / failure: ${workflow.success_count} / ${workflow.failure_count}`,
    `- Scopes: ${bulletList(scopes, "global")}`,
    `- Signals: ${bulletList(workflow.applicability.signals, "none")}`,
    `- Created: ${workflow.created_at}`,
    `- Updated: ${workflow.updated_at}`,
    "",
    ...sectionList("### Preconditions", workflow.preconditions),
    ...sectionList("### Steps", workflow.steps),
    ...sectionList("### Recovery", workflow.recovery_steps),
    ...sectionList("### Evidence", workflow.evidence_refs),
  ];
  return lines.join("\n");
}

function healthFindingSection(snapshot: SoilMemoryHealthSnapshot): string[] {
  if (snapshot.findings.length === 0) {
    return ["No health findings."];
  }
  return snapshot.findings.slice(0, 50).flatMap((finding) => [
    `## ${finding.finding_id}`,
    "",
    `- Code: ${finding.code}`,
    `- Severity: ${finding.severity}`,
    `- Status: ${finding.status}`,
    `- Soil ID: ${finding.soil_id ?? "none"}`,
    `- Record ID: ${finding.record_id ?? "none"}`,
    `- Route ID: ${finding.route_id ?? "none"}`,
    `- Source path: ${finding.source_path ?? "none"}`,
    `- Message: ${trimText(finding.message, 360)}`,
    "",
  ]);
}

function compileMissBucketSection(snapshot: SoilMemoryHealthSnapshot): string[] {
  if (snapshot.compileMissBuckets.length === 0) {
    return ["No compile miss buckets."];
  }
  return snapshot.compileMissBuckets.slice(0, 50).flatMap((bucket) => [
    `## ${bucket.key}`,
    "",
    `- Count: ${bucket.count}`,
    `- Reason: ${bucket.reason}`,
    `- Target path: ${bucket.targetPath ?? "none"}`,
    `- Route IDs: ${bulletList(bucket.routeIds, "none")}`,
    "",
  ]);
}

export async function projectDreamKnowledgeToSoil(input: SoilProjectionOptions & {
  learnedPatterns: LearnedPattern[];
  workflowRecords: DreamWorkflowRecord[];
}): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const learningSourcePath = path.join(input.baseDir, "learning");
  const workflowSourcePath = path.join(input.baseDir, "dream", "workflows.json");
  const learningSourceHash = await sourceHashFromFileOrValue(learningSourcePath, input.learnedPatterns);
  const workflowSourceHash = await sourceHashFromFileOrValue(workflowSourcePath, input.workflowRecords);
  const learnedPatterns = sortByDate(input.learnedPatterns, (pattern) => pattern.created_at);
  const workflowRecords = sortByDate(input.workflowRecords, (workflow) => workflow.updated_at);

  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...baseFrontmatter({
        soilId: "learning/learned-patterns/index",
        title: "Learned patterns",
        kind: "knowledge",
        route: "knowledge",
        createdAt: learnedPatterns.at(-1)?.created_at ?? generatedAt,
        updatedAt: learnedPatterns.at(0)?.created_at ?? generatedAt,
        generatedAt,
        sourceRefs: sourceRefsFromPaths("runtime_json", [{ sourcePath: learningSourcePath, sourceHash: learningSourceHash, reliability: "high" }]),
        sourceTruth: "runtime_json",
        renderedFrom: "dream-consolidator",
        domain: "learned-patterns",
        summary: `${learnedPatterns.length} learned patterns`,
        inputChecksums: { [learningSourcePath]: learningSourceHash },
      }),
      compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
    }),
    body: [
      "# Learned patterns",
      "",
      `- Patterns: ${learnedPatterns.length}`,
      `- Types: ${bulletList([...new Set(learnedPatterns.map((pattern) => pattern.type))].sort(), "none")}`,
      `- Generated: ${generatedAt}`,
      "",
      "## Patterns",
      "",
      ...(learnedPatterns.length > 0 ? learnedPatterns.map((pattern) => learnedPatternSection(pattern)) : ["No learned patterns."]),
      "",
    ].join("\n"),
  });

  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...baseFrontmatter({
        soilId: "dream/workflows/index",
        title: "Dream workflows",
        kind: "operations",
        route: "operations",
        createdAt: workflowRecords.at(-1)?.created_at ?? generatedAt,
        updatedAt: workflowRecords.at(0)?.updated_at ?? generatedAt,
        generatedAt,
        sourceRefs: sourceRefsFromPaths("runtime_json", [{ sourcePath: workflowSourcePath, sourceHash: workflowSourceHash, reliability: "high" }]),
        sourceTruth: "runtime_json",
        renderedFrom: "dream-consolidator",
        domain: "dream-workflows",
        summary: `${workflowRecords.length} Dream workflow records`,
        inputChecksums: { [workflowSourcePath]: workflowSourceHash },
      }),
      compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
    }),
    body: [
      "# Dream workflows",
      "",
      `- Workflows: ${workflowRecords.length}`,
      `- Types: ${bulletList([...new Set(workflowRecords.map((workflow) => workflow.type))].sort(), "none")}`,
      `- Generated: ${generatedAt}`,
      "",
      "## Workflows",
      "",
      ...(workflowRecords.length > 0 ? workflowRecords.map((workflow) => dreamWorkflowSection(workflow)) : ["No Dream workflows."]),
      "",
    ].join("\n"),
  });
}

export async function projectSoilFeedbackToSoil(input: SoilProjectionOptions & {
  snapshot: SoilMemoryHealthSnapshot;
}): Promise<void> {
  const snapshot = input.snapshot;
  const generatedAt = nowIso(input.clock);
  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...baseFrontmatter({
        soilId: "feedback/context",
        title: "Soil context feedback",
        kind: "health",
        route: "health",
        createdAt: generatedAt,
        updatedAt: generatedAt,
        generatedAt,
        sourceRefs: [],
        sourceTruth: "soil",
        renderedFrom: "soil-feedback",
        domain: "context-feedback",
        summary: `${snapshot.compileMissCount} compile misses, ${snapshot.findingCount} findings`,
      }),
      compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
    }),
    body: [
      "# Soil context feedback",
      "",
      `- Generated: ${snapshot.generatedAt}`,
      `- Compile misses: ${snapshot.compileMissCount}`,
      `- Finding count: ${snapshot.findingCount}`,
      "",
      "# Compile Miss Buckets",
      "",
      ...compileMissBucketSection(snapshot),
      "# Findings",
      "",
      ...healthFindingSection(snapshot),
      "",
    ].join("\n"),
  });

  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...baseFrontmatter({
        soilId: "health",
        title: "Soil health",
        kind: "health",
        route: "health",
        createdAt: generatedAt,
        updatedAt: generatedAt,
        generatedAt,
        sourceRefs: [],
        sourceTruth: "soil",
        renderedFrom: "soil-feedback",
        domain: "soil-health",
        summary: `${snapshot.errorCount} errors, ${snapshot.warningCount} warnings`,
      }),
      compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
    }),
    body: [
      "# Soil health",
      "",
      "Health checks for the compiled Soil memory layer.",
      "",
      `- Generated: ${snapshot.generatedAt}`,
      `- Root: ${snapshot.rootDir}`,
      `- Pages: ${snapshot.totalPages}`,
      `- Findings: ${snapshot.findingCount}`,
      `- Errors: ${snapshot.errorCount}`,
      `- Warnings: ${snapshot.warningCount}`,
      `- Compile misses: ${snapshot.compileMissCount}`,
      "",
      "## Findings",
      "",
      ...healthFindingSection(snapshot),
      "",
    ].join("\n"),
  });
}
