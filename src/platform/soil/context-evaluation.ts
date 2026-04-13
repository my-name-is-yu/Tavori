import { compileSoilContext, type SoilContextCompilerInput } from "./context-compiler.js";
import type { SoilCompiledContextItem } from "./context-compiler.js";
import type { SoilContextRouteInput, SoilMemoryLintFinding } from "./contracts.js";

export interface SoilContextEvaluationCase {
  caseId: string;
  input: SoilContextCompilerInput;
  expectedSoilIds?: string[];
  expectedRecordIds?: string[];
  enabled?: boolean;
}

export interface SoilContextEvaluationCaseResult {
  caseId: string;
  enabled: boolean;
  itemCount: number;
  admittedFallbackCount: number;
  rejectedFallbackCount: number;
  compileMissCount: number;
  warningCount: number;
  searchAvoided: boolean;
  missingExpectedSoilIds: string[];
  missingExpectedRecordIds: string[];
  irrelevantAdmittedItems: Array<{ soilId: string | null; recordId: string | null; source: SoilCompiledContextItem["source"] }>;
}

export interface SoilContextMemoryGrowthStats {
  routeCount: number;
  activeRouteCount: number;
  deprecatedRouteCount: number;
  archivedRouteCount: number;
  lintFindingCount: number;
  openLintFindingCount: number;
}

export interface SoilContextEvaluationReport {
  cases: SoilContextEvaluationCaseResult[];
  summary: {
    caseCount: number;
    enabledCaseCount: number;
    disabledCaseCount: number;
    searchAvoidedCases: number;
    totalContextItems: number;
    maxContextItems: number;
    admittedFallbackCount: number;
    rejectedFallbackCount: number;
    compileMissCount: number;
    warningCount: number;
    irrelevantAdmittedItemCount: number;
    missingExpectedItemCount: number;
  };
  memoryGrowth: SoilContextMemoryGrowthStats;
}

function routeStatus(route: SoilContextRouteInput): string {
  return route.status ?? "active";
}

export function computeSoilContextMemoryGrowthStats(input: {
  routes?: SoilContextRouteInput[];
  findings?: SoilMemoryLintFinding[];
} = {}): SoilContextMemoryGrowthStats {
  const routes = input.routes ?? [];
  const findings = input.findings ?? [];
  return {
    routeCount: routes.length,
    activeRouteCount: routes.filter((route) => routeStatus(route) === "active").length,
    deprecatedRouteCount: routes.filter((route) => routeStatus(route) === "deprecated").length,
    archivedRouteCount: routes.filter((route) => routeStatus(route) === "archived").length,
    lintFindingCount: findings.length,
    openLintFindingCount: findings.filter((finding) => finding.status === "open").length,
  };
}

function isExpectedItem(
  item: SoilCompiledContextItem,
  expectedSoilIds: Set<string>,
  expectedRecordIds: Set<string>
): boolean {
  if (item.soilId && expectedSoilIds.has(item.soilId)) {
    return true;
  }
  if (item.recordId && expectedRecordIds.has(item.recordId)) {
    return true;
  }
  return expectedSoilIds.size === 0 && expectedRecordIds.size === 0;
}

export function evaluateSoilContextCases(input: {
  cases: SoilContextEvaluationCase[];
  routes?: SoilContextRouteInput[];
  findings?: SoilMemoryLintFinding[];
}): SoilContextEvaluationReport {
  const results: SoilContextEvaluationCaseResult[] = [];
  for (const testCase of input.cases) {
    if (testCase.enabled === false) {
      results.push({
        caseId: testCase.caseId,
        enabled: false,
        itemCount: 0,
        admittedFallbackCount: 0,
        rejectedFallbackCount: 0,
        compileMissCount: 0,
        warningCount: 0,
        searchAvoided: false,
        missingExpectedSoilIds: testCase.expectedSoilIds ?? [],
        missingExpectedRecordIds: testCase.expectedRecordIds ?? [],
        irrelevantAdmittedItems: [],
      });
      continue;
    }

    const compiled = compileSoilContext(testCase.input);
    const expectedSoilIds = new Set(testCase.expectedSoilIds ?? []);
    const expectedRecordIds = new Set(testCase.expectedRecordIds ?? []);
    const actualSoilIds = new Set(compiled.items.map((item) => item.soilId).filter((value): value is string => value !== null));
    const actualRecordIds = new Set(compiled.items.map((item) => item.recordId).filter((value): value is string => value !== null));
    const admittedFallbackCount = compiled.trace.decisions.filter((decision) =>
      decision.decision === "admitted" && decision.candidate_id.startsWith("candidate:")
    ).length;
    const rejectedFallbackCount = compiled.trace.decisions.filter((decision) =>
      decision.decision === "rejected" && decision.candidate_id.startsWith("candidate:")
    ).length;
    results.push({
      caseId: testCase.caseId,
      enabled: true,
      itemCount: compiled.items.length,
      admittedFallbackCount,
      rejectedFallbackCount,
      compileMissCount: compiled.compileMissObservations.length,
      warningCount: compiled.warnings.length,
      searchAvoided: compiled.items.some((item) => item.source === "route") && admittedFallbackCount === 0,
      missingExpectedSoilIds: [...expectedSoilIds].filter((soilId) => !actualSoilIds.has(soilId)),
      missingExpectedRecordIds: [...expectedRecordIds].filter((recordId) => !actualRecordIds.has(recordId)),
      irrelevantAdmittedItems: compiled.items
        .filter((item) => !isExpectedItem(item, expectedSoilIds, expectedRecordIds))
        .map((item) => ({ soilId: item.soilId, recordId: item.recordId, source: item.source })),
    });
  }

  return {
    cases: results,
    summary: {
      caseCount: results.length,
      enabledCaseCount: results.filter((result) => result.enabled).length,
      disabledCaseCount: results.filter((result) => !result.enabled).length,
      searchAvoidedCases: results.filter((result) => result.searchAvoided).length,
      totalContextItems: results.reduce((sum, result) => sum + result.itemCount, 0),
      maxContextItems: Math.max(0, ...results.map((result) => result.itemCount)),
      admittedFallbackCount: results.reduce((sum, result) => sum + result.admittedFallbackCount, 0),
      rejectedFallbackCount: results.reduce((sum, result) => sum + result.rejectedFallbackCount, 0),
      compileMissCount: results.reduce((sum, result) => sum + result.compileMissCount, 0),
      warningCount: results.reduce((sum, result) => sum + result.warningCount, 0),
      irrelevantAdmittedItemCount: results.reduce((sum, result) => sum + result.irrelevantAdmittedItems.length, 0),
      missingExpectedItemCount: results.reduce(
        (sum, result) => sum + result.missingExpectedSoilIds.length + result.missingExpectedRecordIds.length,
        0
      ),
    },
    memoryGrowth: computeSoilContextMemoryGrowthStats({
      routes: input.routes,
      findings: input.findings,
    }),
  };
}

