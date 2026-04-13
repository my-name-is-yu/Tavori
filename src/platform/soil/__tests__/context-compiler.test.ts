import { describe, expect, it } from "vitest";
import { compileSoilContext } from "../context-compiler.js";
import type { SoilCandidate } from "../contracts.js";

function candidate(overrides: Partial<SoilCandidate>): SoilCandidate {
  return {
    chunk_id: "chunk-default",
    record_id: "record-default",
    soil_id: "knowledge/default",
    page_id: null,
    lane: "lexical",
    rank: 1,
    score: 0.5,
    snippet: "default",
    metadata_json: {},
    ...overrides,
  };
}

describe("Soil context compiler", () => {
  it("resolves active explicit routes deterministically before search", () => {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-1",
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      targetPaths: ["src/platform/soil/context-compiler.ts"],
      goalId: "goal-a",
      taskCategory: "implementation",
      phase: "execute",
      fallbackQuery: "soil compiler",
      fallbackCandidates: [
        candidate({ chunk_id: "fallback-1", record_id: "record-fallback", soil_id: "knowledge/fallback" }),
      ],
      routes: [
        {
          route_id: "route-soil-platform",
          path_globs: ["src/platform/soil/*"],
          goal_ids: ["goal-a"],
          task_categories: ["implementation"],
          phases: ["execute"],
          soil_ids: ["context-routes"],
          record_ids: ["record-route"],
          reason: "Soil platform edits need context route guidance.",
          created_at: "2026-04-13T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    expect(compiled.items.map((item) => [item.source, item.soilId, item.recordId])).toEqual([
      ["route", "context-routes", null],
      ["route", null, "record-route"],
    ]);
    expect(compiled.trace.decisions.filter((decision) => decision.decision === "routed")).toHaveLength(2);
    expect(compiled.trace.decisions.find((decision) => decision.candidate_id === "candidate:fallback-1")).toBeUndefined();
    expect(compiled.compileMissObservations).toEqual([]);
  });

  it("rejects low-confidence or inactive fallback candidates and keeps the rejection in the trace", () => {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-2",
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      targetPaths: ["src/app/bookmark.ts"],
      fallbackQuery: "bookmark sort",
      minFallbackScore: 0.4,
      fallbackCandidates: [
        candidate({ chunk_id: "low", record_id: "low-record", soil_id: "knowledge/low", score: 0.1 }),
        candidate({
          chunk_id: "archived",
          record_id: "archived-record",
          soil_id: "knowledge/archived",
          score: 0.9,
          metadata_json: { lifecycle_state: "archived" },
        }),
        candidate({
          chunk_id: "schema",
          record_id: "schema-record",
          soil_id: "knowledge/schema",
          score: 0.9,
          metadata_json: { schema_compatible: false },
        }),
        candidate({
          chunk_id: "exact",
          record_id: "exact-record",
          soil_id: "knowledge/exact",
          score: 0.1,
          metadata_json: { exact_metadata_match: true },
        }),
      ],
      routes: [],
    });

    expect(compiled.items).toEqual([
      expect.objectContaining({
        source: "fallback",
        recordId: "exact-record",
        soilId: "knowledge/exact",
      }),
    ]);
    expect(compiled.warnings).toEqual(["No active context route matched; fallback search candidates were evaluated."]);
    expect(compiled.trace.decisions).toEqual([
      expect.objectContaining({
        candidate_id: "candidate:low",
        decision: "rejected",
        reason: "score 0.1 is below fallback admission threshold 0.4",
      }),
      expect.objectContaining({
        candidate_id: "candidate:archived",
        decision: "rejected",
        reason: "lifecycle state archived is excluded from default context",
      }),
      expect.objectContaining({
        candidate_id: "candidate:schema",
        decision: "rejected",
        reason: "schema is incompatible with default context",
      }),
      expect.objectContaining({
        candidate_id: "candidate:exact",
        decision: "admitted",
      }),
    ]);
    expect(compiled.compileMissObservations).toEqual([
      expect.objectContaining({
        retrieval_id: "retrieval-2",
        reason: "no_route",
        target_paths: ["src/app/bookmark.ts"],
        rejected_candidate_ids: ["candidate:low", "candidate:archived", "candidate:schema"],
      }),
    ]);
  });

  it("emits a low-confidence compile miss when fallback candidates are all rejected", () => {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-3",
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      targetPaths: ["src/app/bookmark.ts"],
      fallbackQuery: "bookmark sort",
      minFallbackScore: 0.4,
      fallbackCandidates: [
        candidate({ chunk_id: "low", record_id: "low-record", soil_id: "knowledge/low", score: 0.1 }),
      ],
      routes: [],
    });

    expect(compiled.items).toEqual([]);
    expect(compiled.compileMissObservations).toEqual([
      expect.objectContaining({
        observation_id: "retrieval-3:compile-miss:no-route",
        reason: "low_confidence_search",
        rejected_candidate_ids: ["candidate:low"],
      }),
    ]);
  });

  it("can explicitly admit fallback candidates after a route match when requested", () => {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-4",
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      targetPaths: ["src/platform/soil/context-compiler.ts"],
      fallbackQuery: "soil compiler",
      includeFallbackWhenRouteMatched: true,
      fallbackCandidates: [
        candidate({ chunk_id: "fallback-1", record_id: "record-fallback", soil_id: "knowledge/fallback" }),
      ],
      routes: [
        {
          route_id: "route-soil-platform",
          path_globs: ["src/platform/soil/*"],
          soil_ids: ["context-routes"],
          reason: "Soil platform edits need context route guidance.",
          created_at: "2026-04-13T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    expect(compiled.items.map((item) => [item.source, item.soilId, item.recordId])).toEqual([
      ["route", "context-routes", null],
      ["fallback", "knowledge/fallback", "record-fallback"],
    ]);
    expect(compiled.trace.decisions.find((decision) => decision.candidate_id === "candidate:fallback-1")).toMatchObject({
      decision: "admitted",
      reason: "fallback search admitted lexical candidate with score 0.5",
    });
  });

  it("keeps inactive route rejections before fallback admission decisions", () => {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-5",
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      targetPaths: ["src/app/bookmark.ts"],
      fallbackQuery: "bookmark sort",
      maxFallbackAdmitted: 1,
      fallbackCandidates: [
        candidate({ chunk_id: "first", record_id: "first-record", soil_id: "knowledge/first" }),
        candidate({ chunk_id: "second", record_id: "second-record", soil_id: "knowledge/second" }),
      ],
      routes: [
        {
          route_id: "route-archived",
          status: "archived",
          path_globs: ["src/app/*"],
          soil_ids: ["knowledge/archived-route"],
          reason: "Archived route should not compile into context.",
          created_at: "2026-04-13T00:00:00.000Z",
          updated_at: "2026-04-13T00:00:00.000Z",
        },
      ],
    });

    expect(compiled.items.map((item) => [item.source, item.soilId, item.recordId])).toEqual([
      ["fallback", "knowledge/first", "first-record"],
    ]);
    expect(compiled.trace.decisions.map((decision) => [decision.candidate_id, decision.decision, decision.reason])).toEqual([
      ["route:route-archived", "rejected", "route status archived is excluded from default context"],
      ["candidate:first", "admitted", "fallback search admitted lexical candidate with score 0.5"],
      ["candidate:second", "rejected", "fallback admission cap 1 reached"],
    ]);
    expect(compiled.compileMissObservations).toEqual([
      expect.objectContaining({
        reason: "no_route",
        rejected_candidate_ids: ["candidate:second"],
      }),
    ]);
  });

  it("warns when a matched route has stale evaluation metadata", () => {
    const compiled = compileSoilContext({
      retrievalId: "retrieval-6",
      now: () => new Date("2026-04-13T00:00:00.000Z"),
      targetPaths: ["src/platform/soil/context-compiler.ts"],
      staleRouteAfterMs: 24 * 60 * 60 * 1000,
      routes: [
        {
          route_id: "route-soil-platform",
          path_globs: ["src/platform/soil/*"],
          soil_ids: ["context-routes"],
          reason: "Soil platform edits need context route guidance.",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          last_evaluated_at: "2026-04-01T00:00:00.000Z",
          last_evaluation_result: "passed",
        },
      ],
    });

    expect(compiled.warnings).toEqual([
      "Route route-soil-platform has not been evaluated since 2026-04-01T00:00:00.000Z.",
    ]);
    expect(compiled.trace.warnings).toEqual(compiled.warnings);
  });
});
