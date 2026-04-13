import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_ROOT, DEFAULT_SEED, DEFAULT_USER } from "../../base/config/identity-loader.js";
import type {
  DecisionRecord,
  DomainKnowledge,
  SharedKnowledgeEntry,
} from "../../base/types/knowledge.js";
import type { AgentMemoryEntry, AgentMemoryStore } from "../knowledge/types/agent-memory.js";
import { AgentMemoryStoreSchema } from "../knowledge/types/agent-memory.js";
import type { LearnedPattern } from "../knowledge/types/learning.js";
import type { DreamWorkflowRecord } from "../dream/dream-event-workflows.js";
import type { SoilMemoryHealthSnapshot } from "./health.js";
import { computeSoilChecksum } from "./checksum.js";
import { getDefaultSoilRootDir } from "./config.js";
import { SoilCompiler } from "./compiler.js";
import { readTextFileOrNull } from "./io.js";
import { SoilPageFrontmatterSchema, type SoilPageFrontmatter, type SoilSourceRef } from "./types.js";

const SOIL_PROJECTION_VERSION = "soil-v1";
const SOIL_PAGE_FORMAT_VERSION = "soil-page-v1";
const SOIL_COMPILED_MEMORY_SCHEMA_VERSION = "soil-compiled-memory-v1";

interface SoilProjectionOptions {
  baseDir: string;
  rootDir?: string;
  clock?: () => Date;
}

function soilRootFromBaseDir(input: SoilProjectionOptions): string {
  return input.rootDir ?? getDefaultSoilRootDir(input.baseDir);
}

function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

function sortByDate<T>(values: T[], select: (value: T) => string | undefined): T[] {
  return [...values].sort((left, right) => {
    const leftTs = select(left) ?? "";
    const rightTs = select(right) ?? "";
    return rightTs.localeCompare(leftTs);
  });
}

function trimText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function sourceRefsFromPaths(
  sourceType: SoilSourceRef["source_type"],
  paths: Array<{ sourcePath: string; sourceHash?: string; reliability?: SoilSourceRef["reliability"] }>
): SoilSourceRef[] {
  return paths.map((item) => ({
    source_type: sourceType,
    source_path: item.sourcePath,
    source_hash: item.sourceHash,
    reliability: item.reliability,
  }));
}

function watermarkFromSourceRefs(
  scope: string,
  generatedAt: string,
  sourceRefs: SoilSourceRef[],
  inputChecksums: Record<string, string>
): SoilPageFrontmatter["generation_watermark"] {
  return {
    scope,
    source_path: sourceRefs[0]?.source_path,
    source_paths: sourceRefs.map((ref) => ref.source_path),
    source_hash: sourceRefs[0]?.source_hash,
    source_hashes: sourceRefs.map((ref) => ref.source_hash).filter((value): value is string => Boolean(value)),
    generated_at: generatedAt,
    projection_version: SOIL_PROJECTION_VERSION,
    input_commit_ids: [],
    input_checksums: inputChecksums,
  };
}

function baseFrontmatter(input: {
  soilId: string;
  title: string;
  kind: SoilPageFrontmatter["kind"];
  route: SoilPageFrontmatter["route"];
  createdAt: string;
  updatedAt: string;
  generatedAt: string;
  sourceRefs: SoilSourceRef[];
  sourceTruth: SoilPageFrontmatter["source_truth"];
  renderedFrom: string;
  summary?: string;
  goalId?: string;
  taskId?: string;
  scheduleId?: string;
  decisionId?: string;
  entryId?: string;
  domain?: string;
  confidence?: number;
  priority?: number;
  inputChecksums?: Record<string, string>;
}): SoilPageFrontmatter {
  return SoilPageFrontmatterSchema.parse({
    soil_id: input.soilId,
    kind: input.kind,
    status: "confirmed",
    title: input.title,
    route: input.route,
    source: "compiled",
    version: "1",
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    generated_at: input.generatedAt,
    source_refs: input.sourceRefs,
    generation_watermark: watermarkFromSourceRefs(
      input.soilId,
      input.generatedAt,
      input.sourceRefs,
      input.inputChecksums ?? {}
    ),
    stale: false,
    manual_overlay: {
      enabled: false,
      status: "candidate",
    },
    goal_id: input.goalId,
    task_id: input.taskId,
    schedule_id: input.scheduleId,
    decision_id: input.decisionId,
    entry_id: input.entryId,
    domain: input.domain,
    confidence: input.confidence,
    priority: input.priority,
    owner: "pulseed",
    summary: input.summary,
    source_truth: input.sourceTruth,
    rendered_from: input.renderedFrom,
    import_status: "none",
    approval_status: "none",
    supersedes: [],
    page_format_version: SOIL_PAGE_FORMAT_VERSION,
  });
}

async function writeProjectedPage(input: SoilProjectionOptions, page: { frontmatter: SoilPageFrontmatter; body: string }): Promise<void> {
  await SoilCompiler.create({ rootDir: soilRootFromBaseDir(input) }, { clock: input.clock }).write(page);
}

function knowledgeEntrySection(entry: {
  entry_id: string;
  question: string;
  answer: string;
  confidence: number;
  acquired_at: string;
  tags: string[];
  sources: Array<{ type: string; reference: string; reliability: string }>;
  superseded_by: string | null;
}): string {
  const lines = [
    `## ${entry.entry_id}`,
    "",
    `- Question: ${trimText(entry.question, 240)}`,
    `- Answer: ${trimText(entry.answer, 320)}`,
    `- Confidence: ${entry.confidence}`,
    `- Acquired: ${entry.acquired_at}`,
    `- Superseded by: ${entry.superseded_by ?? "none"}`,
    `- Tags: ${entry.tags.length > 0 ? entry.tags.map((tag) => `\`${tag}\``).join(", ") : "none"}`,
    `- Sources:`,
    ...entry.sources.map((source) => `  - ${source.type}: ${source.reference} (${source.reliability})`),
    "",
  ];
  return lines.join("\n");
}

function sharedKnowledgeSection(entry: SharedKnowledgeEntry): string {
  const lines = [
    `## ${entry.entry_id}`,
    "",
    `- Question: ${trimText(entry.question, 240)}`,
    `- Answer: ${trimText(entry.answer, 320)}`,
    `- Confidence: ${entry.confidence}`,
    `- Source goals: ${entry.source_goal_ids.length > 0 ? entry.source_goal_ids.map((goalId) => `\`${goalId}\``).join(", ") : "none"}`,
    `- Domain stability: ${entry.domain_stability}`,
    `- Revalidation due: ${entry.revalidation_due_at ?? "none"}`,
    `- Tags: ${entry.tags.length > 0 ? entry.tags.map((tag) => `\`${tag}\``).join(", ") : "none"}`,
    `- Sources:`,
    ...entry.sources.map((source) => `  - ${source.type}: ${source.reference} (${source.reliability})`),
    "",
  ];
  return lines.join("\n");
}

function memoryEntrySection(entry: AgentMemoryEntry): string {
  const lines = [
    `## ${entry.id}`,
    "",
    `- Key: ${entry.key}`,
    `- Value: ${trimText(entry.value, 320)}`,
    `- Summary: ${entry.summary ? trimText(entry.summary, 240) : "none"}`,
    `- Type: ${entry.memory_type}`,
    `- Status: ${entry.status}`,
    `- Category: ${entry.category ?? "none"}`,
    `- Tags: ${entry.tags.length > 0 ? entry.tags.map((tag) => `\`${tag}\``).join(", ") : "none"}`,
    `- Created: ${entry.created_at}`,
    `- Updated: ${entry.updated_at}`,
    `- Compiled from: ${entry.compiled_from?.length ? entry.compiled_from.join(", ") : "none"}`,
    "",
  ];
  return lines.join("\n");
}

function decisionSection(record: DecisionRecord): string {
  const lines = [
    `## ${record.id}`,
    "",
    `- Timestamp: ${record.timestamp}`,
    `- Goal: ${record.goal_id}`,
    `- Goal type: ${record.goal_type}`,
    `- Strategy: ${record.strategy_id}`,
    `- Decision: ${record.decision}`,
    `- Outcome: ${record.outcome}`,
    `- Hypothesis: ${record.hypothesis ?? "none"}`,
    `- Context: gap=${record.context.gap_value}, stall=${record.context.stall_count}, cycles=${record.context.cycle_count}, trust=${record.context.trust_score}`,
    `- What worked: ${record.what_worked.length > 0 ? record.what_worked.map((item) => `\`${item}\``).join(", ") : "none"}`,
    `- What failed: ${record.what_failed.length > 0 ? record.what_failed.map((item) => `\`${item}\``).join(", ") : "none"}`,
    `- Suggested next: ${record.suggested_next.length > 0 ? record.suggested_next.map((item) => `\`${item}\``).join(", ") : "none"}`,
    "",
  ];
  return lines.join("\n");
}

async function sourceHashFromText(content: string | null): Promise<string | undefined> {
  if (content === null) {
    return undefined;
  }
  return computeSoilChecksum(content);
}

async function sourceHashFromFileOrValue(sourcePath: string, fallback: unknown): Promise<string> {
  try {
    return computeSoilChecksum(await fsp.readFile(sourcePath, "utf-8"));
  } catch {
    return computeSoilChecksum(fallback);
  }
}

function renderIndexPage(title: string, summary: string, sections: string[]): string {
  return [`# ${title}`, "", summary, "", ...sections, ""].join("\n");
}

function learnedPatternSection(pattern: LearnedPattern): string {
  const lines = [
    `## ${pattern.pattern_id}`,
    "",
    `- Type: ${pattern.type}`,
    `- Description: ${trimText(pattern.description, 360)}`,
    `- Confidence: ${pattern.confidence}`,
    `- Evidence count: ${pattern.evidence_count}`,
    `- Source goals: ${pattern.source_goal_ids.length > 0 ? pattern.source_goal_ids.map((goalId) => `\`${goalId}\``).join(", ") : "global"}`,
    `- Applicable domains: ${pattern.applicable_domains.length > 0 ? pattern.applicable_domains.map((domain) => `\`${domain}\``).join(", ") : "none"}`,
    `- Created: ${pattern.created_at}`,
    `- Last applied: ${pattern.last_applied_at ?? "none"}`,
    "",
  ];
  return lines.join("\n");
}

function dreamWorkflowSection(workflow: DreamWorkflowRecord): string {
  const scopes = workflow.applicability.scopes.length > 0
    ? workflow.applicability.scopes.map((scope) => `${scope.goal_id ?? "global"}:${scope.task_id ?? "all-tasks"}`)
    : [
        ...workflow.applicability.goal_ids.map((goalId) => `${goalId}:all-tasks`),
        ...workflow.applicability.task_ids.map((taskId) => `global:${taskId}`),
      ];
  const lines = [
    `## ${workflow.workflow_id}`,
    "",
    `- Type: ${workflow.type}`,
    `- Title: ${workflow.title}`,
    `- Description: ${trimText(workflow.description, 360)}`,
    `- Confidence: ${workflow.confidence}`,
    `- Evidence count: ${workflow.evidence_count}`,
    `- Success / failure: ${workflow.success_count} / ${workflow.failure_count}`,
    `- Scopes: ${scopes.length > 0 ? scopes.map((scope) => `\`${scope}\``).join(", ") : "global"}`,
    `- Signals: ${workflow.applicability.signals.length > 0 ? workflow.applicability.signals.map((signal) => `\`${signal}\``).join(", ") : "none"}`,
    `- Created: ${workflow.created_at}`,
    `- Updated: ${workflow.updated_at}`,
    "",
    "### Preconditions",
    "",
    ...(workflow.preconditions.length > 0 ? workflow.preconditions.map((item) => `- ${item}`) : ["- none"]),
    "",
    "### Steps",
    "",
    ...(workflow.steps.length > 0 ? workflow.steps.map((item) => `- ${item}`) : ["- none"]),
    "",
    "### Recovery",
    "",
    ...(workflow.recovery_steps.length > 0 ? workflow.recovery_steps.map((item) => `- ${item}`) : ["- none"]),
    "",
    "### Evidence",
    "",
    ...(workflow.evidence_refs.length > 0 ? workflow.evidence_refs.map((item) => `- ${item}`) : ["- none"]),
    "",
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
    `- Route IDs: ${bucket.routeIds.length > 0 ? bucket.routeIds.map((routeId) => `\`${routeId}\``).join(", ") : "none"}`,
    "",
  ]);
}

async function readIdentitySource(baseDir: string, fileName: string, fallback: string): Promise<{ content: string; sourceHash?: string }> {
  const sourcePath = path.join(baseDir, fileName);
  const existing = await readTextFileOrNull(sourcePath);
  return {
    content: existing ?? fallback,
    sourceHash: await sourceHashFromText(existing),
  };
}

export async function projectDomainKnowledgeToSoil(input: SoilProjectionOptions & { goalId: string; domainKnowledge: DomainKnowledge }): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const sourcePath = path.join(input.baseDir, "goals", input.goalId, "domain_knowledge.json");
  const sourceHash = await sourceHashFromFileOrValue(sourcePath, input.domainKnowledge);
  const sourceRefs = sourceRefsFromPaths("runtime_json", [{ sourcePath, sourceHash, reliability: "high" }]);
  const frontmatter = baseFrontmatter({
    soilId: `knowledge/domain/${input.goalId}`,
    title: `Domain knowledge: ${input.domainKnowledge.domain}`,
    kind: "knowledge",
    route: "knowledge",
    createdAt: input.domainKnowledge.last_updated,
    updatedAt: input.domainKnowledge.last_updated,
    generatedAt,
    sourceRefs,
    sourceTruth: "runtime_json",
    renderedFrom: "knowledge-manager",
    goalId: input.goalId,
    domain: input.domainKnowledge.domain,
    summary: `${input.domainKnowledge.entries.length} entries for ${input.domainKnowledge.domain}`,
    inputChecksums: { [sourcePath]: sourceHash },
  });

  const body = [
    `# Domain knowledge: ${input.domainKnowledge.domain}`,
    "",
    `- Goal: ${input.domainKnowledge.goal_id}`,
    `- Last updated: ${input.domainKnowledge.last_updated}`,
    `- Entries: ${input.domainKnowledge.entries.length}`,
    "",
    "## Entries",
    "",
    ...sortByDate(input.domainKnowledge.entries, (entry) => entry.acquired_at).map((entry) =>
      knowledgeEntrySection(entry)
    ),
  ].join("\n");

  await writeProjectedPage(input, { frontmatter, body });
}

export async function projectSharedKnowledgeToSoil(input: SoilProjectionOptions & { entries: SharedKnowledgeEntry[] }): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const sourcePath = path.join(input.baseDir, "memory", "shared-knowledge", "entries.json");
  const sourceHash = await sourceHashFromFileOrValue(sourcePath, input.entries);
  const sourceRefs = sourceRefsFromPaths("runtime_json", [{ sourcePath, sourceHash, reliability: "high" }]);
  const latestUpdatedAt = sortByDate(input.entries, (entry) => entry.acquired_at).at(0)?.acquired_at ?? generatedAt;
  const earliestCreatedAt = input.entries.map((entry) => entry.acquired_at).sort().at(0) ?? generatedAt;
  const frontmatter = baseFrontmatter({
    soilId: "knowledge/shared/index",
    title: "Shared knowledge",
    kind: "knowledge",
    route: "knowledge",
    createdAt: earliestCreatedAt,
    updatedAt: latestUpdatedAt,
    generatedAt,
    sourceRefs,
    sourceTruth: "runtime_json",
    renderedFrom: "knowledge-manager",
    domain: "shared",
    summary: `${input.entries.length} shared entries`,
    inputChecksums: { [sourcePath]: sourceHash },
  });

  const body = [
    "# Shared knowledge",
    "",
    `- Entries: ${input.entries.length}`,
    "",
    "## Entries",
    "",
    ...sortByDate(input.entries, (entry) => entry.acquired_at).map((entry) => sharedKnowledgeSection(entry)),
  ].join("\n");

  await writeProjectedPage(input, { frontmatter, body });
}

function memoryCategoryEntries(store: AgentMemoryStore): {
  preferences: AgentMemoryEntry[];
  procedures: AgentMemoryEntry[];
  lessons: AgentMemoryEntry[];
  patterns: AgentMemoryEntry[];
} {
  const preferences = store.entries.filter((entry) => entry.memory_type === "preference");
  const procedures = store.entries.filter((entry) => entry.memory_type === "procedure");
  const lessons = store.entries.filter(
    (entry) =>
      entry.status === "compiled" ||
      entry.tags.some((tag) => tag.toLowerCase().includes("lesson"))
  );
  const patterns = store.entries.filter(
    (entry) =>
      entry.memory_type === "observation" ||
      entry.tags.some((tag) => tag.toLowerCase().includes("pattern"))
  );
  return { preferences, procedures, lessons, patterns };
}

async function projectMemoryCategoryPage(
  input: SoilProjectionOptions,
  category: "preferences" | "procedures" | "lessons" | "patterns",
  entries: AgentMemoryEntry[]
): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const sourcePath = path.join(input.baseDir, "memory", "agent-memory", "entries.json");
  const sourceHash = await sourceHashFromFileOrValue(sourcePath, entries);
  const frontmatter = baseFrontmatter({
    soilId: `memory/${category}`,
    title: `${category[0].toUpperCase()}${category.slice(1)}`,
    kind: "memory",
    route: "memory",
    createdAt: entries.map((entry) => entry.created_at).sort().at(0) ?? generatedAt,
    updatedAt: entries.map((entry) => entry.updated_at).sort().at(-1) ?? generatedAt,
    generatedAt,
    sourceRefs: sourceRefsFromPaths("runtime_json", [{ sourcePath, sourceHash, reliability: "high" }]),
    sourceTruth: "runtime_json",
    renderedFrom: "memory-store",
    domain: "agent-memory",
    summary: `${entries.length} ${category} entries`,
    inputChecksums: { [sourcePath]: sourceHash },
  });
  const body = [
    `# ${category[0].toUpperCase()}${category.slice(1)}`,
    "",
    `- Entries: ${entries.length}`,
    "",
    ...sortByDate(entries, (entry) => entry.updated_at).map((entry) => memoryEntrySection(entry)),
  ].join("\n");
  await writeProjectedPage(input, { frontmatter, body });
}

export async function projectAgentMemoryToSoil(input: SoilProjectionOptions & { store: AgentMemoryStore }): Promise<void> {
  const store = AgentMemoryStoreSchema.parse(input.store);
  const generatedAt = nowIso(input.clock);
  const sourcePath = path.join(input.baseDir, "memory", "agent-memory", "entries.json");
  const sourceHash = await sourceHashFromFileOrValue(sourcePath, store);
  const sourceRefs = sourceRefsFromPaths("runtime_json", [{ sourcePath, sourceHash, reliability: "high" }]);
  const createdAt = sortByDate(store.entries, (entry) => entry.created_at).at(-1)?.created_at ?? generatedAt;
  const updatedAt = sortByDate(store.entries, (entry) => entry.updated_at).at(0)?.updated_at ?? generatedAt;
  const categories = memoryCategoryEntries(store);
  const frontmatter = baseFrontmatter({
    soilId: "memory/index",
    title: "Agent memory",
    kind: "memory",
    route: "memory",
    createdAt,
    updatedAt,
    generatedAt,
    sourceRefs,
    sourceTruth: "runtime_json",
    renderedFrom: "memory-store",
    domain: "agent-memory",
    summary: `${store.entries.length} entries`,
    inputChecksums: { [sourcePath]: sourceHash },
  });

  const body = [
    "# Agent memory",
    "",
    `- Entries: ${store.entries.length}`,
    `- Last consolidated at: ${store.last_consolidated_at ?? "none"}`,
    "",
    "## Categories",
    "",
    `- Preferences: ${categories.preferences.length}`,
    `- Procedures: ${categories.procedures.length}`,
    `- Lessons: ${categories.lessons.length}`,
    `- Patterns: ${categories.patterns.length}`,
    "",
    "## Entries",
    "",
    ...sortByDate(store.entries, (entry) => entry.updated_at).map((entry) => memoryEntrySection(entry)),
  ].join("\n");

  await writeProjectedPage(input, { frontmatter, body });
  await projectMemoryCategoryPage(input, "preferences", categories.preferences);
  await projectMemoryCategoryPage(input, "procedures", categories.procedures);
  await projectMemoryCategoryPage(input, "lessons", categories.lessons);
  await projectMemoryCategoryPage(input, "patterns", categories.patterns);
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

  const patternsFrontmatter = baseFrontmatter({
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
  });
  const patternTypes = [...new Set(learnedPatterns.map((pattern) => pattern.type))].sort();
  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...patternsFrontmatter,
      compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
    }),
    body: [
      "# Learned patterns",
      "",
      `- Patterns: ${learnedPatterns.length}`,
      `- Types: ${patternTypes.length > 0 ? patternTypes.map((type) => `\`${type}\``).join(", ") : "none"}`,
      `- Generated: ${generatedAt}`,
      "",
      "## Patterns",
      "",
      ...(learnedPatterns.length > 0 ? learnedPatterns.map((pattern) => learnedPatternSection(pattern)) : ["No learned patterns."]),
      "",
    ].join("\n"),
  });

  const workflowsFrontmatter = baseFrontmatter({
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
  });
  const workflowTypes = [...new Set(workflowRecords.map((workflow) => workflow.type))].sort();
  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...workflowsFrontmatter,
      compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
    }),
    body: [
      "# Dream workflows",
      "",
      `- Workflows: ${workflowRecords.length}`,
      `- Types: ${workflowTypes.length > 0 ? workflowTypes.map((type) => `\`${type}\``).join(", ") : "none"}`,
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
  const feedbackFrontmatter = baseFrontmatter({
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
  });
  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...feedbackFrontmatter,
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

  const healthFrontmatter = baseFrontmatter({
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
  });
  await writeProjectedPage(input, {
    frontmatter: SoilPageFrontmatterSchema.parse({
      ...healthFrontmatter,
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

function decisionSourcePath(baseDir: string, record: DecisionRecord): string {
  const safeTimestamp = record.timestamp.replace(/[:.]/g, "-");
  return path.join(baseDir, "decisions", `${record.goal_id}-${safeTimestamp}.json`);
}

export async function projectDecisionsToSoil(input: SoilProjectionOptions & { records: DecisionRecord[] }): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const records = sortByDate(input.records, (record) => record.timestamp);
  const sourceEntries = records.map((record) => {
    const sourcePath = decisionSourcePath(input.baseDir, record);
    return { sourcePath, record, reliability: "high" as const };
  });
  const sourceEntriesWithHash = await Promise.all(
    sourceEntries.map(async (entry) => ({
      sourcePath: entry.sourcePath,
      sourceHash: await sourceHashFromFileOrValue(entry.sourcePath, entry.record),
      reliability: entry.reliability,
    }))
  );
  const sourceRefs = sourceRefsFromPaths("runtime_json", sourceEntriesWithHash);
  const frontmatter = baseFrontmatter({
    soilId: "decision/recent",
    title: "Recent decisions",
    kind: "decision",
    route: "decision",
    createdAt: sortByDate(records, (record) => record.timestamp).at(-1)?.timestamp ?? generatedAt,
    updatedAt: sortByDate(records, (record) => record.timestamp).at(0)?.timestamp ?? generatedAt,
    generatedAt,
    sourceRefs,
    sourceTruth: "runtime_json",
    renderedFrom: "knowledge-decisions",
    domain: "decision",
    summary: `${records.length} records`,
    inputChecksums: Object.fromEntries(sourceEntriesWithHash.map((entry) => [entry.sourcePath, entry.sourceHash])),
  });

  const body = [
    "# Recent decisions",
    "",
    `- Records: ${records.length}`,
    "",
    "## Decisions",
    "",
    ...records.map((record) => decisionSection(record)),
  ].join("\n");

  await writeProjectedPage(input, { frontmatter, body });
}

async function projectIdentityPage(
  input: SoilProjectionOptions,
  options: {
    soilId: string;
    fileName: string;
    title: string;
    fallback: string;
    renderedFrom: string;
  }
): Promise<void> {
  const generatedAt = nowIso(input.clock);
  const sourcePath = path.join(input.baseDir, options.fileName);
  const identitySource = await readIdentitySource(input.baseDir, options.fileName, options.fallback);
  const frontmatter = baseFrontmatter({
    soilId: options.soilId,
    title: options.title,
    kind: "identity",
    route: "identity",
    createdAt: generatedAt,
    updatedAt: generatedAt,
    generatedAt,
    sourceRefs: sourceRefsFromPaths("controlled_md", [{ sourcePath, sourceHash: identitySource.sourceHash, reliability: "high" }]),
    sourceTruth: "soil",
    renderedFrom: options.renderedFrom,
    domain: "identity",
    summary: trimText(identitySource.content, 120),
    inputChecksums: identitySource.sourceHash ? { [sourcePath]: identitySource.sourceHash } : {},
  });

  await writeProjectedPage(input, {
    frontmatter,
    body: identitySource.content,
  });
}

export async function projectIdentityToSoil(input: SoilProjectionOptions): Promise<void> {
  await projectIdentityPage(input, {
    soilId: "identity/seed",
    fileName: "SEED.md",
    title: "SEED",
    fallback: DEFAULT_SEED,
    renderedFrom: "identity-loader",
  });
  await projectIdentityPage(input, {
    soilId: "identity/root",
    fileName: "ROOT.md",
    title: "ROOT",
    fallback: DEFAULT_ROOT,
    renderedFrom: "identity-loader",
  });
  await projectIdentityPage(input, {
    soilId: "identity/user",
    fileName: "USER.md",
    title: "USER",
    fallback: DEFAULT_USER,
    renderedFrom: "identity-loader",
  });
}

export async function projectSoilSystemPages(input: SoilProjectionOptions): Promise<number> {
  const generatedAt = nowIso(input.clock);
  const pages = [
    {
      soilId: "index",
      fileName: path.join("index.md"),
      title: "Soil",
      kind: "index" as const,
      route: "index" as const,
      summary: "Soil entry point",
      body: renderIndexPage("Soil", "Soil is the readable surface for runtime projections.", [
        "- `status.md` summarizes the current projection state.",
        "- `system.md` explains the read/write contract.",
        "- `knowledge/`, `memory/`, `decision/`, and `identity/` hold the projected pages.",
      ]),
    },
    {
      soilId: "status",
      fileName: path.join("status.md"),
      title: "Soil status",
      kind: "status" as const,
      route: "status" as const,
      summary: "Current Soil state",
      body: renderIndexPage("Soil status", "Current Soil state.", [
        `- Generated at: ${generatedAt}`,
        `- Root: ${soilRootFromBaseDir(input)}`,
        "- Projection pages are written atomically.",
      ]),
    },
    {
      soilId: "system",
      fileName: path.join("system.md"),
      title: "Soil system",
      kind: "health" as const,
      route: "health" as const,
      summary: "Soil projection contract",
      body: renderIndexPage("Soil system", "Soil is a write-through projection and a read-time truth surface.", [
        "- Runtime JSON remains the source for projections.",
        "- Human edits are allowed on the Soil side and are inspected separately.",
        "- Read paths should prefer Soil pages when available.",
      ]),
    },
    {
      soilId: "log",
      fileName: path.join("log.md"),
      title: "Soil log",
      kind: "timeline" as const,
      route: "timeline" as const,
      summary: "Chronological Soil mutation summary",
      body: renderIndexPage("Soil log", "Chronological record of important compiled Soil changes.", [
        `- Generated at: ${generatedAt}`,
        "- Detailed mutation history is derived from runtime truth and Dream consolidation traces.",
        "- Historical rollups should be archived by week or month before this page becomes too large.",
      ]),
    },
    {
      soilId: "health",
      fileName: path.join("health.md"),
      title: "Soil health",
      kind: "health" as const,
      route: "health" as const,
      summary: "Soil memory health summary",
      body: renderIndexPage("Soil health", "Health checks for the compiled Soil memory layer.", [
        `- Generated at: ${generatedAt}`,
        "- Stale pages: not evaluated in this projection pass.",
        "- Orphan pages: not evaluated in this projection pass.",
        "- Route health: not evaluated in this projection pass.",
        "- Schema compatibility: generated pages use soil-page-v1.",
      ]),
    },
    {
      soilId: "context-routes",
      fileName: path.join("context-routes.md"),
      title: "Soil context routes",
      kind: "operations" as const,
      route: "operations" as const,
      summary: "Deterministic context route entry point",
      body: renderIndexPage("Soil context routes", "Context routing rules for compiled Soil retrieval.", [
        "- Route records map target paths, goals, task categories, and phases to Soil pages or records.",
        "- Fallback search is secondary and must pass an admission gate before entering context.",
        "- Broad route expansion should be versioned, logged, and evaluated before becoming active.",
      ]),
    },
    {
      soilId: "lifecycle/archive",
      fileName: path.join("lifecycle", "archive.md"),
      title: "Soil lifecycle archive",
      kind: "status" as const,
      route: "health" as const,
      summary: "Lifecycle and archive summary",
      body: renderIndexPage("Soil lifecycle archive", "Summary of long-lived memory lifecycle states.", [
        `- Generated at: ${generatedAt}`,
        "- Active: not evaluated in this projection pass.",
        "- Deprecated: not evaluated in this projection pass.",
        "- Superseded: not evaluated in this projection pass.",
        "- Archived: not evaluated in this projection pass.",
        "- Tombstoned: not evaluated in this projection pass.",
      ]),
    },
  ];

  for (const page of pages) {
    const frontmatter = baseFrontmatter({
      soilId: page.soilId,
      title: page.title,
      kind: page.kind,
      route: page.route,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      generatedAt,
      sourceRefs: [],
      sourceTruth: "soil",
      renderedFrom: "soil-system-pages",
      summary: page.summary,
    });
    await writeProjectedPage(input, {
      frontmatter: SoilPageFrontmatterSchema.parse({
        ...frontmatter,
        compiled_memory_schema: SOIL_COMPILED_MEMORY_SCHEMA_VERSION,
      }),
      body: page.body,
    });
  }
  return pages.length;
}
