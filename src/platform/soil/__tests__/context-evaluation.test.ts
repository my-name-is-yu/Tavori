import { describe, expect, it } from "vitest";
import { evaluateSoilContextCases } from "../context-evaluation.js";

const timestamp = "2026-04-13T00:00:00.000Z";

describe("Soil context evaluation", () => {
  it("measures routed search avoidance, fallback rejections, bypass, and memory growth", () => {
    const report = evaluateSoilContextCases({
      routes: [
        {
          route_id: "route-soil",
          status: "active",
          path_globs: ["src/platform/soil/*"],
          soil_ids: ["context-routes"],
          reason: "Soil edits need route guidance.",
          created_at: timestamp,
          updated_at: timestamp,
        },
        {
          route_id: "route-old",
          status: "deprecated",
          path_globs: ["src/old/*"],
          soil_ids: ["old"],
          reason: "Old guidance.",
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      findings: [
        {
          schema_version: "soil-memory-lint-finding-v1",
          finding_id: "finding-1",
          code: "stale_route",
          severity: "warning",
          status: "open",
          message: "Route needs evaluation.",
          soil_id: null,
          record_id: null,
          route_id: "route-old",
          source_path: null,
          created_at: timestamp,
          resolved_at: null,
        },
      ],
      cases: [
        {
          caseId: "routed",
          expectedSoilIds: ["context-routes"],
          input: {
            retrievalId: "retrieval-routed",
            now: () => new Date(timestamp),
            targetPaths: ["src/platform/soil/context-compiler.ts"],
            fallbackQuery: "soil compiler",
            fallbackCandidates: [
              {
                chunk_id: "fallback",
                record_id: "record-fallback",
                soil_id: "knowledge/fallback",
                page_id: null,
                lane: "lexical",
                rank: 1,
                score: 0.9,
                snippet: "fallback",
                metadata_json: {},
              },
            ],
            routes: [
              {
                route_id: "route-soil",
                path_globs: ["src/platform/soil/*"],
                soil_ids: ["context-routes"],
                reason: "Soil edits need route guidance.",
                created_at: timestamp,
                updated_at: timestamp,
              },
            ],
          },
        },
        {
          caseId: "fallback-rejected",
          expectedSoilIds: [],
          input: {
            retrievalId: "retrieval-fallback",
            now: () => new Date(timestamp),
            targetPaths: ["src/app/page.ts"],
            fallbackQuery: "app page",
            minFallbackScore: 0.5,
            fallbackCandidates: [
              {
                chunk_id: "low",
                record_id: "record-low",
                soil_id: "knowledge/low",
                page_id: null,
                lane: "lexical",
                rank: 1,
                score: 0.1,
                snippet: "low",
                metadata_json: {},
              },
            ],
            routes: [],
          },
        },
        {
          caseId: "disabled",
          enabled: false,
          expectedSoilIds: ["context-routes"],
          input: {
            targetPaths: ["src/platform/soil/context-compiler.ts"],
            routes: [],
          },
        },
      ],
    });

    expect(report.summary).toMatchObject({
      caseCount: 3,
      enabledCaseCount: 2,
      disabledCaseCount: 1,
      searchAvoidedCases: 1,
      totalContextItems: 1,
      maxContextItems: 1,
      admittedFallbackCount: 0,
      rejectedFallbackCount: 1,
      compileMissCount: 1,
      missingExpectedItemCount: 1,
    });
    expect(report.cases.find((result) => result.caseId === "routed")).toMatchObject({
      searchAvoided: true,
      missingExpectedSoilIds: [],
    });
    expect(report.cases.find((result) => result.caseId === "disabled")).toMatchObject({
      enabled: false,
      missingExpectedSoilIds: ["context-routes"],
    });
    expect(report.memoryGrowth).toMatchObject({
      routeCount: 2,
      activeRouteCount: 1,
      deprecatedRouteCount: 1,
      openLintFindingCount: 1,
    });
  });
});

