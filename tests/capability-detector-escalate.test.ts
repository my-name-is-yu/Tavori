import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { ReportingEngine } from "../src/reporting-engine.js";
import { CapabilityDetector } from "../src/observation/capability-detector.js";
import type {
  Capability,
  CapabilityGap,
  CapabilityAcquisitionTask,
} from "../src/types/capability.js";
import type { Task } from "../src/types/task.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    goal_id: "goal-001",
    strategy_id: null,
    target_dimensions: ["feature_completeness"],
    primary_dimension: "feature_completeness",
    work_description: "Fetch payment data from Stripe API",
    rationale: "Need billing data for analysis",
    approach: "Call Stripe API with secret key and parse response",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["fetch payment data"],
      out_of_scope: ["write to database"],
      blast_radius: "read-only external API call",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "cap-001",
    name: "Stripe API",
    description: "Access to Stripe payment API",
    type: "service",
    status: "available",
    ...overrides,
  };
}

function makeGap(overrides: Partial<CapabilityGap> = {}): CapabilityGap {
  return {
    missing_capability: { name: "Stripe API", type: "service" },
    reason: "Task requires Stripe payment data",
    alternatives: ["Use cached data", "Request CSV export"],
    impact_description: "Cannot fetch live payment data",
    related_task_id: "task-001",
    ...overrides,
  };
}

const SERVICE_DEFICIENCY_RESPONSE = JSON.stringify({
  has_deficiency: true,
  missing_capability: { name: "Stripe API", type: "service" },
  reason: "Task requires calling Stripe API for payment data",
  alternatives: ["Use cached payment data", "Request CSV export from billing team"],
  impact_description: "Cannot fetch live payment data without Stripe API access",
});

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let reportingEngine: ReportingEngine;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-capability-test-"));
  stateManager = new StateManager(tempDir);
  reportingEngine = new ReportingEngine(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── escalateToUser ───

describe("escalateToUser", () => {
  it("saves a notification report via ReportingEngine", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report_type).toBe("capability_escalation");
  });

  it("notification message includes capability name and type", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.title).toContain("Stripe API");
    expect(reports[0]!.title).toContain("service");
  });

  it("notification details include the reason", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("Task requires Stripe payment data");
  });

  it("notification details include alternatives", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("Use cached data");
    expect(reports[0]!.content).toContain("Request CSV export");
  });

  it("notification details include impact_description", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("Cannot fetch live payment data");
  });

  it("notification details include related_task_id when present", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap({ related_task_id: "task-stripe-999" }), "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("task-stripe-999");
  });

  it("notification details omit related_task_id when absent", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ related_task_id: undefined });
    await detector.escalateToUser(gap, "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).not.toContain("Related Task");
  });

  it("notification is associated with the correct goalId", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-xyz");

    const reports = await reportingEngine.listReports("goal-xyz");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.goal_id).toBe("goal-xyz");
  });

  it("shows fallback message when no alternatives provided", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ alternatives: [] });
    await detector.escalateToUser(gap, "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("No alternatives identified");
  });

  it("escalates permission capability correctly", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap: CapabilityGap = {
      missing_capability: { name: "prod_db_read", type: "permission" },
      reason: "Need read access to production DB",
      alternatives: ["Use staging DB"],
      impact_description: "Churn analysis blocked",
    };
    await detector.escalateToUser(gap, "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.title).toContain("permission");
    expect(reports[0]!.title).toContain("prod_db_read");
  });

  it("escalates tool capability correctly", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap: CapabilityGap = {
      missing_capability: { name: "bash_executor", type: "tool" },
      reason: "Need shell execution capability",
      alternatives: [],
      impact_description: "Script execution blocked",
    };
    await detector.escalateToUser(gap, "goal-001");

    const reports = await reportingEngine.listReports("goal-001");
    expect(reports[0]!.title).toContain("tool");
    expect(reports[0]!.title).toContain("bash_executor");
  });
});

// ─── Integration: detect + escalate flow ───

describe("detectDeficiency + escalateToUser integration", () => {
  it("detects a deficiency and escalates to user in sequence", async () => {
    const llm = createMockLLMClient([SERVICE_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const task = makeTask({ id: "task-integrated" });
    const gap = await detector.detectDeficiency(task);
    expect(gap).not.toBeNull();

    await detector.escalateToUser(gap!, "goal-integrated");

    const reports = await reportingEngine.listReports("goal-integrated");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report_type).toBe("capability_escalation");
    expect(reports[0]!.content).toContain("Stripe API");
  });

  it("confirmDeficiency gates escalation based on failure count", async () => {
    const llm = createMockLLMClient([SERVICE_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const task = makeTask({ consecutive_failure_count: 2 });

    // Simulate: detect deficiency but failure count below threshold
    const confirmed = detector.confirmDeficiency(task.id, task.consecutive_failure_count);
    expect(confirmed).toBe(false);

    // Simulate: now at threshold
    const confirmedAt3 = detector.confirmDeficiency(task.id, 3);
    expect(confirmedAt3).toBe(true);
  });
});

// ─── planAcquisition ───

describe("planAcquisition", () => {
  it("selects tool_creation method when gap type is tool", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ missing_capability: { name: "bash_executor", type: "tool" } });
    const result = detector.planAcquisition(gap);

    expect(result.method).toBe("tool_creation");
  });

  it("selects permission_request method when gap type is permission", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ missing_capability: { name: "prod_db_read", type: "permission" } });
    const result = detector.planAcquisition(gap);

    expect(result.method).toBe("permission_request");
  });

  it("selects service_setup method when gap type is service", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ missing_capability: { name: "Stripe API", type: "service" } });
    const result = detector.planAcquisition(gap);

    expect(result.method).toBe("service_setup");
  });

  it("selects service_setup method when gap type is data_source", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ missing_capability: { name: "analytics_db", type: "data_source" } });
    const result = detector.planAcquisition(gap);

    expect(result.method).toBe("service_setup");
  });

  it("success_criteria always includes 'capability registered in registry'", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    for (const type of ["tool", "permission", "service", "data_source"] as const) {
      const gap = makeGap({ missing_capability: { name: "SomeCap", type } });
      const result = detector.planAcquisition(gap);
      expect(result.success_criteria).toContain("capability registered in registry");
    }
  });

  it("verification_attempts defaults to 0", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = detector.planAcquisition(makeGap());
    expect(result.verification_attempts).toBe(0);
  });

  it("max_verification_attempts defaults to 3", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = detector.planAcquisition(makeGap());
    expect(result.max_verification_attempts).toBe(3);
  });

  it("task_description is a non-empty string", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    for (const type of ["tool", "permission", "service", "data_source"] as const) {
      const gap = makeGap({ missing_capability: { name: "SomeCap", type } });
      const result = detector.planAcquisition(gap);
      expect(typeof result.task_description).toBe("string");
      expect(result.task_description.length).toBeGreaterThan(0);
    }
  });

  it("task_description includes the capability name", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ missing_capability: { name: "UniqueCapabilityName", type: "service" } });
    const result = detector.planAcquisition(gap);
    expect(result.task_description).toContain("UniqueCapabilityName");
  });

  it("gap is preserved in the returned task", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ missing_capability: { name: "Stripe API", type: "service" } });
    const result = detector.planAcquisition(gap);
    expect(result.gap.missing_capability.name).toBe("Stripe API");
    expect(result.gap.missing_capability.type).toBe("service");
  });
});
