import { z } from "zod";
import { SoilKindSchema, SoilRouteSchema, SoilStatusSchema } from "./types.js";

export const SoilRecordTypeSchema = z.enum([
  "fact",
  "workflow",
  "preference",
  "observation",
  "decision",
  "state",
  "identity",
  "artifact",
  "reflection",
]);
export type SoilRecordType = z.infer<typeof SoilRecordTypeSchema>;

export const SoilRecordStatusSchema = z.enum([
  "draft",
  "active",
  "candidate",
  "confirmed",
  "stale",
  "superseded",
  "expired",
  "rejected",
  "archived",
  "completed",
  "cancelled",
  "deleted",
  "unreachable",
  "replaced",
]);
export type SoilRecordStatus = z.infer<typeof SoilRecordStatusSchema>;

export const SoilChunkKindSchema = z.enum([
  "title",
  "summary",
  "heading",
  "paragraph",
  "list",
  "table",
  "quote",
  "code",
]);
export type SoilChunkKind = z.infer<typeof SoilChunkKindSchema>;

export const SoilPageMemberRoleSchema = z.enum([
  "primary",
  "supporting",
  "summary",
  "evidence",
  "related",
]);
export type SoilPageMemberRole = z.infer<typeof SoilPageMemberRoleSchema>;

export const SoilEdgeTypeSchema = z.enum([
  "supports",
  "contradicts",
  "caused_by",
  "references",
  "derived_from",
  "related_to",
  "belongs_to",
]);
export type SoilEdgeType = z.infer<typeof SoilEdgeTypeSchema>;

export const SoilEmbeddingEncodingSchema = z.enum(["json", "f32le"]);
export type SoilEmbeddingEncoding = z.infer<typeof SoilEmbeddingEncodingSchema>;

export const SoilLaneSchema = z.enum(["direct", "lexical", "dense", "hybrid", "recency", "rerank"]);
export type SoilLane = z.infer<typeof SoilLaneSchema>;

export const SoilSortDirectionSchema = z.enum(["asc", "desc"]);
export type SoilSortDirection = z.infer<typeof SoilSortDirectionSchema>;

export const SoilMemoryLifecycleStateSchema = z.enum([
  "active",
  "deprecated",
  "superseded",
  "archived",
  "tombstoned",
]);
export type SoilMemoryLifecycleState = z.infer<typeof SoilMemoryLifecycleStateSchema>;

export const SoilRecordSchema = z.object({
  record_id: z.string().min(1),
  record_key: z.string().min(1),
  version: z.number().int().positive(),
  record_type: SoilRecordTypeSchema,
  soil_id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable().default(null),
  canonical_text: z.string().min(1),
  goal_id: z.string().min(1).nullable().default(null),
  task_id: z.string().min(1).nullable().default(null),
  status: SoilRecordStatusSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  importance: z.number().min(0).max(1).nullable().default(null),
  source_reliability: z.number().min(0).max(1).nullable().default(null),
  valid_from: z.string().datetime().nullable().default(null),
  valid_to: z.string().datetime().nullable().default(null),
  supersedes_record_id: z.string().min(1).nullable().default(null),
  is_active: z.boolean().default(true),
  source_type: z.string().min(1),
  source_id: z.string().min(1),
  metadata_json: z.record(z.unknown()).default({}),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type SoilRecord = z.infer<typeof SoilRecordSchema>;

export const SoilChunkSchema = z.object({
  chunk_id: z.string().min(1),
  record_id: z.string().min(1),
  soil_id: z.string().min(1),
  chunk_index: z.number().int().nonnegative(),
  chunk_kind: SoilChunkKindSchema,
  heading_path_json: z.array(z.string()).default([]),
  chunk_text: z.string().min(1),
  token_count: z.number().int().nonnegative(),
  checksum: z.string().min(1),
  created_at: z.string().datetime(),
});
export type SoilChunk = z.infer<typeof SoilChunkSchema>;

export const SoilPageSchema = z.object({
  page_id: z.string().min(1),
  soil_id: z.string().min(1),
  relative_path: z.string().min(1),
  route: SoilRouteSchema,
  kind: SoilKindSchema,
  status: SoilStatusSchema,
  markdown: z.string(),
  checksum: z.string().min(1),
  projected_at: z.string().datetime(),
});
export type SoilPage = z.infer<typeof SoilPageSchema>;

export const SoilPageMemberSchema = z.object({
  page_id: z.string().min(1),
  record_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  role: SoilPageMemberRoleSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type SoilPageMember = z.infer<typeof SoilPageMemberSchema>;

export const SoilEmbeddingSchema = z.object({
  chunk_id: z.string().min(1),
  model: z.string().min(1),
  embedding_version: z.number().int().positive(),
  encoding: SoilEmbeddingEncodingSchema.default("json"),
  embedding: z.union([z.array(z.number()), z.instanceof(Uint8Array)]),
  embedded_at: z.string().datetime(),
});
export type SoilEmbedding = z.infer<typeof SoilEmbeddingSchema>;

export const SoilEdgeSchema = z.object({
  src_record_id: z.string().min(1),
  edge_type: SoilEdgeTypeSchema,
  dst_record_id: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type SoilEdge = z.infer<typeof SoilEdgeSchema>;

export const SoilTombstoneSchema = z.object({
  record_id: z.string().min(1).nullable().default(null),
  record_key: z.string().min(1).nullable().default(null),
  version: z.number().int().positive().nullable().default(null),
  reason: z.string().min(1),
  deleted_at: z.string().datetime(),
});
export type SoilTombstone = z.infer<typeof SoilTombstoneSchema>;

export const SoilPageFilterSchema = z.object({
  page_ids: z.array(z.string().min(1)).optional(),
  soil_ids: z.array(z.string().min(1)).optional(),
  routes: z.array(SoilRouteSchema).optional(),
  kinds: z.array(SoilKindSchema).optional(),
  page_statuses: z.array(SoilStatusSchema).optional(),
  relative_paths: z.array(z.string().min(1)).optional(),
});
export type SoilPageFilter = z.infer<typeof SoilPageFilterSchema>;

export const SoilRecordFilterSchema = z.object({
  record_ids: z.array(z.string().min(1)).optional(),
  record_keys: z.array(z.string().min(1)).optional(),
  record_types: z.array(SoilRecordTypeSchema).optional(),
  statuses: z.array(SoilRecordStatusSchema).optional(),
  goal_ids: z.array(z.string().min(1)).optional(),
  task_ids: z.array(z.string().min(1)).optional(),
  source_types: z.array(z.string().min(1)).optional(),
  source_ids: z.array(z.string().min(1)).optional(),
  active_only: z.boolean().default(true),
  valid_at: z.string().datetime().optional(),
  updated_after: z.string().datetime().optional(),
  updated_before: z.string().datetime().optional(),
});
export type SoilRecordFilter = z.infer<typeof SoilRecordFilterSchema>;
export type SoilRecordFilterInput = z.input<typeof SoilRecordFilterSchema>;

export const SoilSearchRequestSchema = z.object({
  query: z.string().min(1),
  query_embedding: z.array(z.number()).optional(),
  query_embedding_model: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  lexical_top_k: z.number().int().min(1).max(200).default(50),
  dense_top_k: z.number().int().min(1).max(200).default(50),
  rerank_top_k: z.number().int().min(1).max(100).default(20),
  dense_candidate_record_ids: z.array(z.string().min(1)).optional(),
  direct_lookup: z.boolean().default(true),
  record_filter: SoilRecordFilterSchema.default({}),
  page_filter: SoilPageFilterSchema.default({}),
});
export type SoilSearchRequest = z.infer<typeof SoilSearchRequestSchema>;
export type SoilSearchRequestInput = z.input<typeof SoilSearchRequestSchema>;

export const SoilCandidateSchema = z.object({
  chunk_id: z.string().min(1),
  record_id: z.string().min(1),
  soil_id: z.string().min(1),
  lane: SoilLaneSchema,
  rank: z.number().int().positive(),
  score: z.number(),
  snippet: z.string().nullable().default(null),
  page_id: z.string().min(1).nullable().default(null),
  metadata_json: z.record(z.unknown()).default({}),
});
export type SoilCandidate = z.infer<typeof SoilCandidateSchema>;

export const SoilSearchResultSchema = z.object({
  request: SoilSearchRequestSchema,
  candidates: z.array(SoilCandidateSchema),
});
export type SoilSearchResult = z.infer<typeof SoilSearchResultSchema>;

export const SoilContextRouteSchemaVersion = "soil-context-route-v1" as const;
export const SoilRetrievalTraceSchemaVersion = "soil-retrieval-trace-v1" as const;
export const SoilCompileMissObservationSchemaVersion = "soil-compile-miss-v1" as const;
export const SoilMemoryLintFindingSchemaVersion = "soil-memory-lint-finding-v1" as const;

export const SoilContextRouteSchema = z.object({
  schema_version: z.literal(SoilContextRouteSchemaVersion).default(SoilContextRouteSchemaVersion),
  route_id: z.string().min(1),
  status: SoilMemoryLifecycleStateSchema.default("active"),
  priority: z.number().int().default(0),
  path_globs: z.array(z.string().min(1)).default([]),
  goal_ids: z.array(z.string().min(1)).default([]),
  task_categories: z.array(z.string().min(1)).default([]),
  phases: z.array(z.string().min(1)).default([]),
  soil_ids: z.array(z.string().min(1)).default([]),
  record_ids: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  source_observation_ids: z.array(z.string().min(1)).default([]),
  last_evaluated_at: z.string().datetime().nullable().default(null),
  last_evaluation_result: z.enum(["passed", "failed", "unknown"]).default("unknown"),
});
export type SoilContextRoute = z.infer<typeof SoilContextRouteSchema>;
export type SoilContextRouteInput = z.input<typeof SoilContextRouteSchema>;

export const SoilRetrievalDecisionSchema = z.object({
  candidate_id: z.string().min(1),
  decision: z.enum(["admitted", "rejected", "routed"]),
  reason: z.string().min(1),
  score: z.number().nullable().default(null),
  soil_id: z.string().min(1).nullable().default(null),
  record_id: z.string().min(1).nullable().default(null),
  route_id: z.string().min(1).nullable().default(null),
});
export type SoilRetrievalDecision = z.infer<typeof SoilRetrievalDecisionSchema>;

export const SoilRetrievalTraceSchema = z.object({
  schema_version: z.literal(SoilRetrievalTraceSchemaVersion).default(SoilRetrievalTraceSchemaVersion),
  retrieval_id: z.string().min(1),
  timestamp: z.string().datetime(),
  task_id: z.string().min(1).nullable().default(null),
  goal_id: z.string().min(1).nullable().default(null),
  phase: z.string().min(1).nullable().default(null),
  task_category: z.string().min(1).nullable().default(null),
  target_paths: z.array(z.string().min(1)).default([]),
  fallback_query: z.string().min(1).nullable().default(null),
  decisions: z.array(SoilRetrievalDecisionSchema).default([]),
  warnings: z.array(z.string().min(1)).default([]),
});
export type SoilRetrievalTrace = z.infer<typeof SoilRetrievalTraceSchema>;

export const SoilCompileMissObservationSchema = z.object({
  schema_version: z.literal(SoilCompileMissObservationSchemaVersion).default(SoilCompileMissObservationSchemaVersion),
  observation_id: z.string().min(1),
  retrieval_id: z.string().min(1),
  reason: z.enum(["no_route", "bad_route", "stale_route", "low_confidence_search", "irrelevant_context"]),
  target_paths: z.array(z.string().min(1)).default([]),
  route_ids: z.array(z.string().min(1)).default([]),
  rejected_candidate_ids: z.array(z.string().min(1)).default([]),
  created_at: z.string().datetime(),
  notes: z.string().optional(),
});
export type SoilCompileMissObservation = z.infer<typeof SoilCompileMissObservationSchema>;

export const SoilMemoryLintFindingCodeSchema = z.enum([
  "stale_page",
  "orphan_page",
  "broken_source_ref",
  "conflicting_active_record",
  "overgrown_page",
  "stale_route",
  "missing_route",
  "broken_route_target",
  "schema_incompatible",
]);
export type SoilMemoryLintFindingCode = z.infer<typeof SoilMemoryLintFindingCodeSchema>;

export const SoilMemoryLintFindingSchema = z.object({
  schema_version: z.literal(SoilMemoryLintFindingSchemaVersion).default(SoilMemoryLintFindingSchemaVersion),
  finding_id: z.string().min(1),
  code: SoilMemoryLintFindingCodeSchema,
  severity: z.enum(["info", "warning", "error"]),
  status: z.enum(["open", "resolved", "ignored"]).default("open"),
  message: z.string().min(1),
  soil_id: z.string().min(1).nullable().default(null),
  record_id: z.string().min(1).nullable().default(null),
  route_id: z.string().min(1).nullable().default(null),
  source_path: z.string().min(1).nullable().default(null),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable().default(null),
});
export type SoilMemoryLintFinding = z.infer<typeof SoilMemoryLintFindingSchema>;

export const SoilMutationSchema = z.object({
  records: z.array(SoilRecordSchema).default([]),
  chunks: z.array(SoilChunkSchema).default([]),
  pages: z.array(SoilPageSchema).default([]),
  page_members: z.array(SoilPageMemberSchema).default([]),
  embeddings: z.array(SoilEmbeddingSchema).default([]),
  edges: z.array(SoilEdgeSchema).default([]),
  tombstones: z.array(SoilTombstoneSchema).default([]),
});
export type SoilMutation = z.infer<typeof SoilMutationSchema>;
export type SoilMutationInput = z.input<typeof SoilMutationSchema>;

export interface SoilWriteRepository {
  applyMutation(mutation: SoilMutationInput): Promise<void>;
  queueReindex(recordIds: string[], reason: string): Promise<void>;
}

export interface SoilSearchRepository {
  loadRecords(filter?: SoilRecordFilterInput): Promise<SoilRecord[]>;
  lookupDirect(request: SoilSearchRequestInput): Promise<SoilSearchResult>;
  searchHybrid(request: SoilSearchRequestInput): Promise<SoilCandidate[]>;
  searchLexical(request: SoilSearchRequestInput): Promise<SoilCandidate[]>;
  searchDense(request: SoilSearchRequestInput): Promise<SoilCandidate[]>;
  loadPagesForRecords(recordIds: string[]): Promise<Map<string, SoilPage[]>>;
  loadPageMembers(pageIds: string[]): Promise<SoilPageMember[]>;
}

export interface SoilProjectionRepository {
  upsertPages(pages: SoilPage[]): Promise<void>;
  replacePageMembers(pageId: string, members: SoilPageMember[]): Promise<void>;
}

export interface SoilRepository
  extends SoilWriteRepository, SoilSearchRepository, SoilProjectionRepository {}
