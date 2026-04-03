import { z } from "zod";
import { StateManager } from "../state/state-manager.js";
import { ReportingEngine } from "../reporting/reporting-engine.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { Task } from "../types/task.js";
import type { PluginMatchResult } from "../types/plugin.js";
import type { PluginLoader } from "../runtime/plugin-loader.js";
import {
  CapabilityAcquisitionTaskSchema,
  CapabilityGapSchema,
} from "../types/capability.js";
import type {
  Capability,
  CapabilityRegistry,
  CapabilityGap,
  CapabilityStatus,
  AcquisitionContext,
  CapabilityAcquisitionTask,
  CapabilityVerificationResult,
  CapabilityDependency,
} from "../types/capability.js";
import type { AgentResult } from "../execution/adapter-layer.js";
import {
  loadRegistry,
  saveRegistry,
  registerCapability,
  removeCapability,
  findCapabilityByName,
  getAcquisitionHistory,
  setCapabilityStatus,
  escalateToUser,
} from "./capability-registry.js";
import {
  loadDependencies,
  saveDependencies,
  addDependency,
  getDependencies,
  resolveDependencies,
  detectCircularDependency,
  getAcquisitionOrder,
} from "./capability-dependencies.js";

// ─── Constants ───

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
  private readonly pluginLoader?: PluginLoader;
  private readonly gateway?: IPromptGateway;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    reportingEngine: ReportingEngine,
    pluginLoader?: PluginLoader,
    gateway?: IPromptGateway
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.reportingEngine = reportingEngine;
    this.pluginLoader = pluginLoader;
    this.gateway = gateway;
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

    let parsed: z.infer<typeof DeficiencyResponseSchema>;
    if (this.gateway) {
      parsed = await this.gateway.execute({
        purpose: "capability_detect",
        additionalContext: { deficiency_prompt: userMessage },
        responseSchema: DeficiencyResponseSchema,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: systemPrompt }
      );
      parsed = this.llmClient.parseJSON(response.content, DeficiencyResponseSchema);
    }

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
    adapterCapabilities: string[],
    goalDimensions?: string[]
  ): Promise<{ gap: CapabilityGap; acquirable: boolean; suggestedPlugins?: PluginMatchResult[] } | null> {
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

      let parsed: z.infer<typeof GoalCapabilityGapResponseSchema>;
      if (this.gateway) {
        parsed = await this.gateway.execute({
          purpose: "capability_goal_gap",
          additionalContext: { goal_gap_prompt: userMessage },
          responseSchema: GoalCapabilityGapResponseSchema,
        });
      } else {
        const response = await this.llmClient.sendMessage(
          [{ role: "user", content: userMessage }],
          { system: systemPrompt }
        );
        try {
          parsed = this.llmClient.parseJSON(response.content, GoalCapabilityGapResponseSchema);
        } catch (err) {
          console.warn(`[CapabilityDetector] Failed to parse LLM response as GoalCapabilityGapResponse: ${String(err)}`);
          return null;
        }
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

      const result: { gap: CapabilityGap; acquirable: boolean; suggestedPlugins?: PluginMatchResult[] } = {
        gap,
        acquirable: parsed.acquirable ?? false,
      };

      if (this.pluginLoader && goalDimensions && goalDimensions.length > 0) {
        result.suggestedPlugins = await this.matchPluginsForGoal(goalDimensions);
      }

      return result;
    } catch {
      return null;
    }
  }

  // ─── matchPluginsForGoal ───

  /**
   * Finds installed plugins that match the goal's dimensions.
   * Returns plugins with matchScore >= 0.5, sorted by score then trust.
   */
  async matchPluginsForGoal(goalDimensions: string[]): Promise<PluginMatchResult[]> {
    if (!this.pluginLoader || goalDimensions.length === 0) {
      return [];
    }

    const pluginStates = await this.pluginLoader.loadAll();

    const results: PluginMatchResult[] = [];

    for (const state of pluginStates) {
      if (state.status !== "loaded") continue;

      const pluginDimensions = state.manifest.dimensions ?? [];
      if (pluginDimensions.length === 0) continue;

      const matchedDimensions = goalDimensions.filter((d) => pluginDimensions.includes(d));
      const matchScore = matchedDimensions.length / goalDimensions.length;

      if (matchScore < 0.5) continue;

      results.push({
        pluginName: state.name,
        matchScore,
        matchedDimensions,
        trustScore: state.trust_score,
        autoSelectable: state.trust_score >= 20,
      });
    }

    // Sort by matchScore descending, then trustScore descending
    results.sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return b.trustScore - a.trustScore;
    });

    return results;
  }

  // ─── Registry wrappers ───

  async loadRegistry(): Promise<CapabilityRegistry> {
    return loadRegistry({ stateManager: this.stateManager });
  }

  async saveRegistry(registry: CapabilityRegistry): Promise<void> {
    return saveRegistry({ stateManager: this.stateManager }, registry);
  }

  async registerCapability(cap: Capability, context?: AcquisitionContext): Promise<void> {
    return registerCapability({ stateManager: this.stateManager }, cap, context);
  }

  async removeCapability(capabilityId: string): Promise<void> {
    return removeCapability({ stateManager: this.stateManager }, capabilityId);
  }

  async findCapabilityByName(name: string): Promise<Capability | null> {
    return findCapabilityByName({ stateManager: this.stateManager }, name);
  }

  async getAcquisitionHistory(goalId: string): Promise<AcquisitionContext[]> {
    return getAcquisitionHistory({ stateManager: this.stateManager }, goalId);
  }

  async setCapabilityStatus(
    capabilityName: string,
    capabilityType: CapabilityGap["missing_capability"]["type"],
    status: CapabilityStatus
  ): Promise<void> {
    return setCapabilityStatus(
      { stateManager: this.stateManager },
      capabilityName,
      capabilityType,
      status
    );
  }

  async escalateToUser(gap: CapabilityGap, goalId: string): Promise<void> {
    return escalateToUser({ reportingEngine: this.reportingEngine }, gap, goalId);
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

    let parsed: z.infer<typeof VerificationResponseSchema>;
    if (this.gateway) {
      parsed = await this.gateway.execute({
        purpose: "capability_verify",
        additionalContext: { verify_prompt: userMessage },
        responseSchema: VerificationResponseSchema,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: systemPrompt }
      );
      parsed = this.llmClient.parseJSON(response.content, VerificationResponseSchema);
    }

    if (parsed.verdict === "fail") {
      acquisitionTask.verification_attempts += 1;
      if (acquisitionTask.verification_attempts >= acquisitionTask.max_verification_attempts) {
        return "escalate";
      }
      return "fail";
    }

    return "pass";
  }

  // ─── Dependency wrappers ───

  async addDependency(capabilityId: string, dependsOn: string[]): Promise<void> {
    return addDependency({ stateManager: this.stateManager }, capabilityId, dependsOn);
  }

  async getDependencies(capabilityId: string): Promise<string[]> {
    return getDependencies({ stateManager: this.stateManager }, capabilityId);
  }

  resolveDependencies(dependencies: CapabilityDependency[]): string[] {
    return resolveDependencies(dependencies);
  }

  detectCircularDependency(dependencies: CapabilityDependency[]): string[] | null {
    return detectCircularDependency(dependencies);
  }

  async getAcquisitionOrder(gaps: CapabilityGap[]): Promise<CapabilityGap[]> {
    return getAcquisitionOrder({ stateManager: this.stateManager }, gaps);
  }
}
