import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { cosineSimilarity } from "../knowledge/embedding-client.js";
import { getDefaultSoilSqliteIndexPath, resolveSoilRootDir, type SoilConfigInput } from "./config.js";
import {
  SoilChunkSchema,
  SoilEmbeddingSchema,
  SoilMutationSchema,
  SoilPageMemberSchema,
  SoilPageSchema,
  SoilRecordFilterSchema,
  SoilRecordSchema,
  SoilSearchRequestSchema,
  type SoilCandidate,
  type SoilEmbedding,
  type SoilMutationInput,
  type SoilPage,
  type SoilPageMember,
  type SoilRecord,
  type SoilRecordFilterInput,
  type SoilRepository,
  type SoilSearchRequest,
  type SoilSearchRequestInput,
  type SoilSearchResult,
} from "./contracts.js";
import { SOIL_QUERY_BUDGETS, SOIL_SCHEMA_SQL } from "./ddl.js";

type SqliteDatabase = Database.Database;

interface SoilRowRecord {
  record_id: string;
  record_key: string;
  version: number;
  record_type: string;
  soil_id: string;
  title: string;
  summary: string | null;
  canonical_text: string;
  goal_id: string | null;
  task_id: string | null;
  status: string;
  confidence: number | null;
  importance: number | null;
  source_reliability: number | null;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_record_id: string | null;
  is_active: number;
  source_type: string;
  source_id: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface SoilRowChunk {
  chunk_id: string;
  record_id: string;
  soil_id: string;
  chunk_index: number;
  chunk_kind: string;
  heading_path_json: string;
  chunk_text: string;
  token_count: number;
  checksum: string;
  created_at: string;
}

interface SoilRowPage {
  page_id: string;
  soil_id: string;
  relative_path: string;
  route: string;
  kind: string;
  status: string;
  markdown: string;
  checksum: string;
  projected_at: string;
}

interface SoilRowPageMember {
  page_id: string;
  record_id: string;
  ordinal: number;
  role: string;
  confidence: number | null;
}

interface SoilRowEmbedding {
  chunk_id: string;
  model: string;
  embedding_version: number;
  encoding: string;
  embedding: Buffer;
  embedded_at: string;
}

function buildSnippet(text: string, query: string): string {
  const haystack = text.trim();
  if (!haystack) return "";
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = haystack.toLowerCase();
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 50);
      const end = Math.min(haystack.length, index + token.length + 100);
      return haystack.slice(start, end);
    }
  }
  return haystack.slice(0, 160);
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseReindexRecordIds(input: string): string[] {
  try {
    const payload = JSON.parse(input) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return [];
    }
    const value = (payload as Record<string, unknown>).record_ids;
    return Array.isArray(value)
      ? value.filter((recordId): recordId is string => typeof recordId === "string" && recordId.length > 0)
      : [];
  } catch {
    return [];
  }
}

function encodeEmbedding(entry: SoilEmbedding): Buffer {
  if (entry.encoding === "f32le") {
    const floats = entry.embedding instanceof Uint8Array
      ? new Float32Array(entry.embedding.buffer.slice(entry.embedding.byteOffset, entry.embedding.byteOffset + entry.embedding.byteLength))
      : Float32Array.from(entry.embedding);
    return Buffer.from(floats.buffer.slice(floats.byteOffset, floats.byteOffset + floats.byteLength));
  }
  const payload = entry.embedding instanceof Uint8Array
    ? Array.from(entry.embedding.values())
    : entry.embedding;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function decodeEmbedding(row: SoilRowEmbedding): number[] {
  if (row.encoding === "f32le") {
    const copy = row.embedding.buffer.slice(
      row.embedding.byteOffset,
      row.embedding.byteOffset + row.embedding.byteLength
    );
    return Array.from(new Float32Array(copy));
  }
  return JSON.parse(row.embedding.toString("utf8")) as number[];
}

function toRecord(row: SoilRowRecord): SoilRecord {
  return SoilRecordSchema.parse({
    ...row,
    is_active: Boolean(row.is_active),
    metadata_json: parseJsonObject(row.metadata_json),
  });
}

function toPage(row: SoilRowPage): SoilPage {
  return SoilPageSchema.parse(row);
}

function toPageMember(row: SoilRowPageMember): SoilPageMember {
  return SoilPageMemberSchema.parse(row);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function dedupeCandidates(candidates: SoilCandidate[], limit: number): SoilCandidate[] {
  const byChunkId = new Map<string, SoilCandidate>();
  for (const candidate of candidates) {
    const current = byChunkId.get(candidate.chunk_id);
    if (
      !current ||
      candidate.score > current.score ||
      (candidate.score === current.score && current.page_id === null && candidate.page_id !== null)
    ) {
      byChunkId.set(candidate.chunk_id, candidate);
    }
  }
  return [...byChunkId.values()]
    .sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id))
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function fuseCandidates(lexical: SoilCandidate[], dense: SoilCandidate[], limit: number, rrfK = 60): SoilCandidate[] {
  const byChunkId = new Map<string, SoilCandidate>();
  for (const [lane, weight, candidates] of [
    ["lexical", 1, lexical],
    ["dense", 0.85, dense],
  ] as const) {
    for (const candidate of candidates) {
      const prior = byChunkId.get(candidate.chunk_id);
      const laneScore = weight / (rrfK + candidate.rank);
      const metadata_json = {
        ...(prior?.metadata_json ?? candidate.metadata_json),
        [`${lane}_rank`]: candidate.rank,
        [`${lane}_score`]: candidate.score,
      };
      if (!prior) {
        byChunkId.set(candidate.chunk_id, {
          ...candidate,
          lane: "hybrid",
          score: laneScore,
          metadata_json,
        });
        continue;
      }
      byChunkId.set(candidate.chunk_id, {
        ...prior,
        page_id: prior.page_id ?? candidate.page_id,
        snippet: prior.snippet ?? candidate.snippet,
        score: prior.score + laneScore,
        metadata_json,
      });
    }
  }
  return [...byChunkId.values()]
    .sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id))
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function hasExplicitMetadataFilter(request: SoilSearchRequest): boolean {
  const recordFilter = request.record_filter;
  const pageFilter = request.page_filter;
  return Boolean(
    recordFilter.record_ids?.length ||
      recordFilter.record_keys?.length ||
      recordFilter.record_types?.length ||
      recordFilter.statuses?.length ||
      recordFilter.goal_ids?.length ||
      recordFilter.task_ids?.length ||
      recordFilter.source_types?.length ||
      recordFilter.source_ids?.length ||
      recordFilter.valid_at ||
      recordFilter.updated_after ||
      recordFilter.updated_before ||
      pageFilter.page_ids?.length ||
      pageFilter.soil_ids?.length ||
      pageFilter.routes?.length ||
      pageFilter.kinds?.length ||
      pageFilter.page_statuses?.length ||
      pageFilter.relative_paths?.length
  );
}

function buildRecordFilterSql(request: SoilSearchRequest, params: unknown[]): string[] {
  const clauses: string[] = [];
  const filter = request.record_filter;
  if (filter.active_only) {
    clauses.push("r.is_active = 1");
  }
  if (filter.record_ids?.length) {
    clauses.push(`r.record_id IN (${filter.record_ids.map(() => "?").join(", ")})`);
    params.push(...filter.record_ids);
  }
  if (filter.record_keys?.length) {
    clauses.push(`r.record_key IN (${filter.record_keys.map(() => "?").join(", ")})`);
    params.push(...filter.record_keys);
  }
  if (filter.record_types?.length) {
    clauses.push(`r.record_type IN (${filter.record_types.map(() => "?").join(", ")})`);
    params.push(...filter.record_types);
  }
  if (filter.statuses?.length) {
    clauses.push(`r.status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  if (filter.goal_ids?.length) {
    clauses.push(`r.goal_id IN (${filter.goal_ids.map(() => "?").join(", ")})`);
    params.push(...filter.goal_ids);
  }
  if (filter.task_ids?.length) {
    clauses.push(`r.task_id IN (${filter.task_ids.map(() => "?").join(", ")})`);
    params.push(...filter.task_ids);
  }
  if (filter.source_types?.length) {
    clauses.push(`r.source_type IN (${filter.source_types.map(() => "?").join(", ")})`);
    params.push(...filter.source_types);
  }
  if (filter.source_ids?.length) {
    clauses.push(`r.source_id IN (${filter.source_ids.map(() => "?").join(", ")})`);
    params.push(...filter.source_ids);
  }
  if (filter.valid_at) {
    clauses.push("(r.valid_from IS NULL OR r.valid_from <= ?)");
    clauses.push("(r.valid_to IS NULL OR r.valid_to > ?)");
    params.push(filter.valid_at, filter.valid_at);
  }
  if (filter.updated_after) {
    clauses.push("r.updated_at >= ?");
    params.push(filter.updated_after);
  }
  if (filter.updated_before) {
    clauses.push("r.updated_at <= ?");
    params.push(filter.updated_before);
  }
  return clauses;
}

function buildPageFilterSql(request: SoilSearchRequest, params: unknown[]): string[] {
  const clauses: string[] = [];
  const filter = request.page_filter;
  if (filter.page_ids?.length) {
    clauses.push(`p.page_id IN (${filter.page_ids.map(() => "?").join(", ")})`);
    params.push(...filter.page_ids);
  }
  if (filter.soil_ids?.length) {
    clauses.push(`p.soil_id IN (${filter.soil_ids.map(() => "?").join(", ")})`);
    params.push(...filter.soil_ids);
  }
  if (filter.routes?.length) {
    clauses.push(`p.route IN (${filter.routes.map(() => "?").join(", ")})`);
    params.push(...filter.routes);
  }
  if (filter.kinds?.length) {
    clauses.push(`p.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  if (filter.page_statuses?.length) {
    clauses.push(`p.status IN (${filter.page_statuses.map(() => "?").join(", ")})`);
    params.push(...filter.page_statuses);
  }
  if (filter.relative_paths?.length) {
    clauses.push(`p.relative_path IN (${filter.relative_paths.map(() => "?").join(", ")})`);
    params.push(...filter.relative_paths);
  }
  return clauses;
}

function buildPageExistsSql(recordIdExpr: string, request: SoilSearchRequest, params: unknown[]): string[] {
  const filter = request.page_filter;
  const pagePredicates: string[] = [];
  if (filter.page_ids?.length) {
    pagePredicates.push(`p.page_id IN (${filter.page_ids.map(() => "?").join(", ")})`);
    params.push(...filter.page_ids);
  }
  if (filter.soil_ids?.length) {
    pagePredicates.push(`p.soil_id IN (${filter.soil_ids.map(() => "?").join(", ")})`);
    params.push(...filter.soil_ids);
  }
  if (filter.routes?.length) {
    pagePredicates.push(`p.route IN (${filter.routes.map(() => "?").join(", ")})`);
    params.push(...filter.routes);
  }
  if (filter.kinds?.length) {
    pagePredicates.push(`p.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  if (filter.page_statuses?.length) {
    pagePredicates.push(`p.status IN (${filter.page_statuses.map(() => "?").join(", ")})`);
    params.push(...filter.page_statuses);
  }
  if (filter.relative_paths?.length) {
    pagePredicates.push(`p.relative_path IN (${filter.relative_paths.map(() => "?").join(", ")})`);
    params.push(...filter.relative_paths);
  }
  if (pagePredicates.length === 0) {
    return [];
  }
  return [
    `EXISTS (
      SELECT 1
      FROM soil_page_members spm
      JOIN soil_pages p ON p.page_id = spm.page_id
      WHERE spm.record_id = ${recordIdExpr}
        AND ${pagePredicates.join(" AND ")}
    )`,
  ];
}

function buildCandidatePageIdSql(recordIdExpr: string, request: SoilSearchRequest, params: unknown[]): string {
  const filter = request.page_filter;
  const pagePredicates: string[] = [];
  if (filter.page_ids?.length) {
    pagePredicates.push(`p.page_id IN (${filter.page_ids.map(() => "?").join(", ")})`);
    params.push(...filter.page_ids);
  }
  if (filter.soil_ids?.length) {
    pagePredicates.push(`p.soil_id IN (${filter.soil_ids.map(() => "?").join(", ")})`);
    params.push(...filter.soil_ids);
  }
  if (filter.routes?.length) {
    pagePredicates.push(`p.route IN (${filter.routes.map(() => "?").join(", ")})`);
    params.push(...filter.routes);
  }
  if (filter.kinds?.length) {
    pagePredicates.push(`p.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  if (filter.page_statuses?.length) {
    pagePredicates.push(`p.status IN (${filter.page_statuses.map(() => "?").join(", ")})`);
    params.push(...filter.page_statuses);
  }
  if (filter.relative_paths?.length) {
    pagePredicates.push(`p.relative_path IN (${filter.relative_paths.map(() => "?").join(", ")})`);
    params.push(...filter.relative_paths);
  }

  const baseQuery = pagePredicates.length > 0
    ? `SELECT spm.page_id
       FROM soil_page_members spm
       JOIN soil_pages p ON p.page_id = spm.page_id
       WHERE spm.record_id = ${recordIdExpr}
         AND ${pagePredicates.join(" AND ")}
       ORDER BY CASE WHEN spm.role = 'primary' THEN 0 ELSE 1 END, spm.ordinal, p.relative_path, spm.page_id
       LIMIT 1`
    : `SELECT spm.page_id
       FROM soil_page_members spm
       WHERE spm.record_id = ${recordIdExpr}
       ORDER BY CASE WHEN spm.role = 'primary' THEN 0 ELSE 1 END, spm.ordinal, spm.page_id
       LIMIT 1`;

  return `(${baseQuery})`;
}

export class SqliteSoilRepository implements SoilRepository {
  private constructor(
    private readonly db: SqliteDatabase,
    readonly dbPath: string
  ) {}

  static async create(configInput: SoilConfigInput = {}): Promise<SqliteSoilRepository> {
    const rootDir = resolveSoilRootDir(configInput.rootDir);
    const indexPath = configInput.indexPath ? path.resolve(configInput.indexPath) : getDefaultSoilSqliteIndexPath(rootDir);
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    const db = new Database(indexPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SOIL_SCHEMA_SQL);
    return new SqliteSoilRepository(db, indexPath);
  }

  close(): void {
    this.db.close();
  }

  async applyMutation(input: SoilMutationInput): Promise<void> {
    const mutation = SoilMutationSchema.parse(input);
    const contentMutatedRecordIds = new Set<string>();
    const embeddedChunkIds = new Set<string>();
    const embeddedRecordIds = new Set<string>();

    const tx = this.db.transaction(() => {
      for (const record of mutation.records) {
        if (record.is_active) {
          this.db
            .prepare("UPDATE soil_records SET is_active = 0 WHERE record_key = ? AND record_id != ? AND is_active = 1")
            .run(record.record_key, record.record_id);
        }
        this.db.prepare(`
          INSERT INTO soil_records (
            record_id, record_key, version, record_type, soil_id, title, summary, canonical_text,
            goal_id, task_id, status, confidence, importance, source_reliability,
            valid_from, valid_to, supersedes_record_id, is_active, source_type, source_id,
            metadata_json, created_at, updated_at
          ) VALUES (
            @record_id, @record_key, @version, @record_type, @soil_id, @title, @summary, @canonical_text,
            @goal_id, @task_id, @status, @confidence, @importance, @source_reliability,
            @valid_from, @valid_to, @supersedes_record_id, @is_active, @source_type, @source_id,
            @metadata_json, @created_at, @updated_at
          )
          ON CONFLICT(record_id) DO UPDATE SET
            record_key = excluded.record_key,
            version = excluded.version,
            record_type = excluded.record_type,
            soil_id = excluded.soil_id,
            title = excluded.title,
            summary = excluded.summary,
            canonical_text = excluded.canonical_text,
            goal_id = excluded.goal_id,
            task_id = excluded.task_id,
            status = excluded.status,
            confidence = excluded.confidence,
            importance = excluded.importance,
            source_reliability = excluded.source_reliability,
            valid_from = excluded.valid_from,
            valid_to = excluded.valid_to,
            supersedes_record_id = excluded.supersedes_record_id,
            is_active = excluded.is_active,
            source_type = excluded.source_type,
            source_id = excluded.source_id,
            metadata_json = excluded.metadata_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `).run({
          ...record,
          is_active: record.is_active ? 1 : 0,
          metadata_json: serializeJson(record.metadata_json),
        });
        contentMutatedRecordIds.add(record.record_id);
      }

      for (const chunk of mutation.chunks) {
        this.db.prepare(`
          INSERT INTO soil_chunks (
            chunk_id, record_id, soil_id, chunk_index, chunk_kind, heading_path_json,
            chunk_text, token_count, checksum, created_at
          ) VALUES (
            @chunk_id, @record_id, @soil_id, @chunk_index, @chunk_kind, @heading_path_json,
            @chunk_text, @token_count, @checksum, @created_at
          )
          ON CONFLICT(chunk_id) DO UPDATE SET
            record_id = excluded.record_id,
            soil_id = excluded.soil_id,
            chunk_index = excluded.chunk_index,
            chunk_kind = excluded.chunk_kind,
            heading_path_json = excluded.heading_path_json,
            chunk_text = excluded.chunk_text,
            token_count = excluded.token_count,
            checksum = excluded.checksum,
            created_at = excluded.created_at
        `).run({
          ...chunk,
          heading_path_json: serializeJson(chunk.heading_path_json),
        });
        contentMutatedRecordIds.add(chunk.record_id);
      }

      for (const page of mutation.pages) {
        this.db.prepare(`
          INSERT INTO soil_pages (
            page_id, soil_id, relative_path, route, kind, status, markdown, checksum, projected_at
          ) VALUES (
            @page_id, @soil_id, @relative_path, @route, @kind, @status, @markdown, @checksum, @projected_at
          )
          ON CONFLICT(page_id) DO UPDATE SET
            soil_id = excluded.soil_id,
            relative_path = excluded.relative_path,
            route = excluded.route,
            kind = excluded.kind,
            status = excluded.status,
            markdown = excluded.markdown,
            checksum = excluded.checksum,
            projected_at = excluded.projected_at
        `).run(page);
      }

      for (const member of mutation.page_members) {
        this.db.prepare(`
          INSERT INTO soil_page_members (page_id, record_id, ordinal, role, confidence)
          VALUES (@page_id, @record_id, @ordinal, @role, @confidence)
          ON CONFLICT(page_id, record_id, role) DO UPDATE SET
            ordinal = excluded.ordinal,
            confidence = excluded.confidence
        `).run(member);
      }

      for (const embedding of mutation.embeddings) {
        const parsed = SoilEmbeddingSchema.parse(embedding);
        this.db.prepare(`
          INSERT INTO soil_embeddings (
            chunk_id, model, embedding_version, encoding, embedding, embedded_at
          ) VALUES (
            @chunk_id, @model, @embedding_version, @encoding, @embedding, @embedded_at
          )
          ON CONFLICT(chunk_id, model, embedding_version) DO UPDATE SET
            encoding = excluded.encoding,
            embedding = excluded.embedding,
            embedded_at = excluded.embedded_at
        `).run({
          chunk_id: parsed.chunk_id,
          model: parsed.model,
          embedding_version: parsed.embedding_version,
          encoding: parsed.encoding,
          embedding: encodeEmbedding(parsed),
          embedded_at: parsed.embedded_at,
        });
        const chunk = this.db
          .prepare("SELECT record_id FROM soil_chunks WHERE chunk_id = ?")
          .get(parsed.chunk_id) as { record_id: string } | undefined;
        if (chunk) {
          embeddedChunkIds.add(parsed.chunk_id);
          embeddedRecordIds.add(chunk.record_id);
        }
      }

      for (const edge of mutation.edges) {
        this.db.prepare(`
          INSERT INTO soil_edges (src_record_id, edge_type, dst_record_id, confidence)
          VALUES (@src_record_id, @edge_type, @dst_record_id, @confidence)
          ON CONFLICT(src_record_id, edge_type, dst_record_id) DO UPDATE SET
            confidence = excluded.confidence
        `).run(edge);
      }

      for (const tombstone of mutation.tombstones) {
        this.db.prepare(`
          INSERT INTO soil_tombstones (tombstone_id, record_id, record_key, version, reason, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tombstone.record_id,
          tombstone.record_key,
          tombstone.version,
          tombstone.reason,
          tombstone.deleted_at
        );
        if (tombstone.record_id) {
          this.db
            .prepare("UPDATE soil_records SET is_active = 0 WHERE record_id = ?")
            .run(tombstone.record_id);
          contentMutatedRecordIds.add(tombstone.record_id);
        }
        if (tombstone.record_key) {
          this.db
            .prepare("UPDATE soil_records SET is_active = 0 WHERE record_key = ?")
            .run(tombstone.record_key);
          const rows = this.db
            .prepare("SELECT record_id FROM soil_records WHERE record_key = ?")
            .all(tombstone.record_key) as Array<{ record_id: string }>;
          for (const row of rows) {
            contentMutatedRecordIds.add(row.record_id);
          }
        }
      }

      this.syncFts(unique([...contentMutatedRecordIds]));
      const fullyEmbeddedRecordIds = new Set(
        unique([...embeddedRecordIds]).filter((recordId) => this.recordHasCompleteEmbeddingMutation(recordId, embeddedChunkIds))
      );
      this.completeOpenEmbeddingJobs(fullyEmbeddedRecordIds);
      if (contentMutatedRecordIds.size > 0) {
        const openEmbeddingRecordIds = new Set(this.loadOpenEmbeddingReindexRecordIds());
        const insertJob = this.db.prepare(`
          INSERT INTO soil_reindex_jobs (
            job_id, scope, reason, status, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const recordId of unique([...contentMutatedRecordIds]).filter((id) => !fullyEmbeddedRecordIds.has(id) && !openEmbeddingRecordIds.has(id))) {
          insertJob.run(
            randomUUID(),
            "embedding",
            "content mutation invalidated embeddings",
            "pending",
            JSON.stringify({ record_ids: [recordId] }),
            new Date().toISOString()
          );
        }
      }
    });

    tx();
  }

  async loadRecords(input: SoilRecordFilterInput = {}): Promise<SoilRecord[]> {
    const record_filter = SoilRecordFilterSchema.parse(input);
    const params: unknown[] = [];
    const where = buildRecordFilterSql(
      SoilSearchRequestSchema.parse({ query: "__load_records__", direct_lookup: false, record_filter }),
      params
    );
    const rows = this.db.prepare(`
      SELECT *
      FROM soil_records r
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.record_key, r.version
    `).all(...params) as SoilRowRecord[];
    return rows.map((row) => toRecord(row));
  }

  async queueReindex(recordIds: string[], reason: string): Promise<void> {
    const ids = unique(recordIds);
    if (ids.length === 0) return;
    this.db.prepare(`
      INSERT INTO soil_reindex_jobs (
        job_id, scope, reason, status, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      "embedding",
      reason,
      "pending",
      JSON.stringify({ record_ids: ids }),
      new Date().toISOString()
    );
  }

  async upsertPages(pages: SoilPage[]): Promise<void> {
    await this.applyMutation({ pages });
  }

  async replacePageMembers(pageId: string, members: SoilPageMember[]): Promise<void> {
    const parsed = members.map((member) => SoilPageMemberSchema.parse({ ...member, page_id: pageId }));
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM soil_page_members WHERE page_id = ?").run(pageId);
      for (const member of parsed) {
        this.db.prepare(`
          INSERT INTO soil_page_members (page_id, record_id, ordinal, role, confidence)
          VALUES (@page_id, @record_id, @ordinal, @role, @confidence)
        `).run(member);
      }
    });
    tx();
  }

  async lookupDirect(input: SoilSearchRequestInput): Promise<SoilSearchResult> {
    const request = SoilSearchRequestSchema.parse(input);
    if (!request.direct_lookup) {
      return { request, candidates: [] };
    }

    const pageParams: unknown[] = [request.query, request.query, request.query];
    const pageWhere = ["(soil_id = ? OR relative_path = ? OR page_id = ?)"];
    pageWhere.push(...buildPageFilterSql(request, pageParams));
    pageParams.push(request.limit);
    const pageMatches = this.db.prepare(`
      SELECT page_id, soil_id
      FROM soil_pages p
      WHERE ${pageWhere.join(" AND ")}
      LIMIT ?
    `).all(...pageParams) as Array<{ page_id: string; soil_id: string }>;

    const recordParams: unknown[] = [request.query, request.query, request.query, request.query];
    const recordWhere = ["(r.record_id = ? OR r.record_key = ? OR r.soil_id = ? OR r.source_id = ?)"];
    recordWhere.push(...buildRecordFilterSql(request, recordParams));
    recordParams.push(request.limit);
    const recordRows = this.db.prepare(`
      SELECT *
      FROM soil_records r
      WHERE ${recordWhere.join(" AND ")}
      LIMIT ?
    `).all(...recordParams) as SoilRowRecord[];

    const pageIdBySoilId = new Map<string, string>();
    for (const page of pageMatches) {
      if (!pageIdBySoilId.has(page.soil_id)) {
        pageIdBySoilId.set(page.soil_id, page.page_id);
      }
    }

    const firstChunkByRecordId = new Map<string, SoilRowChunk>();
    const recordIds = unique(recordRows.map((row) => row.record_id));
    if (recordIds.length > 0) {
      const chunkRows = this.db
        .prepare(`
          SELECT *
          FROM soil_chunks
          WHERE record_id IN (${recordIds.map(() => "?").join(", ")})
          ORDER BY record_id, chunk_index
        `)
        .all(...recordIds) as SoilRowChunk[];
      for (const chunk of chunkRows) {
        if (!firstChunkByRecordId.has(chunk.record_id)) {
          firstChunkByRecordId.set(chunk.record_id, chunk);
        }
      }
    }

    const firstPageMemberByPageId = new Map<
      string,
      { record_id: string | null; chunk_id: string | null; chunk_text: string | null }
    >();
    const pageIds = unique(pageMatches.map((page) => page.page_id));
    if (pageIds.length > 0) {
      const pageMemberRows = this.db
        .prepare(`
          SELECT spm.page_id, spm.record_id, sc.chunk_id, sc.chunk_text
          FROM soil_page_members spm
          LEFT JOIN soil_chunks sc ON sc.record_id = spm.record_id
          WHERE spm.page_id IN (${pageIds.map(() => "?").join(", ")})
          ORDER BY spm.page_id, spm.ordinal, sc.chunk_index
        `)
        .all(...pageIds) as Array<{
        page_id: string;
        record_id: string | null;
        chunk_id: string | null;
        chunk_text: string | null;
      }>;
      for (const row of pageMemberRows) {
        if (!firstPageMemberByPageId.has(row.page_id)) {
          firstPageMemberByPageId.set(row.page_id, row);
        }
      }
    }

    const candidates: SoilCandidate[] = [];
    const representedPageIds = new Set<string>();
    for (const row of recordRows) {
      const chunk = firstChunkByRecordId.get(row.record_id);
      const page_id = pageIdBySoilId.get(row.soil_id) ?? null;
      if (page_id) {
        representedPageIds.add(page_id);
      }
      candidates.push({
        chunk_id: chunk?.chunk_id ?? `record:${row.record_id}`,
        record_id: row.record_id,
        soil_id: row.soil_id,
        lane: "direct",
        rank: candidates.length + 1,
        score: 1,
        snippet: chunk ? buildSnippet(chunk.chunk_text, request.query) : row.summary ?? row.title,
        page_id,
        metadata_json: parseJsonObject(row.metadata_json),
      });
    }

    for (const page of pageMatches) {
      if (representedPageIds.has(page.page_id)) continue;
      representedPageIds.add(page.page_id);
      const member = firstPageMemberByPageId.get(page.page_id);
      candidates.push({
        chunk_id: member?.chunk_id ?? `page:${page.page_id}`,
        record_id: member?.record_id ?? `page:${page.page_id}`,
        soil_id: page.soil_id,
        lane: "direct",
        rank: candidates.length + 1,
        score: 1,
        snippet: member?.chunk_text ? buildSnippet(member.chunk_text, request.query) : page.soil_id,
        page_id: page.page_id,
        metadata_json: {},
      });
    }

    return { request, candidates: candidates.slice(0, request.limit) };
  }

  async searchHybrid(input: SoilSearchRequestInput): Promise<SoilCandidate[]> {
    const request = SoilSearchRequestSchema.parse(input);
    if (request.direct_lookup) {
      const direct = await this.lookupDirect(request);
      if (direct.candidates.length > 0) {
        return direct.candidates.slice(0, request.limit);
      }
    }

    const lexical = await this.searchLexical({ ...request, direct_lookup: false });
    if (!request.query_embedding?.length) {
      return lexical;
    }

    const lexicalRecordIds = unique(lexical.map((candidate) => candidate.record_id));
    const dense =
      lexicalRecordIds.length > 0
        ? await this.searchDense({
            ...request,
            direct_lookup: false,
            dense_candidate_record_ids: lexicalRecordIds,
          })
        : hasExplicitMetadataFilter(request)
          ? await this.searchDense({ ...request, direct_lookup: false })
          : [];

    return fuseCandidates(lexical, dense, request.limit);
  }

  async searchLexical(input: SoilSearchRequestInput): Promise<SoilCandidate[]> {
    const request = SoilSearchRequestSchema.parse(input);
    const pageIdParams: unknown[] = [];
    const pageIdSql = buildCandidatePageIdSql("r.record_id", request, pageIdParams);
    const whereParams: unknown[] = [];
    const where = ["soil_chunk_fts MATCH ?"];
    where.push(...buildRecordFilterSql(request, whereParams));
    where.push(...buildPageExistsSql("r.record_id", request, whereParams));
    const params: unknown[] = [...pageIdParams, request.query, ...whereParams, request.lexical_top_k];

    const rows = this.db.prepare(`
      SELECT
        soil_chunk_fts.chunk_id AS chunk_id,
        soil_chunk_fts.record_id AS record_id,
        soil_chunk_fts.soil_id AS soil_id,
        ${pageIdSql} AS page_id,
        r.title AS title,
        r.summary AS summary,
        sc.chunk_text AS chunk_text,
        bm25(soil_chunk_fts, 8.0, 5.0, 3.0, 1.0) AS score
      FROM soil_chunk_fts
      JOIN soil_chunks sc ON sc.chunk_id = soil_chunk_fts.chunk_id
      JOIN soil_records r ON r.record_id = soil_chunk_fts.record_id
      WHERE ${where.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `).all(...params) as Array<{
      chunk_id: string;
      record_id: string;
      soil_id: string;
      page_id: string | null;
      title: string;
      summary: string | null;
      chunk_text: string;
      score: number;
    }>;

    const candidates: SoilCandidate[] = rows.map((row, index) => ({
      chunk_id: row.chunk_id,
      record_id: row.record_id,
      soil_id: row.soil_id,
      page_id: row.page_id,
      lane: "lexical",
      rank: index + 1,
      score: -1 * row.score,
      snippet: buildSnippet(row.chunk_text, request.query),
      metadata_json: { title: row.title, summary: row.summary },
    }));
    return dedupeCandidates(candidates, request.limit);
  }

  async searchDense(input: SoilSearchRequestInput): Promise<SoilCandidate[]> {
    const request = SoilSearchRequestSchema.parse(input);
    if (!request.query_embedding?.length) {
      return [];
    }
    const pageIdParams: unknown[] = [];
    const pageIdSql = buildCandidatePageIdSql("r.record_id", request, pageIdParams);
    const params: unknown[] = [];
    const where = buildRecordFilterSql(request, params);
    where.push(...buildPageExistsSql("r.record_id", request, params));
    const denseCandidateRecordIds = request.dense_candidate_record_ids ? unique(request.dense_candidate_record_ids) : null;
    if (denseCandidateRecordIds?.length === 0) {
      return [];
    }
    if (denseCandidateRecordIds) {
      where.push(`r.record_id IN (${denseCandidateRecordIds.map(() => "?").join(", ")})`);
      params.push(...denseCandidateRecordIds);
    }
    const excludedRecordIds = this.loadOpenEmbeddingReindexRecordIds();
    if (excludedRecordIds.length > 0) {
      where.push(`r.record_id NOT IN (${excludedRecordIds.map(() => "?").join(", ")})`);
      params.push(...excludedRecordIds);
    }
    if (request.query_embedding_model) {
      where.push("se.model = ?");
      params.push(request.query_embedding_model);
    }
    where.push(`
      NOT EXISTS (
        SELECT 1
        FROM soil_embeddings newer
        WHERE newer.chunk_id = se.chunk_id
          AND newer.model = se.model
          AND newer.embedding_version > se.embedding_version
      )
    `);
    const queryParams = [...pageIdParams, ...params];
    const rows = this.db.prepare(`
      SELECT
        se.chunk_id,
        se.model,
        se.embedding_version,
        se.encoding,
        se.embedding,
        se.embedded_at,
        sc.record_id,
        sc.soil_id,
        sc.chunk_text,
        r.title,
        r.summary,
        ${pageIdSql} AS page_id
      FROM soil_embeddings se
      JOIN soil_chunks sc ON sc.chunk_id = se.chunk_id
      JOIN soil_records r ON r.record_id = sc.record_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    `).all(...queryParams) as Array<SoilRowEmbedding & {
      record_id: string;
      soil_id: string;
      chunk_text: string;
      title: string;
      summary: string | null;
      page_id: string | null;
    }>;

    const scored: Array<{ row: typeof rows[number]; similarity: number }> = [];
    for (const row of rows) {
      try {
        scored.push({
          row,
          similarity: cosineSimilarity(request.query_embedding!, decodeEmbedding(row)),
        });
      } catch {
        continue;
      }
    }
    scored.sort((left, right) => right.similarity - left.similarity);
    const candidates: SoilCandidate[] = scored.slice(0, request.dense_top_k).map(({ row, similarity }, index) => ({
      chunk_id: row.chunk_id,
      record_id: row.record_id,
      soil_id: row.soil_id,
      page_id: row.page_id,
      lane: "dense",
      rank: index + 1,
      score: similarity,
      snippet: buildSnippet(row.chunk_text, request.query),
      metadata_json: { model: row.model, embedding_version: row.embedding_version, title: row.title, summary: row.summary },
    }));
    return dedupeCandidates(candidates, request.limit);
  }

  private recordHasCompleteEmbeddingMutation(recordId: string, embeddedChunkIds: Set<string>): boolean {
    const chunks = this.db
      .prepare("SELECT chunk_id FROM soil_chunks WHERE record_id = ?")
      .all(recordId) as Array<{ chunk_id: string }>;
    return chunks.length > 0 && chunks.every((chunk) => embeddedChunkIds.has(chunk.chunk_id));
  }

  private completeOpenEmbeddingJobs(recordIds: Set<string>): void {
    if (recordIds.size === 0) return;
    const jobs = this.db.prepare(`
      SELECT job_id, payload_json
      FROM soil_reindex_jobs
      WHERE scope = 'embedding'
        AND status IN ('pending', 'running')
    `).all() as Array<{ job_id: string; payload_json: string }>;
    const complete = this.db.prepare("UPDATE soil_reindex_jobs SET status = 'completed', completed_at = ? WHERE job_id = ?");
    const completedAt = new Date().toISOString();
    for (const job of jobs) {
      const jobRecordIds = parseReindexRecordIds(job.payload_json);
      if (jobRecordIds.length > 0 && jobRecordIds.every((recordId) => recordIds.has(recordId))) {
        complete.run(completedAt, job.job_id);
      }
    }
  }

  private loadOpenEmbeddingReindexRecordIds(): string[] {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM soil_reindex_jobs
      WHERE scope = 'embedding'
        AND status IN ('pending', 'running')
    `).all() as Array<{ payload_json: string }>;
    const recordIds: string[] = [];
    for (const row of rows) {
      recordIds.push(...parseReindexRecordIds(row.payload_json));
    }
    return unique(recordIds);
  }

  async loadPagesForRecords(recordIds: string[]): Promise<Map<string, SoilPage[]>> {
    const ids = unique(recordIds);
    const result = new Map<string, SoilPage[]>();
    if (ids.length === 0) return result;
    const rows = this.db.prepare(`
      SELECT p.*, spm.record_id
      FROM soil_page_members spm
      JOIN soil_pages p ON p.page_id = spm.page_id
      WHERE spm.record_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY p.relative_path, spm.ordinal
    `).all(...ids) as Array<SoilRowPage & { record_id: string }>;
    for (const row of rows) {
      const pages = result.get(row.record_id) ?? [];
      pages.push(toPage(row));
      result.set(row.record_id, pages);
    }
    return result;
  }

  async loadPageMembers(pageIds: string[]): Promise<SoilPageMember[]> {
    const ids = unique(pageIds);
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT *
      FROM soil_page_members
      WHERE page_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY page_id, ordinal
    `).all(...ids) as SoilRowPageMember[];
    return rows.map((row) => toPageMember(row));
  }

  private syncFts(recordIds: string[]): void {
    if (recordIds.length === 0) return;
    if (recordIds.length > 0) {
      this.db.prepare(`DELETE FROM soil_chunk_fts WHERE record_id IN (${recordIds.map(() => "?").join(", ")})`).run(...recordIds);
    }

    const rows = this.db.prepare(`
      SELECT
        sc.chunk_id,
        sc.record_id,
        sc.soil_id,
        (
          SELECT spm.page_id
          FROM soil_page_members spm
          WHERE spm.record_id = r.record_id
          ORDER BY CASE WHEN spm.role = 'primary' THEN 0 ELSE 1 END, spm.ordinal, spm.page_id
          LIMIT 1
        ) AS page_id,
        r.title AS title_context,
        COALESCE(r.summary, '') AS summary_context,
        sc.heading_path_json,
      sc.chunk_text
      FROM soil_chunks sc
      JOIN soil_records r ON r.record_id = sc.record_id
      WHERE sc.record_id IN (${recordIds.map(() => "?").join(", ")})
    `).all(...recordIds) as Array<{
      chunk_id: string;
      record_id: string;
      soil_id: string;
      page_id: string | null;
      title_context: string;
      summary_context: string;
      heading_path_json: string;
      chunk_text: string;
    }>;

    const insert = this.db.prepare(`
      INSERT INTO soil_chunk_fts (
        chunk_id, record_id, soil_id, page_id, title_context, summary_context, heading_context, chunk_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.chunk_id,
        row.record_id,
        row.soil_id,
        row.page_id,
        row.title_context,
        row.summary_context,
        parseJsonArray(row.heading_path_json).join(" / "),
        row.chunk_text
      );
    }
  }
}
