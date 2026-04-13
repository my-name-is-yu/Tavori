import * as fsp from "node:fs/promises";
import { computeSoilChecksum } from "./checksum.js";
import { SoilCompiler } from "./compiler.js";
import { getDefaultSoilRootDir } from "./config.js";
import { SoilPageFrontmatterSchema, type SoilPageFrontmatter, type SoilSourceRef } from "./types.js";

export const SOIL_PROJECTION_VERSION = "soil-v1";
export const SOIL_PAGE_FORMAT_VERSION = "soil-page-v1";
export const SOIL_COMPILED_MEMORY_SCHEMA_VERSION = "soil-compiled-memory-v1";

export interface SoilProjectionOptions {
  baseDir: string;
  rootDir?: string;
  clock?: () => Date;
}

export function soilRootFromBaseDir(input: SoilProjectionOptions): string {
  return input.rootDir ?? getDefaultSoilRootDir(input.baseDir);
}

export function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

export function sortByDate<T>(values: T[], select: (value: T) => string | undefined): T[] {
  return [...values].sort((left, right) => {
    const leftTs = select(left) ?? "";
    const rightTs = select(right) ?? "";
    return rightTs.localeCompare(leftTs);
  });
}

export function trimText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function sourceRefsFromPaths(
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

export function baseFrontmatter(input: {
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

export async function writeProjectedPage(input: SoilProjectionOptions, page: { frontmatter: SoilPageFrontmatter; body: string }): Promise<void> {
  await SoilCompiler.create({ rootDir: soilRootFromBaseDir(input) }, { clock: input.clock }).write(page);
}

export async function sourceHashFromText(content: string | null): Promise<string | undefined> {
  if (content === null) {
    return undefined;
  }
  return computeSoilChecksum(content);
}

export async function sourceHashFromFileOrValue(sourcePath: string, fallback: unknown): Promise<string> {
  try {
    return computeSoilChecksum(await fsp.readFile(sourcePath, "utf-8"));
  } catch {
    return computeSoilChecksum(fallback);
  }
}

export function renderIndexPage(title: string, summary: string, sections: string[]): string {
  return [`# ${title}`, "", summary, "", ...sections, ""].join("\n");
}
