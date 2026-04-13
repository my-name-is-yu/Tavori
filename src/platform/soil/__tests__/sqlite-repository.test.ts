import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { SqliteSoilRepository } from "../sqlite-repository.js";

describe("SqliteSoilRepository", () => {
  let tmpDir: string;
  let repo: SqliteSoilRepository;

  beforeEach(async () => {
    tmpDir = makeTempDir("soil-sqlite-repo-");
    repo = await SqliteSoilRepository.create({
      rootDir: path.join(tmpDir, "soil"),
      indexPath: path.join(tmpDir, "soil", ".index", "soil.db"),
    });
  });

  afterEach(() => {
    repo.close();
    cleanupTempDir(tmpDir);
  });

  async function seedHybridFixture(): Promise<void> {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-lexical",
          record_key: "fact.lexical",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/lexical",
          title: "Lexical fact",
          summary: null,
          canonical_text: "anchor phrase lexical fact",
          goal_id: "goal-a",
          task_id: "task-a",
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "lexical",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "rec-semantic-outside",
          record_key: "fact.semantic-outside",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/semantic-outside",
          title: "Semantic outside fact",
          summary: null,
          canonical_text: "different wording outside fact",
          goal_id: "goal-b",
          task_id: "task-b",
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "semantic-outside",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "rec-workflow",
          record_key: "workflow.semantic",
          version: 1,
          record_type: "workflow",
          soil_id: "operations/semantic-workflow",
          title: "Semantic workflow",
          summary: null,
          canonical_text: "procedure wording workflow",
          goal_id: "goal-a",
          task_id: "task-c",
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "workflow",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-lexical",
          record_id: "rec-lexical",
          soil_id: "knowledge/lexical",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "anchor phrase lexical fact",
          token_count: 4,
          checksum: "lexical",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-semantic-outside",
          record_id: "rec-semantic-outside",
          soil_id: "knowledge/semantic-outside",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "different wording outside fact",
          token_count: 4,
          checksum: "semantic-outside",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-workflow",
          record_id: "rec-workflow",
          soil_id: "operations/semantic-workflow",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "procedure wording workflow",
          token_count: 3,
          checksum: "workflow",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      embeddings: [
        {
          chunk_id: "chunk-lexical",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [1, 0, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-semantic-outside",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [0, 1, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-workflow",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [0, 0.9, 0.1],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
      ],
    });
  }

  it("applies a mutation and retrieves candidates through lexical search", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-1",
          record_key: "pref.theme",
          version: 1,
          record_type: "preference",
          soil_id: "identity/preferences",
          title: "Theme preference",
          summary: "User prefers dark themes.",
          canonical_text: "The user prefers dark themes in tools.",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: 0.9,
          importance: 0.6,
          source_reliability: 0.8,
          valid_from: "2026-04-12T00:00:00.000Z",
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "agent_memory",
          source_id: "mem-1",
          metadata_json: { tags: ["preference"] },
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-1",
          record_id: "rec-1",
          soil_id: "identity/preferences",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: ["Preferences"],
          chunk_text: "The user prefers dark themes in tools and dashboards.",
          token_count: 9,
          checksum: "chk-1",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      pages: [
        {
          page_id: "page-1",
          soil_id: "identity/preferences",
          relative_path: "identity/preferences.md",
          route: "identity",
          kind: "identity",
          status: "confirmed",
          markdown: "# Preferences",
          checksum: "page-chk-1",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      page_members: [
        {
          page_id: "page-1",
          record_id: "rec-1",
          ordinal: 0,
          role: "primary",
          confidence: 0.9,
        },
      ],
    });

    const results = await repo.searchLexical({ query: "dark themes" });
    expect(results).toHaveLength(1);
    expect(results[0]?.record_id).toBe("rec-1");
    expect(results[0]?.page_id).toBe("page-1");

    const pages = await repo.loadPagesForRecords(["rec-1"]);
    expect(pages.get("rec-1")?.[0]?.relative_path).toBe("identity/preferences.md");
  });

  it("deactivates older active versions for the same record_key", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-v1",
          record_key: "workflow.release",
          version: 1,
          record_type: "workflow",
          soil_id: "operations/release",
          title: "Release workflow",
          summary: "Old workflow",
          canonical_text: "Old release workflow.",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: 0.7,
          importance: 0.7,
          source_reliability: 0.7,
          valid_from: "2026-04-12T00:00:00.000Z",
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "agent_memory",
          source_id: "mem-old",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-v1",
          record_id: "rec-v1",
          soil_id: "operations/release",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Old release workflow.",
          token_count: 3,
          checksum: "old",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
    });

    await repo.applyMutation({
      records: [
        {
          record_id: "rec-v2",
          record_key: "workflow.release",
          version: 2,
          record_type: "workflow",
          soil_id: "operations/release",
          title: "Release workflow",
          summary: "New workflow",
          canonical_text: "New release workflow.",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: 0.8,
          importance: 0.9,
          source_reliability: 0.8,
          valid_from: "2026-04-13T00:00:00.000Z",
          valid_to: null,
          supersedes_record_id: "rec-v1",
          is_active: true,
          source_type: "agent_memory",
          source_id: "mem-new",
          metadata_json: {},
          created_at: "2026-04-13T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-v2",
          record_id: "rec-v2",
          soil_id: "operations/release",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "New release workflow.",
          token_count: 3,
          checksum: "new",
          created_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    const current = await repo.searchLexical({ query: "new release workflow" });
    expect(current.map((candidate) => candidate.record_id)).toEqual(["rec-v2"]);

    const old = await repo.searchLexical({ query: "old release workflow" });
    expect(old).toHaveLength(0);
  });

  it("replaces page members atomically", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-a",
          record_key: "fact.a",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/shared",
          title: "Fact A",
          summary: null,
          canonical_text: "Fact A",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "agent_memory",
          source_id: "a",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "rec-b",
          record_key: "fact.b",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/shared",
          title: "Fact B",
          summary: null,
          canonical_text: "Fact B",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "agent_memory",
          source_id: "b",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-a",
          record_id: "rec-a",
          soil_id: "knowledge/shared",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Fact A body",
          token_count: 3,
          checksum: "a",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-b",
          record_id: "rec-b",
          soil_id: "knowledge/shared",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Fact B body",
          token_count: 3,
          checksum: "b",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      pages: [
        {
          page_id: "page-shared",
          soil_id: "knowledge/shared",
          relative_path: "knowledge/shared.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Shared",
          checksum: "shared",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      page_members: [
        {
          page_id: "page-shared",
          record_id: "rec-a",
          ordinal: 0,
          role: "primary",
          confidence: null,
        },
      ],
    });

    await repo.replacePageMembers("page-shared", [
      {
        page_id: "page-shared",
        record_id: "rec-b",
        ordinal: 0,
        role: "primary",
        confidence: null,
      },
    ]);

    const members = await repo.loadPageMembers(["page-shared"]);
    expect(members).toHaveLength(1);
    expect(members[0]?.record_id).toBe("rec-b");
  });

  it("keeps lexical rows for shared records after replacing one page membership set", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-a",
          record_key: "fact.a",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/shared",
          title: "Fact A",
          summary: null,
          canonical_text: "Fact A",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "agent_memory",
          source_id: "a",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "rec-b",
          record_key: "fact.b",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/shared",
          title: "Fact B",
          summary: null,
          canonical_text: "Fact B",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "agent_memory",
          source_id: "b",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-a",
          record_id: "rec-a",
          soil_id: "knowledge/shared",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Fact A body",
          token_count: 3,
          checksum: "a",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-b",
          record_id: "rec-b",
          soil_id: "knowledge/shared",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Fact B body",
          token_count: 3,
          checksum: "b",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      pages: [
        {
          page_id: "page-shared-a",
          soil_id: "knowledge/shared-a",
          relative_path: "knowledge/alpha.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Shared A",
          checksum: "shared-a",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
        {
          page_id: "page-shared-b",
          soil_id: "knowledge/shared-b",
          relative_path: "knowledge/zeta.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Shared B",
          checksum: "shared-b",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      page_members: [
        {
          page_id: "page-shared-a",
          record_id: "rec-a",
          ordinal: 0,
          role: "primary",
          confidence: null,
        },
        {
          page_id: "page-shared-b",
          record_id: "rec-a",
          ordinal: 1,
          role: "supporting",
          confidence: null,
        },
      ],
    });

    await repo.replacePageMembers("page-shared-a", [
      {
        page_id: "page-shared-a",
        record_id: "rec-b",
        ordinal: 0,
        role: "primary",
        confidence: null,
      },
    ]);

    const results = await repo.searchLexical({ query: "Fact A body" });
    expect(results).toHaveLength(1);
    expect(results[0]?.record_id).toBe("rec-a");
  });

  it("searches dense embeddings when a query embedding is provided", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-embed",
          record_key: "fact.embedding",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/embeddings",
          title: "Embedding fact",
          summary: null,
          canonical_text: "vector search fact",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "emb-1",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-embed",
          record_id: "rec-embed",
          soil_id: "knowledge/embeddings",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "vector search fact",
          token_count: 3,
          checksum: "embed",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      embeddings: [
        {
          chunk_id: "chunk-embed",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [1, 0, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
      ],
    });

    const candidates = await repo.searchDense({
      query: "vector",
      query_embedding: [0.99, 0.01, 0],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.record_id).toBe("rec-embed");
    expect(candidates[0]?.score).toBeGreaterThan(0.9);
  });

  it("uses only the latest embedding version per chunk and model", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-versioned-embed",
          record_key: "fact.versioned-embed",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/versioned-embed",
          title: "Versioned embedding fact",
          summary: null,
          canonical_text: "versioned vector fact",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "versioned-embed",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-versioned-embed",
          record_id: "rec-versioned-embed",
          soil_id: "knowledge/versioned-embed",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "versioned vector fact",
          token_count: 3,
          checksum: "versioned-embed",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      embeddings: [
        {
          chunk_id: "chunk-versioned-embed",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [0, 1, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-versioned-embed",
          model: "test-model",
          embedding_version: 2,
          encoding: "json",
          embedding: [1, 0, 0],
          embedded_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    const candidates = await repo.searchDense({
      query: "versioned",
      query_embedding: [0, 1, 0],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.metadata_json.embedding_version).toBe(2);
    expect(candidates[0]?.score).toBeLessThan(0.1);
  });

  it("does not suppress dense reindex jobs for partial embedding updates", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-partial-embed",
          record_key: "fact.partial-embed",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/partial-embed",
          title: "Partial embedding fact",
          summary: null,
          canonical_text: "first vector fact second vector fact",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "partial-embed",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-partial-a",
          record_id: "rec-partial-embed",
          soil_id: "knowledge/partial-embed",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "first vector fact",
          token_count: 3,
          checksum: "partial-a",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-partial-b",
          record_id: "rec-partial-embed",
          soil_id: "knowledge/partial-embed",
          chunk_index: 1,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "second vector fact",
          token_count: 3,
          checksum: "partial-b",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      embeddings: [
        {
          chunk_id: "chunk-partial-a",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [1, 0, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-partial-b",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [0, 1, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
      ],
    });

    await repo.applyMutation({
      records: [
        {
          record_id: "rec-partial-embed",
          record_key: "fact.partial-embed",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/partial-embed",
          title: "Partial embedding fact",
          summary: null,
          canonical_text: "updated first vector fact updated second vector fact",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "partial-embed",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-partial-a",
          record_id: "rec-partial-embed",
          soil_id: "knowledge/partial-embed",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "updated first vector fact",
          token_count: 4,
          checksum: "partial-a-updated",
          created_at: "2026-04-13T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-partial-b",
          record_id: "rec-partial-embed",
          soil_id: "knowledge/partial-embed",
          chunk_index: 1,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "updated second vector fact",
          token_count: 4,
          checksum: "partial-b-updated",
          created_at: "2026-04-13T00:00:00.000Z",
        },
      ],
      embeddings: [
        {
          chunk_id: "chunk-partial-a",
          model: "test-model",
          embedding_version: 2,
          encoding: "json",
          embedding: [1, 0, 0],
          embedded_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    let initialJobCount = 0;
    const db = new Database(path.join(tmpDir, "soil", ".index", "soil.db"), { readonly: true });
    try {
      const jobs = db.prepare("SELECT COUNT(*) AS count FROM soil_reindex_jobs WHERE scope = 'embedding' AND status IN ('pending', 'running') AND payload_json LIKE ?").get("%rec-partial-embed%") as { count: number };
      expect(jobs.count).toBeGreaterThan(0);
      initialJobCount = jobs.count;
    } finally {
      db.close();
    }

    await repo.applyMutation({
      records: [
        {
          record_id: "rec-partial-embed",
          record_key: "fact.partial-embed",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/partial-embed",
          title: "Partial embedding fact",
          summary: null,
          canonical_text: "updated again while reindex is already pending",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "partial-embed",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-14T00:00:00.000Z",
        },
      ],
    });
    const db2 = new Database(path.join(tmpDir, "soil", ".index", "soil.db"), { readonly: true });
    try {
      const jobs = db2.prepare("SELECT COUNT(*) AS count FROM soil_reindex_jobs WHERE scope = 'embedding' AND status IN ('pending', 'running') AND payload_json LIKE ?").get("%rec-partial-embed%") as { count: number };
      expect(jobs.count).toBe(initialJobCount);
    } finally {
      db2.close();
    }

    const candidates = await repo.searchDense({
      query: "updated",
      query_embedding: [1, 0, 0],
    });
    expect(candidates).toHaveLength(0);
  });

  it("excludes embeddings with open reindex jobs from dense search", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-stale",
          record_key: "fact.stale",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/stale",
          title: "Stale fact",
          summary: null,
          canonical_text: "Original content",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "src-stale",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-stale",
          record_id: "rec-stale",
          soil_id: "knowledge/stale",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Original content",
          token_count: 2,
          checksum: "orig",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      embeddings: [
        {
          chunk_id: "chunk-stale",
          model: "test-model",
          embedding_version: 1,
          encoding: "json",
          embedding: [1, 0, 0],
          embedded_at: "2026-04-12T00:00:00.000Z",
        },
      ],
    });

    const db = new Database(path.join(tmpDir, "soil", ".index", "soil.db"));
    try {
      db.prepare(`
        UPDATE soil_reindex_jobs
        SET status = 'completed', completed_at = ?
        WHERE scope = 'embedding' AND payload_json LIKE ?
      `).run("2026-04-12T00:00:01.000Z", '%rec-stale%');
    } finally {
      db.close();
    }

    const fresh = await repo.searchDense({
      query: "original",
      query_embedding: [1, 0, 0],
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.record_id).toBe("rec-stale");

    await repo.applyMutation({
      records: [
        {
          record_id: "rec-stale",
          record_key: "fact.stale",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/stale",
          title: "Stale fact",
          summary: null,
          canonical_text: "Updated content",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "src-stale",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-stale",
          record_id: "rec-stale",
          soil_id: "knowledge/stale",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Updated content",
          token_count: 2,
          checksum: "updated",
          created_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    const candidates = await repo.searchDense({
      query: "updated",
      query_embedding: [1, 0, 0],
    });
    expect(candidates).toHaveLength(0);

    const db2 = new Database(path.join(tmpDir, "soil", ".index", "soil.db"), { readonly: true });
    try {
      const jobs = db2.prepare("SELECT COUNT(*) AS count FROM soil_reindex_jobs WHERE scope = 'embedding' AND status IN ('pending', 'running')").get() as { count: number };
      expect(jobs.count).toBeGreaterThan(0);
    } finally {
      db2.close();
    }
  });

  it("limits dense search to explicit candidate record ids", async () => {
    await seedHybridFixture();

    const candidates = await repo.searchDense({
      query: "semantic",
      query_embedding: [0, 1, 0],
      dense_candidate_record_ids: ["rec-lexical"],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.record_id).toBe("rec-lexical");
    expect(candidates[0]?.record_id).not.toBe("rec-semantic-outside");
  });

  it("runs dense as a secondary retriever over lexical candidates only", async () => {
    await seedHybridFixture();

    const candidates = await repo.searchHybrid({
      query: "anchor phrase",
      query_embedding: [0, 1, 0],
      limit: 10,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      record_id: "rec-lexical",
      lane: "hybrid",
    });
    expect(candidates[0]?.metadata_json.dense_rank).toBe(1);
  });

  it("falls back to metadata-filtered dense when lexical has no candidates", async () => {
    await seedHybridFixture();

    const candidates = await repo.searchHybrid({
      query: "absent",
      query_embedding: [0, 1, 0],
      record_filter: { record_types: ["workflow"] },
      limit: 10,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      record_id: "rec-workflow",
      lane: "hybrid",
    });
  });

  it("does not run unfiltered dense when lexical has no candidates", async () => {
    await seedHybridFixture();

    const candidates = await repo.searchHybrid({
      query: "absent",
      query_embedding: [0, 1, 0],
      limit: 10,
    });

    expect(candidates).toHaveLength(0);
  });

  it("deduplicates lexical results when the same record appears on multiple pages", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-dup",
          record_key: "fact.dup",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/dup",
          title: "Duplicate fact",
          summary: "Shared duplicate entry",
          canonical_text: "Shared duplicate entry",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "dup-1",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-dup",
          record_id: "rec-dup",
          soil_id: "knowledge/dup",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "Shared duplicate entry",
          token_count: 3,
          checksum: "dup",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      pages: [
        {
          page_id: "page-dup-a",
          soil_id: "knowledge/dup-a",
          relative_path: "knowledge/dup-a.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Dup A",
          checksum: "dup-a",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
        {
          page_id: "page-dup-b",
          soil_id: "knowledge/dup-b",
          relative_path: "knowledge/dup-b.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Dup B",
          checksum: "dup-b",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      page_members: [
        {
          page_id: "page-dup-a",
          record_id: "rec-dup",
          ordinal: 0,
          role: "primary",
          confidence: null,
        },
        {
          page_id: "page-dup-b",
          record_id: "rec-dup",
          ordinal: 0,
          role: "primary",
          confidence: null,
        },
      ],
    });

    const candidates = await repo.searchLexical({ query: "shared duplicate entry", limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.chunk_id).toBe("chunk-dup");
  });

  it("batches direct lookup chunk and page member fetches", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "rec-shared",
          record_key: "fact.shared",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/shared",
          title: "Shared record",
          summary: null,
          canonical_text: "shared record body",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "shared-record",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "rec-page-a",
          record_key: "fact.page-a",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/page-a",
          title: "Page A member",
          summary: null,
          canonical_text: "page member alpha",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "page-a",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "rec-page-b",
          record_key: "fact.page-b",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/page-b",
          title: "Page B member",
          summary: null,
          canonical_text: "page member beta",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: null,
          importance: null,
          source_reliability: null,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "knowledge",
          source_id: "page-b",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      chunks: [
        {
          chunk_id: "chunk-shared-0",
          record_id: "rec-shared",
          soil_id: "knowledge/shared",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "shared record intro",
          token_count: 3,
          checksum: "shared-0",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-shared-1",
          record_id: "rec-shared",
          soil_id: "knowledge/shared",
          chunk_index: 1,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "shared record detail",
          token_count: 3,
          checksum: "shared-1",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-page-a-0",
          record_id: "rec-page-a",
          soil_id: "knowledge/page-a",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "shared page intro",
          token_count: 3,
          checksum: "page-a-0",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-page-a-1",
          record_id: "rec-page-a",
          soil_id: "knowledge/page-a",
          chunk_index: 1,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "shared page detail",
          token_count: 3,
          checksum: "page-a-1",
          created_at: "2026-04-12T00:00:00.000Z",
        },
        {
          chunk_id: "chunk-page-b-0",
          record_id: "rec-page-b",
          soil_id: "knowledge/page-b",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: [],
          chunk_text: "shared page fallback",
          token_count: 3,
          checksum: "page-b-0",
          created_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      pages: [
        {
          page_id: "page-shared",
          soil_id: "knowledge/shared",
          relative_path: "knowledge/shared.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Shared",
          checksum: "shared",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
        {
          page_id: "page-aux",
          soil_id: "knowledge/page-aux",
          relative_path: "knowledge/shared",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Aux",
          checksum: "aux",
          projected_at: "2026-04-12T00:00:00.000Z",
        },
      ],
      page_members: [
        {
          page_id: "page-shared",
          record_id: "rec-shared",
          ordinal: 0,
          role: "primary",
          confidence: null,
        },
        {
          page_id: "page-aux",
          record_id: "rec-page-a",
          ordinal: 0,
          role: "primary",
          confidence: null,
        },
        {
          page_id: "page-aux",
          record_id: "rec-page-b",
          ordinal: 1,
          role: "supporting",
          confidence: null,
        },
      ],
    });

    const result = await repo.lookupDirect({
      query: "knowledge/shared",
      limit: 10,
      direct_lookup: true,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      chunk_id: "chunk-shared-0",
      record_id: "rec-shared",
      page_id: "page-shared",
      snippet: "shared record intro",
    });
    expect(result.candidates[1]).toMatchObject({
      chunk_id: "chunk-page-a-0",
      record_id: "rec-page-a",
      page_id: "page-aux",
      snippet: "shared page intro",
    });
  });

  it("loads records by source metadata including inactive versions", async () => {
    await repo.applyMutation({
      records: [
        {
          record_id: "dream-rec-v1",
          record_key: "learned-pattern:pat-1:goal-a",
          version: 1,
          record_type: "reflection",
          soil_id: "learning/learned-patterns/strategy-selection",
          title: "Pattern",
          summary: "Old pattern",
          canonical_text: "Old pattern",
          goal_id: "goal-a",
          task_id: null,
          status: "confirmed",
          confidence: 0.8,
          importance: 0.7,
          source_reliability: 0.7,
          valid_from: "2026-04-12T00:00:00.000Z",
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "learned_pattern",
          source_id: "pat-1",
          metadata_json: {},
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        },
        {
          record_id: "dream-rec-v2",
          record_key: "learned-pattern:pat-1:goal-a",
          version: 2,
          record_type: "reflection",
          soil_id: "learning/learned-patterns/strategy-selection",
          title: "Pattern",
          summary: "New pattern",
          canonical_text: "New pattern",
          goal_id: "goal-a",
          task_id: null,
          status: "confirmed",
          confidence: 0.9,
          importance: 0.8,
          source_reliability: 0.7,
          valid_from: "2026-04-12T01:00:00.000Z",
          valid_to: null,
          supersedes_record_id: "dream-rec-v1",
          is_active: true,
          source_type: "learned_pattern",
          source_id: "pat-1",
          metadata_json: {},
          created_at: "2026-04-12T01:00:00.000Z",
          updated_at: "2026-04-12T01:00:00.000Z",
        },
      ],
    });

    const records = await repo.loadRecords({
      active_only: false,
      source_types: ["learned_pattern"],
      source_ids: ["pat-1"],
    });

    expect(records.map((record) => [record.record_id, record.is_active])).toEqual([
      ["dream-rec-v1", false],
      ["dream-rec-v2", true],
    ]);
  });
});
