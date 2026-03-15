import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { ReportingEngine } from "../src/reporting-engine.js";
import { CapabilityDetector } from "../src/capability-detector.js";
import { CapabilityRegistrySchema } from "../src/types/capability.js";
import type {
  Capability,
  CapabilityRegistry,
  CapabilityGap,
  CapabilityAcquisitionTask,
  AcquisitionContext,
} from "../src/types/capability.js";
import type { Task } from "../src/types/task.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm-client.js";
import type { AgentResult } from "../src/adapter-layer.js";
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

const NO_DEFICIENCY_RESPONSE = JSON.stringify({ has_deficiency: false });

const TOOL_DEFICIENCY_RESPONSE = JSON.stringify({
  has_deficiency: true,
  missing_capability: { name: "bash_executor", type: "tool" },
  reason: "Task requires running shell commands",
  alternatives: ["Use a subprocess agent", "Implement via API instead"],
  impact_description: "Cannot execute shell scripts without this tool",
});

const PERMISSION_DEFICIENCY_RESPONSE = JSON.stringify({
  has_deficiency: true,
  missing_capability: { name: "prod_db_read", type: "permission" },
  reason: "Task requires read access to production database",
  alternatives: ["Request anonymized data export", "Use staging environment"],
  impact_description: "Cannot analyze production data without read permission",
});

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-capability-test-"));
  stateManager = new StateManager(tempDir);
  reportingEngine = new ReportingEngine(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── detectDeficiency ───

describe("detectDeficiency", () => {
  it("returns null when no deficiency detected", async () => {
    const llm = createMockLLMClient([NO_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const result = await detector.detectDeficiency(makeTask());
    expect(result).toBeNull();
  });

  it("returns CapabilityGap when missing tool is detected", async () => {
    const llm = createMockLLMClient([TOOL_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const result = await detector.detectDeficiency(makeTask());
    expect(result).not.toBeNull();
    expect(result!.missing_capability.name).toBe("bash_executor");
    expect(result!.missing_capability.type).toBe("tool");
  });

  it("returns CapabilityGap when missing permission is detected", async () => {
    const llm = createMockLLMClient([PERMISSION_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const result = await detector.detectDeficiency(makeTask());
    expect(result).not.toBeNull();
    expect(result!.missing_capability.name).toBe("prod_db_read");
    expect(result!.missing_capability.type).toBe("permission");
  });

  it("returns CapabilityGap when missing service is detected", async () => {
    const llm = createMockLLMClient([SERVICE_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const result = await detector.detectDeficiency(makeTask());
    expect(result).not.toBeNull();
    expect(result!.missing_capability.name).toBe("Stripe API");
    expect(result!.missing_capability.type).toBe("service");
  });

  it("includes related_task_id from the task", async () => {
    const llm = createMockLLMClient([SERVICE_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const task = makeTask({ id: "task-stripe-123" });
    const result = await detector.detectDeficiency(task);
    expect(result!.related_task_id).toBe("task-stripe-123");
  });

  it("populates alternatives array from LLM response", async () => {
    const llm = createMockLLMClient([SERVICE_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const result = await detector.detectDeficiency(makeTask());
    expect(result!.alternatives).toHaveLength(2);
    expect(result!.alternatives).toContain("Use cached payment data");
  });

  it("populates reason and impact_description from LLM response", async () => {
    const llm = createMockLLMClient([PERMISSION_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const result = await detector.detectDeficiency(makeTask());
    expect(result!.reason).toBe("Task requires read access to production database");
    expect(result!.impact_description).toBe("Cannot analyze production data without read permission");
  });

  it("calls LLM exactly once per detectDeficiency call", async () => {
    const llm = createMockLLMClient([NO_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    await detector.detectDeficiency(makeTask());
    expect(llm.callCount).toBe(1);
  });

  it("includes available capabilities from registry in LLM prompt context", async () => {
    const llm = createMockLLMClient([NO_DEFICIENCY_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // Pre-register a capability so it appears in the registry
    await detector.registerCapability(makeCapability({ name: "GitHub API", description: "GitHub access" }));

    // Spy on the LLM call by overriding sendMessage temporarily
    let capturedMessages: LLMMessage[] = [];
    const originalSend = llm.sendMessage.bind(llm);
    llm.sendMessage = async (messages, options) => {
      capturedMessages = messages;
      return originalSend(messages, options);
    };

    await detector.detectDeficiency(makeTask());
    expect(capturedMessages[0]!.content).toContain("GitHub API");
  });
});

// ─── loadRegistry ───

describe("loadRegistry", () => {
  it("returns empty registry when no file exists", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const registry = await detector.loadRegistry();
    expect(registry.capabilities).toHaveLength(0);
    expect(registry.last_checked).toBeTruthy();
  });

  it("last_checked is a valid ISO timestamp on empty registry", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    const registry = await detector.loadRegistry();
    expect(() => new Date(registry.last_checked)).not.toThrow();
    expect(new Date(registry.last_checked).toISOString()).toBe(registry.last_checked);
  });

  it("returns saved registry when file exists", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const stored: CapabilityRegistry = {
      capabilities: [makeCapability()],
      last_checked: "2026-01-01T00:00:00.000Z",
    };
    await detector.saveRegistry(stored);

    const loaded = await detector.loadRegistry();
    expect(loaded.capabilities).toHaveLength(1);
    expect(loaded.capabilities[0]!.name).toBe("Stripe API");
    expect(loaded.last_checked).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses all capability fields correctly", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap: Capability = {
      id: "cap-full",
      name: "Slack Webhook",
      description: "Send notifications to Slack",
      type: "service",
      status: "missing",
      provider: "Slack Inc.",
    };
    await detector.saveRegistry({ capabilities: [cap], last_checked: new Date().toISOString() });

    const loaded = await detector.loadRegistry();
    const loadedCap = loaded.capabilities[0]!;
    expect(loadedCap.id).toBe("cap-full");
    expect(loadedCap.name).toBe("Slack Webhook");
    expect(loadedCap.type).toBe("service");
    expect(loadedCap.status).toBe("missing");
    expect(loadedCap.provider).toBe("Slack Inc.");
  });
});

// ─── saveRegistry ───

describe("saveRegistry", () => {
  it("persists registry to disk", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const registry: CapabilityRegistry = {
      capabilities: [makeCapability()],
      last_checked: new Date().toISOString(),
    };
    await detector.saveRegistry(registry);

    const raw = stateManager.readRaw("capability_registry.json");
    expect(raw).not.toBeNull();
    const parsed = CapabilityRegistrySchema.parse(raw);
    expect(parsed.capabilities).toHaveLength(1);
  });

  it("overwrites existing registry on subsequent saves", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const registry1: CapabilityRegistry = {
      capabilities: [makeCapability({ id: "cap-a", name: "Cap A" })],
      last_checked: new Date().toISOString(),
    };
    await detector.saveRegistry(registry1);

    const registry2: CapabilityRegistry = {
      capabilities: [
        makeCapability({ id: "cap-a", name: "Cap A" }),
        makeCapability({ id: "cap-b", name: "Cap B" }),
      ],
      last_checked: new Date().toISOString(),
    };
    await detector.saveRegistry(registry2);

    const loaded = await detector.loadRegistry();
    expect(loaded.capabilities).toHaveLength(2);
  });

  it("validates registry with Zod schema before saving", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // Passing a valid registry should not throw
    const validRegistry: CapabilityRegistry = {
      capabilities: [],
      last_checked: new Date().toISOString(),
    };
    await expect(detector.saveRegistry(validRegistry)).resolves.toBeUndefined();
  });
});

// ─── registerCapability ───

describe("registerCapability", () => {
  it("adds a new capability to an empty registry", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-new", name: "New Tool" });
    await detector.registerCapability(cap);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities).toHaveLength(1);
    expect(registry.capabilities[0]!.id).toBe("cap-new");
  });

  it("appends to an existing registry", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-a", name: "Cap A" }));
    await detector.registerCapability(makeCapability({ id: "cap-b", name: "Cap B" }));

    const registry = await detector.loadRegistry();
    expect(registry.capabilities).toHaveLength(2);
  });

  it("updates an existing capability by id", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-x", status: "missing" }));
    await detector.registerCapability(makeCapability({ id: "cap-x", status: "available" }));

    const registry = await detector.loadRegistry();
    expect(registry.capabilities).toHaveLength(1);
    expect(registry.capabilities[0]!.status).toBe("available");
  });

  it("updates last_checked after registering", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const before = new Date().toISOString();
    await detector.registerCapability(makeCapability());
    const registry = await detector.loadRegistry();

    expect(registry.last_checked >= before).toBe(true);
  });

  it("registers capability with optional provider field", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap: Capability = {
      id: "cap-provider",
      name: "External API",
      description: "Some external API",
      type: "service",
      status: "available",
      provider: "ExternalCorp",
    };
    await detector.registerCapability(cap);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.provider).toBe("ExternalCorp");
  });

  it("registers capability without optional provider field", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap: Capability = {
      id: "cap-no-provider",
      name: "Local Tool",
      description: "A local tool",
      type: "tool",
      status: "available",
    };
    await detector.registerCapability(cap);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.provider).toBeUndefined();
  });
});

// ─── confirmDeficiency ───

describe("confirmDeficiency", () => {
  it("returns false when consecutiveFailures is 0", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    expect(detector.confirmDeficiency("task-001", 0)).toBe(false);
  });

  it("returns false when consecutiveFailures is 1", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    expect(detector.confirmDeficiency("task-001", 1)).toBe(false);
  });

  it("returns false when consecutiveFailures is 2", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    expect(detector.confirmDeficiency("task-001", 2)).toBe(false);
  });

  it("returns true when consecutiveFailures is exactly 3 (threshold)", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    expect(detector.confirmDeficiency("task-001", 3)).toBe(true);
  });

  it("returns true when consecutiveFailures exceeds threshold", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    expect(detector.confirmDeficiency("task-001", 5)).toBe(true);
    expect(detector.confirmDeficiency("task-001", 10)).toBe(true);
  });

  it("works for any task id (taskId is not used in logic)", () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);
    expect(detector.confirmDeficiency("different-task", 3)).toBe(true);
    expect(detector.confirmDeficiency("another-task", 2)).toBe(false);
  });
});

// ─── escalateToUser ───

describe("escalateToUser", () => {
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

  it("saves a notification report via ReportingEngine", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.report_type).toBe("capability_escalation");
  });

  it("notification message includes capability name and type", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports[0]!.title).toContain("Stripe API");
    expect(reports[0]!.title).toContain("service");
  });

  it("notification details include the reason", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("Task requires Stripe payment data");
  });

  it("notification details include alternatives", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("Use cached data");
    expect(reports[0]!.content).toContain("Request CSV export");
  });

  it("notification details include impact_description", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("Cannot fetch live payment data");
  });

  it("notification details include related_task_id when present", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap({ related_task_id: "task-stripe-999" }), "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).toContain("task-stripe-999");
  });

  it("notification details omit related_task_id when absent", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ related_task_id: undefined });
    await detector.escalateToUser(gap, "goal-001");

    const reports = reportingEngine.listReports("goal-001");
    expect(reports[0]!.content).not.toContain("Related Task");
  });

  it("notification is associated with the correct goalId", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.escalateToUser(makeGap(), "goal-xyz");

    const reports = reportingEngine.listReports("goal-xyz");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.goal_id).toBe("goal-xyz");
  });

  it("shows fallback message when no alternatives provided", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const gap = makeGap({ alternatives: [] });
    await detector.escalateToUser(gap, "goal-001");

    const reports = reportingEngine.listReports("goal-001");
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

    const reports = reportingEngine.listReports("goal-001");
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

    const reports = reportingEngine.listReports("goal-001");
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

    const reports = reportingEngine.listReports("goal-integrated");
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

// ─── Fixtures for new tests ───

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

function makeAcquisitionTask(overrides: Partial<CapabilityAcquisitionTask> = {}): CapabilityAcquisitionTask {
  return {
    gap: makeGap(),
    method: "service_setup",
    task_description: "Set up the Stripe API service",
    success_criteria: ["capability registered in registry", "Stripe API is operational and accessible"],
    verification_attempts: 0,
    max_verification_attempts: 3,
    ...overrides,
  };
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    output: "Service configured successfully. Health check passed.",
    error: null,
    exit_code: 0,
    elapsed_ms: 1234,
    stopped_reason: "completed",
    ...overrides,
  };
}

const VERIFY_PASS_RESPONSE = JSON.stringify({ verdict: "pass", reason: "All checks passed successfully." });
const VERIFY_FAIL_RESPONSE = JSON.stringify({ verdict: "fail", reason: "Service did not respond to health check." });

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

// ─── verifyAcquiredCapability ───

describe("verifyAcquiredCapability", () => {
  it("returns 'pass' when LLM says verdict is pass", async () => {
    const llm = createMockLLMClient([VERIFY_PASS_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      makeAcquisitionTask(),
      makeAgentResult()
    );

    expect(result).toBe("pass");
  });

  it("returns 'fail' when LLM says fail and attempts < max", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 0, max_verification_attempts: 3 });
    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(result).toBe("fail");
  });

  it("returns 'escalate' when verification_attempts reaches max_verification_attempts after fail", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // At 2 attempts with max 3: after this fail it will be 3 which equals max → escalate
    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 2, max_verification_attempts: 3 });
    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(result).toBe("escalate");
  });

  it("returns 'escalate' when verification_attempts already exceeds max on fail", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 5, max_verification_attempts: 3 });
    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(result).toBe("escalate");
  });

  it("calls LLM exactly once per verifyAcquiredCapability call", async () => {
    const llm = createMockLLMClient([VERIFY_PASS_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.verifyAcquiredCapability(
      makeCapability(),
      makeAcquisitionTask(),
      makeAgentResult()
    );

    expect(llm.callCount).toBe(1);
  });

  it("increments verification_attempts on fail", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 0, max_verification_attempts: 3 });
    await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(acquisitionTask.verification_attempts).toBe(1);
  });

  it("does not increment verification_attempts on pass", async () => {
    const llm = createMockLLMClient([VERIFY_PASS_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 0 });
    await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(acquisitionTask.verification_attempts).toBe(0);
  });
});

// ─── removeCapability ───

describe("removeCapability", () => {
  it("removes a capability from the registry by id", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-remove", name: "ToRemove" }));
    await detector.removeCapability("cap-remove");

    const registry = await detector.loadRegistry();
    expect(registry.capabilities.find((c) => c.id === "cap-remove")).toBeUndefined();
  });

  it("is a no-op for a non-existent id (does not throw)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await expect(detector.removeCapability("nonexistent-cap-id")).resolves.toBeUndefined();
  });

  it("does not remove other capabilities when removing by id", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-a", name: "Cap A" }));
    await detector.registerCapability(makeCapability({ id: "cap-b", name: "Cap B" }));
    await detector.removeCapability("cap-a");

    const registry = await detector.loadRegistry();
    expect(registry.capabilities).toHaveLength(1);
    expect(registry.capabilities[0]!.id).toBe("cap-b");
  });

  it("persists the registry after removal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-persist", name: "Persistent Cap" }));
    await detector.removeCapability("cap-persist");

    // Reload registry from disk via a new detector instance sharing same stateManager
    const detector2 = new CapabilityDetector(stateManager, llm, reportingEngine);
    const registry = await detector2.loadRegistry();
    expect(registry.capabilities.find((c) => c.id === "cap-persist")).toBeUndefined();
  });
});

// ─── findCapabilityByName ───

describe("findCapabilityByName", () => {
  it("finds a capability by exact name", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-find", name: "Stripe API" }));
    const found = await detector.findCapabilityByName("Stripe API");

    expect(found).not.toBeNull();
    expect(found!.id).toBe("cap-find");
  });

  it("finds a capability case-insensitively (uppercase input)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-ci", name: "stripe api" }));
    const found = await detector.findCapabilityByName("STRIPE API");

    expect(found).not.toBeNull();
    expect(found!.id).toBe("cap-ci");
  });

  it("finds a capability case-insensitively (mixed case input)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-mixed", name: "GitHub API" }));
    const found = await detector.findCapabilityByName("github api");

    expect(found).not.toBeNull();
    expect(found!.id).toBe("cap-mixed");
  });

  it("returns null when no capability matches the name", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const found = await detector.findCapabilityByName("NonExistent Capability");
    expect(found).toBeNull();
  });

  it("returns null on empty registry", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const found = await detector.findCapabilityByName("anything");
    expect(found).toBeNull();
  });

  it("returns the first match when multiple capabilities share the same name (case-insensitively)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-first", name: "Duplicate" }));
    await detector.registerCapability(makeCapability({ id: "cap-second", name: "duplicate" }));

    const found = await detector.findCapabilityByName("DUPLICATE");
    expect(found).not.toBeNull();
    // Should return the first registered match
    expect(found!.id).toBe("cap-first");
  });
});

// ─── registerCapability (updated signature with context) ───

describe("registerCapability with context", () => {
  const makeAcquisitionContext = (overrides: Partial<AcquisitionContext> = {}): AcquisitionContext => ({
    goal_id: "goal-001",
    originating_task_id: "task-001",
    acquired_at: "2026-03-15T00:00:00.000Z",
    notes: "Acquired during capability gap resolution",
    ...overrides,
  });

  it("works without context (backward compatible)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-no-ctx", name: "No Context Cap" });
    await expect(detector.registerCapability(cap)).resolves.toBeUndefined();

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquisition_context).toBeUndefined();
    expect(registry.capabilities[0]!.acquired_at).toBeUndefined();
  });

  it("sets acquired_at on the capability when context is provided", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-ctx", name: "Context Cap" });
    const ctx = makeAcquisitionContext({ acquired_at: "2026-03-15T00:00:00.000Z" });
    await detector.registerCapability(cap, ctx);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquired_at).toBe("2026-03-15T00:00:00.000Z");
  });

  it("sets acquisition_context on the capability when context is provided", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-ctx2", name: "Context Cap 2" });
    const ctx = makeAcquisitionContext({ goal_id: "goal-ctx" });
    await detector.registerCapability(cap, ctx);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquisition_context).toEqual(ctx);
  });

  it("acquisition_context.goal_id is preserved correctly", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-goalid", name: "Goal ID Cap" });
    const ctx = makeAcquisitionContext({ goal_id: "goal-special-xyz" });
    await detector.registerCapability(cap, ctx);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquisition_context!.goal_id).toBe("goal-special-xyz");
  });
});

// ─── getAcquisitionHistory ───

describe("getAcquisitionHistory", () => {
  const makeAcquisitionContext = (goalId: string, overrides: Partial<AcquisitionContext> = {}): AcquisitionContext => ({
    goal_id: goalId,
    originating_task_id: "task-001",
    acquired_at: new Date().toISOString(),
    ...overrides,
  });

  it("returns contexts for capabilities acquired for the given goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const ctx = makeAcquisitionContext("goal-history");
    await detector.registerCapability(makeCapability({ id: "cap-h1", name: "History Cap 1" }), ctx);

    const history = await detector.getAcquisitionHistory("goal-history");
    expect(history).toHaveLength(1);
    expect(history[0]!.goal_id).toBe("goal-history");
  });

  it("returns multiple contexts when multiple capabilities share the same goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const ctx1 = makeAcquisitionContext("goal-multi");
    const ctx2 = makeAcquisitionContext("goal-multi");
    await detector.registerCapability(makeCapability({ id: "cap-m1", name: "Multi Cap 1" }), ctx1);
    await detector.registerCapability(makeCapability({ id: "cap-m2", name: "Multi Cap 2" }), ctx2);

    const history = await detector.getAcquisitionHistory("goal-multi");
    expect(history).toHaveLength(2);
  });

  it("returns empty array when no capabilities match the given goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const history = await detector.getAcquisitionHistory("goal-nonexistent");
    expect(history).toHaveLength(0);
  });

  it("returns empty array when registry is empty", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const history = await detector.getAcquisitionHistory("goal-any");
    expect(history).toEqual([]);
  });

  it("does not return contexts belonging to a different goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const ctxA = makeAcquisitionContext("goal-a");
    const ctxB = makeAcquisitionContext("goal-b");
    await detector.registerCapability(makeCapability({ id: "cap-a", name: "Cap A" }), ctxA);
    await detector.registerCapability(makeCapability({ id: "cap-b", name: "Cap B" }), ctxB);

    const historyA = await detector.getAcquisitionHistory("goal-a");
    expect(historyA).toHaveLength(1);
    expect(historyA[0]!.goal_id).toBe("goal-a");
  });

  it("excludes capabilities that have no acquisition_context", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // Register one without context, one with context for goal-x
    await detector.registerCapability(makeCapability({ id: "cap-no-ctx", name: "No Ctx" }));
    const ctx = makeAcquisitionContext("goal-x");
    await detector.registerCapability(makeCapability({ id: "cap-with-ctx", name: "With Ctx" }), ctx);

    // goal-x should only return the one with context
    const history = await detector.getAcquisitionHistory("goal-x");
    expect(history).toHaveLength(1);
    expect(history[0]!.goal_id).toBe("goal-x");
  });
});

// ─── detectGoalCapabilityGap ───

const NO_GOAL_GAP_RESPONSE = JSON.stringify({ has_gap: false });

const GOAL_GAP_SERVICE_RESPONSE = JSON.stringify({
  has_gap: true,
  missing_capability: { name: "close_github_issue", type: "service" },
  reason: "Goal requires closing resolved issues but adapter only supports creating them",
  alternatives: ["Manually close issues via GitHub UI", "Use a different adapter that supports issue management"],
  impact_description: "Cannot automatically close issues when tasks are completed",
  acquirable: true,
});

const GOAL_GAP_NOT_ACQUIRABLE_RESPONSE = JSON.stringify({
  has_gap: true,
  missing_capability: { name: "production_db_write", type: "permission" },
  reason: "Goal requires writing to production database",
  alternatives: [],
  impact_description: "Cannot persist results without production write access",
  acquirable: false,
});

describe("detectGoalCapabilityGap", () => {
  it("returns null when no capability gap detected", async () => {
    const llm = createMockLLMClient([NO_GOAL_GAP_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Create GitHub issues for each open task",
      ["create_github_issue"]
    );

    expect(result).toBeNull();
  });

  it("returns CapabilityGap when goal requires unavailable capability", async () => {
    const llm = createMockLLMClient([GOAL_GAP_SERVICE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Manage GitHub issues: create and close them as tasks complete",
      ["create_github_issue"]
    );

    expect(result).not.toBeNull();
    expect(result!.gap.missing_capability.name).toBe("close_github_issue");
    expect(result!.gap.missing_capability.type).toBe("service");
    expect(result!.gap.reason).toContain("closing resolved issues");
    expect(result!.gap.alternatives).toHaveLength(2);
  });

  it("includes registry capabilities in available list (prompt context)", async () => {
    const llm = createMockLLMClient([NO_GOAL_GAP_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // Pre-register a registry capability so it should appear in the prompt
    await detector.registerCapability(makeCapability({
      id: "cap-registry",
      name: "Jira API",
      description: "Access to Jira project management",
      type: "service",
      status: "available",
    }));

    let capturedMessages: LLMMessage[] = [];
    const originalSend = llm.sendMessage.bind(llm);
    llm.sendMessage = async (messages, options) => {
      capturedMessages = messages;
      return originalSend(messages, options);
    };

    await detector.detectGoalCapabilityGap(
      "Track project tasks in Jira",
      ["execute_code"]
    );

    expect(capturedMessages[0]!.content).toContain("Jira API");
    expect(capturedMessages[0]!.content).toContain("execute_code");
  });

  it("handles LLM failure gracefully — returns null", async () => {
    // MockLLMClient throws when responses are exhausted
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Some goal description",
      ["create_github_issue"]
    );

    expect(result).toBeNull();
  });

  it("returns gap with related_task_id undefined — goal-level gap has no task", async () => {
    const llm = createMockLLMClient([GOAL_GAP_SERVICE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Manage GitHub issues end-to-end",
      ["create_github_issue"]
    );

    expect(result).not.toBeNull();
    expect(result!.gap.related_task_id).toBeUndefined();
  });

  it("returns acquirable=true when capability can be acquired", async () => {
    const llm = createMockLLMClient([GOAL_GAP_SERVICE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Manage GitHub issues end-to-end",
      ["create_github_issue"]
    );

    expect(result).not.toBeNull();
    expect(result!.acquirable).toBe(true);
    expect(result!.gap.alternatives.length).toBeGreaterThan(0);
  });

  it("returns acquirable=false when capability cannot be acquired", async () => {
    const llm = createMockLLMClient([GOAL_GAP_NOT_ACQUIRABLE_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Persist results to production database",
      []
    );

    expect(result).not.toBeNull();
    expect(result!.acquirable).toBe(false);
    expect(result!.gap.missing_capability.name).toBe("production_db_write");
  });

  it("handles malformed LLM response gracefully — returns null", async () => {
    const llm = createMockLLMClient(["not valid json"]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.detectGoalCapabilityGap(
      "Some goal description",
      ["create_github_issue"]
    );

    expect(result).toBeNull();
  });
});
