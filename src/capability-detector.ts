import { z } from "zod";
import { StateManager } from "./state-manager.js";
import { ReportingEngine } from "./reporting-engine.js";
import type { ILLMClient } from "./llm-client.js";
import type { Task } from "./types/task.js";
import {
  CapabilitySchema,
  CapabilityRegistrySchema,
  CapabilityGapSchema,
  CapabilityAcquisitionTaskSchema,
} from "./types/capability.js";
import type {
  Capability,
  CapabilityRegistry,
  CapabilityGap,
  CapabilityStatus,
  AcquisitionContext,
  CapabilityAcquisitionTask,
  CapabilityVerificationResult,
} from "./types/capability.js";
import type { AgentResult } from "./adapter-layer.js";

// ─── Constants ───

const REGISTRY_PATH = "capability_registry.json";
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// ─── LLM response schema for deficiency detection ───

const DeficiencyResponseSchema = z.union([
  z.object({
    has_deficiency: z.literal(false),
  }),
  z.object({
    has_deficiency: z.literal(true),
    missing_capability: z.object({
      name: z.string(),
      type: z.enum(["tool", "permission", "service"]),
    }),
    reason: z.string(),
    alternatives: z.array(z.string()),
    impact_description: z.string(),
  }),
]);

// ─── LLM response schema for goal-level capability gap detection ───

const GoalCapabilityGapResponseSchema = z.union([
  z.object({
    has_gap: z.literal(false),
  }),
  z.object({
    has_gap: z.literal(true),
    missing_capability: z.object({
      name: z.string(),
      type: z.enum(["tool", "permission", "service", "data_source"]),
    }),
    reason: z.string(),
    alternatives: z.array(z.string()),
    impact_description: z.string(),
    acquirable: z.boolean(),
  }),
]);

// ─── CapabilityDetector ───

export class CapabilityDetector {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly reportingEngine: ReportingEngine;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    reportingEngine: ReportingEngine
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.reportingEngine = reportingEngine;
  }

  // ─── detectDeficiency ───

  /**
   * Analyzes a task description against the capability registry via LLM.
   * Returns a CapabilityGap if the task requires unavailable capabilities,
   * or null if all required capabilities are available.
   */
  async detectDeficiency(task: Task): Promise<CapabilityGap | null> {
    const registry = await this.loadRegistry();

    const availableCapabilities = registry.capabilities
      .filter((c) => c.status === "available")
      .map((c) => `- ${c.name} (${c.type}): ${c.description}`)
      .join("\n");

    const systemPrompt =
      "You are a capability analyzer for an AI orchestration system. " +
      "Your job is to determine whether a given task can be executed with the available capabilities. " +
      "Respond with valid JSON only — no markdown, no explanation outside the JSON.";

    const userMessage =
      `Analyze the following task and determine if any required capabilities are missing.\n\n` +
      `Task description: ${task.work_description}\n` +
      `Task rationale: ${task.rationale}\n` +
      `Task approach: ${task.approach}\n\n` +
      `Available capabilities:\n${availableCapabilities || "(none registered)"}\n\n` +
      `Respond with JSON in one of these two formats:\n` +
      `If all capabilities are available:\n` +
      `{ "has_deficiency": false }\n\n` +
      `If a capability is missing:\n` +
      `{\n` +
      `  "has_deficiency": true,\n` +
      `  "missing_capability": { "name": "<name>", "type": "tool|permission|service" },\n` +
      `  "reason": "<why this capability is needed>",\n` +
      `  "alternatives": ["<alternative approach 1>", "<alternative approach 2>"],\n` +
      `  "impact_description": "<impact if capability remains unavailable>"\n` +
      `}`;

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: userMessage }],
      { system: systemPrompt }
    );

    const parsed = this.llmClient.parseJSON(response.content, DeficiencyResponseSchema);

    if (!parsed.has_deficiency) {
      return null;
    }

    const gap = CapabilityGapSchema.parse({
      missing_capability: parsed.missing_capability,
      reason: parsed.reason,
      alternatives: parsed.alternatives,
      impact_description: parsed.impact_description,
      related_task_id: task.id,
    });

    return gap;
  }

  // ─── detectGoalCapabilityGap ───

  /**
   * Goal-level analog of detectDeficiency(). Takes a goal description and a flat
   * list of adapter capability strings (e.g. ["create_github_issue", "execute_code"]),
   * combines them with registry capabilities, and uses LLM to determine if any
   * capabilities required by the goal are missing.
   *
   * Returns a CapabilityGap (without related_task_id) if a gap is found, or null if
   * all required capabilities are available.
   */
  async detectGoalCapabilityGap(
    goalDescription: string,
    adapterCapabilities: string[]
  ): Promise<{ gap: CapabilityGap; acquirable: boolean } | null> {
    try {
      const registry = await this.loadRegistry();

      const registryCapabilityLines = registry.capabilities
        .filter((c) => c.status === "available")
        .map((c) => `- ${c.name} (${c.type}): ${c.description}`);

      const adapterCapabilityLines = adapterCapabilities.map(
        (cap) => `- ${cap} (adapter-declared)`
      );

      const allAvailableLines = [...registryCapabilityLines, ...adapterCapabilityLines];
      const availableCapabilities =
        allAvailableLines.length > 0 ? allAvailableLines.join("\n") : "(none registered)";

      const systemPrompt =
        "You are a capability analyzer for an AI orchestration system. " +
        "Your job is to determine whether a given goal can be achieved with the available capabilities. " +
        "Respond with valid JSON only — no markdown, no explanation outside the JSON.";

      const userMessage =
        `Analyze the following goal and determine if any required capabilities are missing.\n\n` +
        `Goal description: ${goalDescription}\n\n` +
        `Available capabilities (from capability registry and declared adapter capabilities):\n${availableCapabilities}\n\n` +
        `Respond with JSON in one of these two formats:\n` +
        `If all capabilities are available:\n` +
        `{ "has_gap": false }\n\n` +
        `If a capability is missing:\n` +
        `{\n` +
        `  "has_gap": true,\n` +
        `  "missing_capability": { "name": "<name>", "type": "tool|permission|service|data_source" },\n` +
        `  "reason": "<why this capability is needed>",\n` +
        `  "alternatives": ["<alternative approach 1>", "<alternative approach 2>"],\n` +
        `  "impact_description": "<impact if capability remains unavailable>",\n` +
        `  "acquirable": true|false\n` +
        `}`;

      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: systemPrompt }
      );

      let parsed: z.infer<typeof GoalCapabilityGapResponseSchema>;
      try {
        parsed = this.llmClient.parseJSON(response.content, GoalCapabilityGapResponseSchema);
      } catch {
        return null;
      }

      if (!parsed.has_gap) {
        return null;
      }

      const gap = CapabilityGapSchema.parse({
        missing_capability: parsed.missing_capability,
        reason: parsed.reason,
        alternatives: parsed.alternatives,
        impact_description: parsed.impact_description,
        // related_task_id intentionally omitted — this is goal-level, not task-level
      });

      return { gap, acquirable: parsed.acquirable ?? false };
    } catch {
      return null;
    }
  }

  // ─── loadRegistry ───

  /**
   * Reads capability registry from ~/.motiva/capability_registry.json.
   * Returns an empty registry if the file does not exist.
   */
  async loadRegistry(): Promise<CapabilityRegistry> {
    const raw = this.stateManager.readRaw(REGISTRY_PATH);
    if (raw === null) {
      return CapabilityRegistrySchema.parse({
        capabilities: [],
        last_checked: new Date().toISOString(),
      });
    }
    return CapabilityRegistrySchema.parse(raw);
  }

  // ─── saveRegistry ───

  /**
   * Persists the capability registry to disk.
   */
  async saveRegistry(registry: CapabilityRegistry): Promise<void> {
    const parsed = CapabilityRegistrySchema.parse(registry);
    this.stateManager.writeRaw(REGISTRY_PATH, parsed);
  }

  // ─── registerCapability ───

  /**
   * Adds a capability to the registry (or updates an existing one by id) and saves.
   * If context is provided, sets acquisition_context and acquired_at on the capability.
   */
  async registerCapability(cap: Capability, context?: AcquisitionContext): Promise<void> {
    if (context !== undefined) {
      cap.acquisition_context = context;
      cap.acquired_at = context.acquired_at;
    }

    const parsed = CapabilitySchema.parse(cap);
    const registry = await this.loadRegistry();

    const existingIndex = registry.capabilities.findIndex((c) => c.id === parsed.id);
    if (existingIndex >= 0) {
      registry.capabilities[existingIndex] = parsed;
    } else {
      registry.capabilities.push(parsed);
    }

    registry.last_checked = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  // ─── confirmDeficiency ───

  /**
   * Returns true if consecutiveFailures has reached the escalation threshold (>= 3).
   * This confirms that repeated failures are due to a capability deficiency.
   */
  confirmDeficiency(_taskId: string, consecutiveFailures: number): boolean {
    return consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD;
  }

  // ─── planAcquisition ───

  /**
   * Deterministically creates a CapabilityAcquisitionTask from a CapabilityGap.
   * Pure synchronous function — no LLM needed. Rules from design doc §5.3.
   */
  planAcquisition(gap: CapabilityGap): CapabilityAcquisitionTask {
    const capabilityName = gap.missing_capability.name;
    const capabilityType = gap.missing_capability.type;

    let method: CapabilityAcquisitionTask["method"];
    let task_description: string;

    if (capabilityType === "tool") {
      method = "tool_creation";
      task_description =
        `Create a tool named "${capabilityName}" that fulfills the following need: ${gap.reason}. ` +
        `The tool should be implemented and made available for use. ` +
        `Impact if unavailable: ${gap.impact_description}`;
    } else if (capabilityType === "permission") {
      method = "permission_request";
      task_description =
        `Request permission for "${capabilityName}" from the user or system administrator. ` +
        `Reason the permission is needed: ${gap.reason}. ` +
        `Impact if unavailable: ${gap.impact_description}`;
    } else if (capabilityType === "service") {
      method = "service_setup";
      task_description =
        `Set up the service "${capabilityName}" required for the following reason: ${gap.reason}. ` +
        `Configure and verify the service is operational. ` +
        `Impact if unavailable: ${gap.impact_description}`;
    } else {
      // data_source — treated as a form of service setup
      method = "service_setup";
      task_description =
        `Set up access to the data source "${capabilityName}" required for the following reason: ${gap.reason}. ` +
        `Configure and verify the data source is accessible. ` +
        `Impact if unavailable: ${gap.impact_description}`;
    }

    return CapabilityAcquisitionTaskSchema.parse({
      gap,
      method,
      task_description,
      success_criteria: [
        "capability registered in registry",
        `${capabilityName} is operational and accessible`,
      ],
      verification_attempts: 0,
      max_verification_attempts: 3,
    });
  }

  // ─── verifyAcquiredCapability ───

  /**
   * Uses LLM to verify a newly acquired capability.
   * Checks basic operation, error handling, and scope boundary.
   * Returns "pass", "fail", or "escalate" (if max verification attempts reached).
   */
  async verifyAcquiredCapability(
    capability: Capability,
    acquisitionTask: CapabilityAcquisitionTask,
    agentResult: AgentResult
  ): Promise<CapabilityVerificationResult> {
    const systemPrompt =
      "You are a capability verifier for an AI orchestration system. " +
      "Your job is to assess whether a newly acquired capability is ready for use. " +
      "Respond with valid JSON only — no markdown, no explanation outside the JSON.";

    const userMessage =
      `Verify the following acquired capability.\n\n` +
      `Capability name: ${capability.name}\n` +
      `Capability type: ${capability.type}\n` +
      `Capability description: ${capability.description}\n\n` +
      `Acquisition task: ${acquisitionTask.task_description}\n` +
      `Success criteria: ${acquisitionTask.success_criteria.join("; ")}\n\n` +
      `Agent result output:\n${agentResult.output}\n\n` +
      `Evaluate the following three criteria:\n` +
      `1. Basic operation — does the capability work as described?\n` +
      `2. Error handling — does it handle edge cases gracefully?\n` +
      `3. Scope boundary — does it only do what is intended and nothing more?\n\n` +
      `Respond with JSON in this format:\n` +
      `{ "verdict": "pass" | "fail", "reason": "<explanation>" }`;

    const VerificationResponseSchema = z.object({
      verdict: z.enum(["pass", "fail"]),
      reason: z.string(),
    });

    const response = await this.llmClient.sendMessage(
      [{ role: "user", content: userMessage }],
      { system: systemPrompt }
    );

    const parsed = this.llmClient.parseJSON(response.content, VerificationResponseSchema);

    if (parsed.verdict === "fail") {
      acquisitionTask.verification_attempts += 1;
      if (acquisitionTask.verification_attempts >= acquisitionTask.max_verification_attempts) {
        return "escalate";
      }
      return "fail";
    }

    return "pass";
  }

  // ─── removeCapability ───

  /**
   * Removes a capability from the registry by id and saves.
   */
  async removeCapability(capabilityId: string): Promise<void> {
    const registry = await this.loadRegistry();
    registry.capabilities = registry.capabilities.filter((c) => c.id !== capabilityId);
    registry.last_checked = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  // ─── findCapabilityByName ───

  /**
   * Finds the first capability in the registry matching the given name (case-insensitive).
   * Returns null if no match is found.
   */
  async findCapabilityByName(name: string): Promise<Capability | null> {
    const registry = await this.loadRegistry();
    const lowerName = name.toLowerCase();
    const found = registry.capabilities.find((c) => c.name.toLowerCase() === lowerName);
    return found ?? null;
  }

  // ─── getAcquisitionHistory ───

  /**
   * Returns all AcquisitionContext entries for capabilities acquired in service of a given goal.
   */
  async getAcquisitionHistory(goalId: string): Promise<AcquisitionContext[]> {
    const registry = await this.loadRegistry();
    return registry.capabilities
      .filter(
        (c) =>
          c.acquisition_context !== undefined && c.acquisition_context.goal_id === goalId
      )
      .map((c) => c.acquisition_context as AcquisitionContext);
  }

  // ─── setCapabilityStatus ───

  /**
   * Updates the status of a capability in the registry by name, or creates a
   * placeholder entry if no capability with that name exists yet.
   */
  async setCapabilityStatus(
    capabilityName: string,
    capabilityType: CapabilityGap["missing_capability"]["type"],
    status: CapabilityStatus
  ): Promise<void> {
    const registry = await this.loadRegistry();
    const existing = registry.capabilities.find((c) => c.name === capabilityName);

    if (existing) {
      existing.status = status;
    } else {
      registry.capabilities.push(
        CapabilitySchema.parse({
          id: capabilityName.toLowerCase().replace(/\s+/g, "_"),
          name: capabilityName,
          description: "Auto-registered during acquisition flow",
          type: capabilityType,
          status,
        })
      );
    }

    registry.last_checked = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  // ─── escalateToUser ───

  /**
   * Fires a capability_insufficient notification via ReportingEngine with a
   * structured message describing what is missing, why, alternatives, and impact.
   */
  async escalateToUser(gap: CapabilityGap, goalId: string): Promise<void> {
    const capabilityName = gap.missing_capability.name;
    const capabilityType = gap.missing_capability.type;

    const alternativesList =
      gap.alternatives.length > 0
        ? gap.alternatives.map((a) => `- ${a}`).join("\n")
        : "_No alternatives identified._";

    const details =
      `**Missing Capability**: ${capabilityName} (${capabilityType})\n\n` +
      `**Why It Is Needed**: ${gap.reason}\n\n` +
      `**Alternatives**:\n${alternativesList}\n\n` +
      `**Impact If Unavailable**: ${gap.impact_description}` +
      (gap.related_task_id ? `\n\n**Related Task**: ${gap.related_task_id}` : "");

    const notification = this.reportingEngine.generateNotification(
      "capability_insufficient",
      {
        goalId,
        message: `Missing ${capabilityType}: ${capabilityName}`,
        details,
      }
    );

    try {
      this.reportingEngine.saveReport(notification);
    } catch (err) {
      console.error(
        "[CapabilityDetector] escalateToUser: failed to save report — " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
}
