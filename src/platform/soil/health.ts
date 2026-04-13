import { randomUUID } from "node:crypto";
import {
  SoilMemoryLintFindingSchema,
  type SoilCompileMissObservation,
  type SoilContextRouteInput,
  type SoilMemoryLintFinding,
  type SoilMemoryLintFindingCode,
} from "./contracts.js";
import { SoilDoctor, type SoilDoctorFinding } from "./doctor.js";

export interface SoilCompileMissBucket {
  key: string;
  count: number;
  reason: SoilCompileMissObservation["reason"];
  targetPath: string | null;
  routeIds: string[];
}

export interface SoilMemoryHealthSnapshot {
  generatedAt: string;
  rootDir: string;
  totalPages: number;
  findingCount: number;
  errorCount: number;
  warningCount: number;
  compileMissCount: number;
  compileMissBuckets: SoilCompileMissBucket[];
  findings: SoilMemoryLintFinding[];
}

export interface SoilRouteHealthResult {
  routes: SoilContextRouteInput[];
  deprecatedRouteIds: string[];
}

function nowIso(clock?: () => Date): string {
  return (clock?.() ?? new Date()).toISOString();
}

function doctorFindingCode(finding: SoilDoctorFinding): SoilMemoryLintFindingCode {
  switch (finding.code) {
    case "missing-source-path":
      return "broken_source_ref";
    case "duplicate-soil-id":
      return "conflicting_active_record";
    case "missing-required-page":
      return "orphan_page";
    case "invalid-frontmatter":
    case "checksum-mismatch":
    case "watermark-mismatch":
    case "index-checksum-mismatch":
    case "index-page-count-mismatch":
      return "stale_page";
    case "missing-index":
    case "unsafe-path":
      return "schema_incompatible";
  }
}

function findingSeverity(finding: SoilDoctorFinding): SoilMemoryLintFinding["severity"] {
  return finding.severity === "error" ? "error" : "warning";
}

function toMemoryLintFinding(finding: SoilDoctorFinding, generatedAt: string): SoilMemoryLintFinding {
  return SoilMemoryLintFindingSchema.parse({
    finding_id: `soil-doctor:${finding.code}:${finding.soilId ?? finding.relativePath}`,
    code: doctorFindingCode(finding),
    severity: findingSeverity(finding),
    message: finding.message,
    soil_id: finding.soilId ?? null,
    source_path: finding.absolutePath,
    created_at: generatedAt,
  });
}

function compileMissFinding(observation: SoilCompileMissObservation): SoilMemoryLintFinding {
  const code: SoilMemoryLintFindingCode =
    observation.reason === "bad_route" || observation.reason === "stale_route"
      ? "stale_route"
      : "missing_route";
  return SoilMemoryLintFindingSchema.parse({
    finding_id: `compile-miss:${observation.observation_id}`,
    code,
    severity: observation.reason === "low_confidence_search" ? "warning" : "info",
    message: observation.notes ?? `Compile miss: ${observation.reason}`,
    route_id: observation.route_ids[0] ?? null,
    source_path: observation.target_paths[0] ?? null,
    created_at: observation.created_at,
  });
}

export function aggregateCompileMisses(observations: SoilCompileMissObservation[]): SoilCompileMissBucket[] {
  const buckets = new Map<string, SoilCompileMissBucket>();
  for (const observation of observations) {
    const targetPath = observation.target_paths[0] ?? null;
    const routeIds = observation.route_ids;
    const key = `${observation.reason}:${targetPath ?? "global"}:${routeIds.join(",")}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    buckets.set(key, {
      key,
      count: 1,
      reason: observation.reason,
      targetPath,
      routeIds,
    });
  }
  return [...buckets.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export async function inspectSoilMemoryHealth(input: {
  rootDir?: string;
  compileMissObservations?: SoilCompileMissObservation[];
  clock?: () => Date;
}): Promise<SoilMemoryHealthSnapshot> {
  const generatedAt = nowIso(input.clock);
  const report = await SoilDoctor.create({ rootDir: input.rootDir }).inspect();
  const compileMissObservations = input.compileMissObservations ?? [];
  const findings = [
    ...report.findings.map((finding) => toMemoryLintFinding(finding, generatedAt)),
    ...compileMissObservations.map((observation) => compileMissFinding(observation)),
  ];
  return {
    generatedAt,
    rootDir: report.rootDir,
    totalPages: report.totalPages,
    findingCount: findings.length,
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
    compileMissCount: compileMissObservations.length,
    compileMissBuckets: aggregateCompileMisses(compileMissObservations),
    findings,
  };
}

export function applySoilRouteHealth(input: {
  routes: SoilContextRouteInput[];
  findings: SoilMemoryLintFinding[];
  now?: () => Date;
}): SoilRouteHealthResult {
  const generatedAt = nowIso(input.now);
  const unhealthyRouteIds = new Set(
    input.findings
      .filter((finding) =>
        finding.route_id !== null &&
        finding.status === "open" &&
        finding.severity === "error" &&
        (finding.code === "broken_route_target" || finding.code === "stale_route")
      )
      .map((finding) => finding.route_id as string)
  );
  if (unhealthyRouteIds.size === 0) {
    return { routes: input.routes, deprecatedRouteIds: [] };
  }
  const deprecatedRouteIds: string[] = [];
  const routes = input.routes.map((route) => {
    if (!unhealthyRouteIds.has(route.route_id) || (route.status ?? "active") !== "active") {
      return route;
    }
    deprecatedRouteIds.push(route.route_id);
    return {
      ...route,
      status: "deprecated" as const,
      updated_at: generatedAt,
      source_observation_ids: [
        ...(route.source_observation_ids ?? []),
        `route-health:${randomUUID()}`,
      ],
    };
  });
  return { routes, deprecatedRouteIds };
}
