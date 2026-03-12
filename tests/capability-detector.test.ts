import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { ReportingEngine } from "../src/reporting-engine.js";
import { CapabilityDetector } from "../src/capability-detector.js";
import { CapabilityRegistrySchema } from "../src/types/capability.js";
import type { Capability, CapabilityRegistry, CapabilityGap } from "../src/types/capability.js";
import type { Task } from "../src/types/task.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm-client.js";

// ─── Mock LLM Client ───

function createMockLLMClient(responses: string[]): ILLMClient & { callCount: number } {
  let callIndex = 0;
  return {
    get callCount() {
      return callIndex;
    },
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      const content = responses[callIndex++] ?? "{}";
      return {
        content,
        usage: { input_tokens: 10, output_tokens: content.length },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const jsonBlock = content.match(/```json\s*([\s\S]*?)```/);
      const genericBlock = content.match(/```\s*([\s\S]*?)```/);
      const jsonText = jsonBlock
        ? jsonBlock[1]!.trim()
        : genericBlock
          ? genericBlock[1]!.trim()
          : content.trim();
      return schema.parse(JSON.parse(jsonText));
    },
  };
}

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
