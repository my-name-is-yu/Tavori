import { z } from "zod";
import { StateManager } from "./state-manager.js";
import { ReportingEngine } from "./reporting-engine.js";
import type { ILLMClient } from "./llm-client.js";
import type { Task } from "./types/task.js";
import {
  CapabilitySchema,
  CapabilityRegistrySchema,
  CapabilityGapSchema,
} from "./types/capability.js";
import type {
  Capability,
  CapabilityRegistry,
  CapabilityGap,
} from "./types/capability.js";

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
   */
  async registerCapability(cap: Capability): Promise<void> {
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
