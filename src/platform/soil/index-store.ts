import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { computeSoilChecksum } from "./checksum.js";
import { createSoilConfig, type SoilConfigInput } from "./config.js";
import { loadSoilManifest, type SoilPageRecord, type SoilPageStore } from "./retriever.js";
import {
  SoilGenerationWatermarkSchema,
  SoilManualOverlaySchema,
  SoilPageFrontmatterSchema,
  SoilSourceRefSchema,
  SoilSourceTruthSchema,
  type SoilGenerationWatermark,
  type SoilManualOverlay,
  type SoilSourceRef,
  type SoilSourceTruth,
} from "./types.js";

export const SOIL_INDEX_STORAGE_FORMAT = "file-json-v1" as const;

export interface SoilIndexChunkSnapshot {
  chunk_id: string;
  soil_id: string;
  relative_path: string;
  absolute_path: string;
  chunk_type: "heading" | "paragraph";
  heading_path: string[];
  heading?: string;
  position: number;
  text: string;
  token_count: number;
}

export interface SoilIndexPageSnapshot {
  soil_id: string;
  relative_path: string;
  absolute_path: string;
  title: string;
  kind: string;
  route: string;
  status: string;
  source: string;
  version: string;
  created_at: string;
  updated_at: string;
  generated_at: string;
  summary?: string;
  source_refs: SoilSourceRef[];
  generation_watermark: SoilGenerationWatermark;
  stale: boolean;
  manual_overlay: SoilManualOverlay;
  source_truth?: SoilSourceTruth;
  page_format_version?: string;
  checksum?: string;
  chunk_count: number;
}

export interface SoilIndexRetrievalRun {
  query: string;
  limit: number;
  generated_at: string;
  hit_count: number;
}

export interface SoilIndexSnapshot {
  storage: typeof SOIL_INDEX_STORAGE_FORMAT;
  root_dir: string;
  index_path: string;
  generated_at: string;
  source_manifest_checksum: string;
  page_count: number;
  chunk_count: number;
  pages: SoilIndexPageSnapshot[];
  chunks: SoilIndexChunkSnapshot[];
  retrieval_runs: SoilIndexRetrievalRun[];
}

export interface SoilIndexQueryHit {
  soil_id: string;
  relative_path: string;
  absolute_path: string;
  title: string;
  kind: string;
  route: string;
  status: string;
  summary?: string;
  score: number;
  snippet: string;
  chunk_count: number;
  checksum?: string;
}

export interface SoilIndexBuildOptions {
  clock?: () => Date;
  store?: SoilPageStore;
}

export interface SoilIndexFreshnessReport {
  fresh: boolean;
  reason: "missing-index" | "manifest-checksum-mismatch" | "page-count-mismatch" | "fresh";
  indexPath: string;
  indexedManifestChecksum?: string;
  currentManifestChecksum?: string;
  indexedPageCount?: number;
  currentPageCount?: number;
}

const ISO_SCHEMA = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid ISO-8601 datetime string");

const SoilIndexChunkSnapshotSchema = z.object({
  chunk_id: z.string().min(1),
  soil_id: z.string().min(1),
  relative_path: z.string().min(1),
  absolute_path: z.string().min(1),
  chunk_type: z.enum(["heading", "paragraph"]),
  heading_path: z.array(z.string().min(1)),
  heading: z.string().min(1).optional(),
  position: z.number().int().nonnegative(),
  text: z.string(),
  token_count: z.number().int().nonnegative(),
});

const SoilIndexPageSnapshotSchema = z.object({
  soil_id: z.string().min(1),
  relative_path: z.string().min(1),
  absolute_path: z.string().min(1),
  title: z.string().min(1),
  kind: z.string().min(1),
  route: z.string().min(1),
  status: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
  created_at: ISO_SCHEMA,
  updated_at: ISO_SCHEMA,
  generated_at: ISO_SCHEMA,
  summary: z.string().optional(),
  source_refs: z.array(SoilSourceRefSchema).default([]),
  generation_watermark: SoilGenerationWatermarkSchema,
  stale: z.boolean(),
  manual_overlay: SoilManualOverlaySchema,
  source_truth: SoilSourceTruthSchema.optional(),
  page_format_version: z.string().optional(),
  checksum: z.string().optional(),
  chunk_count: z.number().int().nonnegative(),
});

const SoilIndexRetrievalRunSchema = z.object({
  query: z.string(),
  limit: z.number().int(),
  generated_at: ISO_SCHEMA,
  hit_count: z.number().int().nonnegative(),
});

const SoilIndexSnapshotSchema = z.object({
  storage: z.literal(SOIL_INDEX_STORAGE_FORMAT),
  root_dir: z.string().min(1),
  index_path: z.string().min(1),
  generated_at: ISO_SCHEMA,
  source_manifest_checksum: z.string().min(1),
  page_count: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  pages: z.array(SoilIndexPageSnapshotSchema),
  chunks: z.array(SoilIndexChunkSnapshotSchema),
  retrieval_runs: z.array(SoilIndexRetrievalRunSchema).default([]),
});

function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index >= 0) {
    index = haystack.indexOf(needle, index);
    if (index >= 0) {
      count += 1;
      index += needle.length;
    }
  }
  return count;
}

function stableSortPages(items: SoilPageRecord[]): SoilPageRecord[] {
  return [...items].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function stableSortChunks(chunks: SoilIndexChunkSnapshot[]): SoilIndexChunkSnapshot[] {
  return [...chunks].sort(
    (left, right) =>
      left.relative_path.localeCompare(right.relative_path) ||
      left.position - right.position ||
      left.chunk_type.localeCompare(right.chunk_type)
  );
}

function withoutVolatileFields(page: SoilPageRecord): Record<string, unknown> {
  return SoilPageFrontmatterSchema.parse({
    ...page.frontmatter,
    checksum: undefined,
    generated_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
    generation_watermark: {
      ...page.frontmatter.generation_watermark,
      generated_at: "1970-01-01T00:00:00.000Z",
    },
  });
}

function buildPageChecksum(page: SoilPageRecord): string {
  return computeSoilChecksum({
    frontmatter: withoutVolatileFields(page),
    body: page.body,
  });
}

function buildPageChunks(page: SoilPageRecord): SoilIndexChunkSnapshot[] {
  const chunks: SoilIndexChunkSnapshot[] = [];
  const lines = page.body.split(/\r?\n/);
  const headingPath: string[] = [];
  const paragraphLines: string[] = [];
  let position = 0;

  const flushParagraph = (): void => {
    const text = paragraphLines.join("\n").trim();
    paragraphLines.length = 0;
    if (!text) {
      return;
    }
    const chunkPosition = position;
    position += 1;
    chunks.push({
      chunk_id: `${page.relativePath}#paragraph-${chunkPosition}`,
      soil_id: page.soilId,
      relative_path: page.relativePath,
      absolute_path: page.absolutePath,
      chunk_type: "paragraph",
      heading_path: [...headingPath],
      heading: headingPath.at(-1),
      position: chunkPosition,
      text,
      token_count: tokenize(text).length,
    });
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      flushParagraph();
      const depth = headingMatch[1].length;
      const heading = headingMatch[2].trim();
      const nextHeadingPath = headingPath.slice(0, Math.max(0, depth - 1));
      nextHeadingPath.push(heading);
      headingPath.splice(0, headingPath.length, ...nextHeadingPath);
      const chunkPosition = position;
      position += 1;
      chunks.push({
        chunk_id: `${page.relativePath}#heading-${chunkPosition}`,
        soil_id: page.soilId,
        relative_path: page.relativePath,
        absolute_path: page.absolutePath,
        chunk_type: "heading",
        heading_path: [...headingPath],
        heading,
        position: chunkPosition,
        text: heading,
        token_count: tokenize(heading).length,
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraphLines.push(line);
  }

  flushParagraph();
  return chunks;
}

function buildPageSnapshot(page: SoilPageRecord): SoilIndexPageSnapshot {
  const checksum = buildPageChecksum(page);
  const chunks = buildPageChunks(page);
  return {
    soil_id: page.soilId,
    relative_path: page.relativePath,
    absolute_path: page.absolutePath,
    title: page.frontmatter.title,
    kind: page.frontmatter.kind,
    route: page.frontmatter.route,
    status: page.frontmatter.status,
    source: page.frontmatter.source,
    version: page.frontmatter.version,
    created_at: page.frontmatter.created_at,
    updated_at: page.frontmatter.updated_at,
    generated_at: page.frontmatter.generated_at,
    summary: page.frontmatter.summary,
    source_refs: page.frontmatter.source_refs,
    generation_watermark: page.frontmatter.generation_watermark,
    stale: page.frontmatter.stale,
    manual_overlay: page.frontmatter.manual_overlay,
    source_truth: page.frontmatter.source_truth,
    page_format_version: page.frontmatter.page_format_version,
    checksum,
    chunk_count: chunks.length,
  };
}

function buildSnapshotManifestChecksum(pages: SoilIndexPageSnapshot[], chunks: SoilIndexChunkSnapshot[]): string {
  return computeSoilChecksum({
    pages: pages.map((page) => ({
      soil_id: page.soil_id,
      relative_path: page.relative_path,
      checksum: page.checksum,
      chunk_count: page.chunk_count,
    })),
    chunks: chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      soil_id: chunk.soil_id,
      relative_path: chunk.relative_path,
      position: chunk.position,
      chunk_type: chunk.chunk_type,
      token_count: chunk.token_count,
    })),
  });
}

function buildSearchText(page: SoilIndexPageSnapshot, chunks: SoilIndexChunkSnapshot[]): string {
  return [
    page.title,
    page.summary,
    page.kind,
    page.route,
    page.status,
    page.source,
    page.version,
    page.soil_id,
    page.relative_path,
    JSON.stringify(page.source_refs),
    JSON.stringify(page.generation_watermark),
    JSON.stringify(page.manual_overlay),
    JSON.stringify(page),
    ...chunks.map((chunk) => chunk.text),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function scorePage(queryTokens: string[], page: SoilIndexPageSnapshot, chunks: SoilIndexChunkSnapshot[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const metadata = buildSearchText(page, chunks);
  let score = 0;
  for (const token of queryTokens) {
    score += countOccurrences(page.title.toLowerCase(), token) * 8;
    score += countOccurrences(page.summary?.toLowerCase() ?? "", token) * 5;
    score += countOccurrences(metadata, token);
    for (const chunk of chunks) {
      score += countOccurrences(chunk.text.toLowerCase(), token) * 2;
      score += countOccurrences(chunk.heading_path.join("\n").toLowerCase(), token);
    }
  }
  return score;
}

function bestSnippet(queryTokens: string[], page: SoilIndexPageSnapshot, chunks: SoilIndexChunkSnapshot[]): string {
  const haystacks = [
    page.title,
    ...chunks.map((chunk) => `${chunk.heading ?? ""}\n${chunk.text}`),
    page.summary,
  ].filter((value): value is string => Boolean(value));
  for (const haystack of haystacks) {
    if (!haystack) {
      continue;
    }
    const lower = haystack.toLowerCase();
    for (const token of queryTokens) {
      const index = lower.indexOf(token);
      if (index >= 0) {
        const start = Math.max(0, index - 60);
        const end = Math.min(haystack.length, index + token.length + 120);
        return haystack.slice(start, end);
      }
    }
  }
  return page.summary ?? page.title;
}

export async function rebuildSoilIndex(
  configInput: SoilConfigInput = {},
  options: SoilIndexBuildOptions = {}
): Promise<SoilIndexSnapshot> {
  const config = createSoilConfig(configInput);
  const manifest = await loadSoilManifest({ rootDir: config.rootDir, indexPath: config.indexPath }, options.store);
  const generatedAt = nowIso(options.clock);

  const sortedPages = stableSortPages(manifest.pages);
  const pages = sortedPages.map((page) => buildPageSnapshot(page));
  const chunks = stableSortChunks(sortedPages.flatMap((page) => buildPageChunks(page)));
  const snapshot: SoilIndexSnapshot = SoilIndexSnapshotSchema.parse({
    storage: SOIL_INDEX_STORAGE_FORMAT,
    root_dir: config.rootDir,
    index_path: config.indexPath,
    generated_at: generatedAt,
    source_manifest_checksum: buildSnapshotManifestChecksum(pages, chunks),
    page_count: pages.length,
    chunk_count: chunks.length,
    pages,
    chunks,
    retrieval_runs: [],
  });

  await fsp.mkdir(path.dirname(config.indexPath), { recursive: true });
  await writeJsonFileAtomic(config.indexPath, snapshot);
  return snapshot;
}

export async function loadSoilIndexSnapshot(
  configInput: SoilConfigInput = {}
): Promise<SoilIndexSnapshot | null> {
  const config = createSoilConfig(configInput);
  const raw = await readJsonFileOrNull(config.indexPath);
  if (raw === null) {
    return null;
  }
  const parsed = SoilIndexSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export async function checkSoilIndexFresh(
  configInput: SoilConfigInput = {},
  options: Pick<SoilIndexBuildOptions, "store"> = {}
): Promise<SoilIndexFreshnessReport> {
  const config = createSoilConfig(configInput);
  const snapshot = await loadSoilIndexSnapshot(config);
  if (snapshot === null) {
    return {
      fresh: false,
      reason: "missing-index",
      indexPath: config.indexPath,
    };
  }

  const manifest = await loadSoilManifest({ rootDir: config.rootDir, indexPath: config.indexPath }, options.store);
  const sortedPages = stableSortPages(manifest.pages);
  const pages = sortedPages.map((page) => buildPageSnapshot(page));
  const chunks = stableSortChunks(sortedPages.flatMap((page) => buildPageChunks(page)));
  const currentManifestChecksum = buildSnapshotManifestChecksum(pages, chunks);

  if (snapshot.page_count !== pages.length) {
    return {
      fresh: false,
      reason: "page-count-mismatch",
      indexPath: config.indexPath,
      indexedManifestChecksum: snapshot.source_manifest_checksum,
      currentManifestChecksum,
      indexedPageCount: snapshot.page_count,
      currentPageCount: pages.length,
    };
  }

  if (snapshot.source_manifest_checksum !== currentManifestChecksum) {
    return {
      fresh: false,
      reason: "manifest-checksum-mismatch",
      indexPath: config.indexPath,
      indexedManifestChecksum: snapshot.source_manifest_checksum,
      currentManifestChecksum,
      indexedPageCount: snapshot.page_count,
      currentPageCount: pages.length,
    };
  }

  return {
    fresh: true,
    reason: "fresh",
    indexPath: config.indexPath,
    indexedManifestChecksum: snapshot.source_manifest_checksum,
    currentManifestChecksum,
    indexedPageCount: snapshot.page_count,
    currentPageCount: pages.length,
  };
}

export async function querySoilIndexSnapshot(
  query: string,
  limit = 10,
  configInput: SoilConfigInput = {}
): Promise<SoilIndexQueryHit[]> {
  const snapshot = await loadSoilIndexSnapshot(configInput);
  if (snapshot === null || limit <= 0) {
    return [];
  }
  const queryTokens = tokenize(query);
  const sortedPages = [...snapshot.pages].sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const chunksBySoilId = new Map<string, SoilIndexChunkSnapshot[]>();
  for (const chunk of snapshot.chunks) {
    const pageChunks = chunksBySoilId.get(chunk.soil_id);
    if (pageChunks === undefined) {
      chunksBySoilId.set(chunk.soil_id, [chunk]);
      continue;
    }
    pageChunks.push(chunk);
  }
  const hits = sortedPages
    .map((page) => {
      const pageChunks = chunksBySoilId.get(page.soil_id) ?? [];
      const score = scorePage(queryTokens, page, pageChunks);
      return {
        page,
        chunks: pageChunks,
        score,
      };
    })
    .filter(({ score }) => queryTokens.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score || left.page.relative_path.localeCompare(right.page.relative_path))
    .slice(0, limit)
    .map(({ page, chunks, score }) => ({
      soil_id: page.soil_id,
      relative_path: page.relative_path,
      absolute_path: page.absolute_path,
      title: page.title,
      kind: page.kind,
      route: page.route,
      status: page.status,
      summary: page.summary,
      score,
      snippet: bestSnippet(queryTokens, page, chunks),
      chunk_count: page.chunk_count,
      checksum: page.checksum,
    }));

  return hits;
}
