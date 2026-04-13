import { describe, expect, it } from "vitest";
import {
  aggregateCompileMisses,
  applySoilRouteHealth,
} from "../health.js";
import {
  appendSoilCompileMissObservations,
  loadSoilCompileMissObservations,
} from "../feedback-store.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { SoilCompileMissObservation, SoilMemoryLintFinding } from "../contracts.js";

const timestamp = "2026-04-13T00:00:00.000Z";

function miss(overrides: Partial<SoilCompileMissObservation> = {}): SoilCompileMissObservation {
  return {
    schema_version: "soil-compile-miss-v1",
    observation_id: "miss-1",
    retrieval_id: "retrieval-1",
    reason: "no_route",
    target_paths: ["src/platform/soil/context-compiler.ts"],
    route_ids: [],
    rejected_candidate_ids: [],
    created_at: timestamp,
    ...overrides,
  };
}

describe("Soil memory health feedback", () => {
  it("persists and aggregates compile miss observations for Dream feedback", async () => {
    const baseDir = makeTempDir("soil-feedback-");
    try {
      await appendSoilCompileMissObservations({
        baseDir,
        observations: [
          miss({ observation_id: "miss-1" }),
          miss({ observation_id: "miss-2" }),
          miss({ observation_id: "miss-3", reason: "low_confidence_search", target_paths: ["src/platform/dream/sync.ts"] }),
        ],
      });

      const loaded = await loadSoilCompileMissObservations({ baseDir });
      expect(loaded.map((entry) => entry.observation_id)).toEqual(["miss-1", "miss-2", "miss-3"]);
      expect(aggregateCompileMisses(loaded).map((bucket) => [bucket.reason, bucket.targetPath, bucket.count])).toEqual([
        ["no_route", "src/platform/soil/context-compiler.ts", 2],
        ["low_confidence_search", "src/platform/dream/sync.ts", 1],
      ]);
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("only deprecates active routes with open error route findings", () => {
    const findings: SoilMemoryLintFinding[] = [
      {
        schema_version: "soil-memory-lint-finding-v1",
        finding_id: "finding-1",
        code: "stale_route",
        severity: "error",
        status: "open",
        message: "Route target is stale.",
        soil_id: null,
        record_id: null,
        route_id: "route-bad",
        source_path: null,
        created_at: timestamp,
        resolved_at: null,
      },
      {
        schema_version: "soil-memory-lint-finding-v1",
        finding_id: "finding-2",
        code: "stale_route",
        severity: "warning",
        status: "open",
        message: "Route should be watched.",
        soil_id: null,
        record_id: null,
        route_id: "route-watch",
        source_path: null,
        created_at: timestamp,
        resolved_at: null,
      },
    ];

    const result = applySoilRouteHealth({
      now: () => new Date("2026-04-14T00:00:00.000Z"),
      routes: [
        {
          route_id: "route-bad",
          status: "active",
          soil_ids: ["context-routes"],
          reason: "bad target",
          created_at: timestamp,
          updated_at: timestamp,
        },
        {
          route_id: "route-watch",
          status: "active",
          soil_ids: ["context-routes"],
          reason: "watch target",
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      findings,
    });

    expect(result.deprecatedRouteIds).toEqual(["route-bad"]);
    expect(result.routes.map((route) => [route.route_id, route.status])).toEqual([
      ["route-bad", "deprecated"],
      ["route-watch", "active"],
    ]);
  });
});

