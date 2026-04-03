import { randomUUID } from "node:crypto";
import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import {
  EthicsVerdictSchema,
  EthicsLogSchema,
} from "../types/ethics.js";
import type {
  EthicsVerdict,
  EthicsLog,
  EthicsSubjectType,
  CustomConstraintsConfig,
} from "../types/ethics.js";
import { LAYER1_RULES, ETHICS_SYSTEM_PROMPT } from "./ethics-rules.js";

// ─── Constants ───

const CONFIDENCE_FLAG_THRESHOLD = 0.6;

/** Path relative to StateManager base dir for the ethics log */
const ETHICS_LOG_PATH = "ethics/ethics-log.json";

// ─── EthicsGate ───

/**
 * EthicsGate performs LLM-based ethical evaluation of goals, subgoals, and tasks.
 * All verdicts (pass, flag, reject) are persisted to an ethics log.
 *
 * Persistence: `ethics/ethics-log.json` via StateManager readRaw/writeRaw.
 * Read all → append → write all pattern (full JSON array, not JSONL).
 *
 * Layer 1: Hardcoded category-based blocklist (no LLM call). Runs before Layer 2.
 * Layer 2: LLM-based evaluation. Only runs when Layer 1 passes.
 * Custom constraints: Injected into the Layer 2 LLM prompt as additional context.
 */
export class EthicsGate {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly customConstraints?: CustomConstraintsConfig;
  private readonly gateway?: IPromptGateway;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    customConstraints?: CustomConstraintsConfig,
    gateway?: IPromptGateway
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.customConstraints = customConstraints;
    this.gateway = gateway;
  }

  // ─── Private: Log I/O ───

  private async loadLogs(): Promise<EthicsLog[]> {
    const raw = await this.stateManager.readRaw(ETHICS_LOG_PATH);
    if (raw === null) return [];
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).map((entry) => EthicsLogSchema.parse(entry));
  }

  private async saveLogs(logs: EthicsLog[]): Promise<void> {
    await this.stateManager.writeRaw(ETHICS_LOG_PATH, logs);
  }

  private async appendLog(entry: EthicsLog): Promise<void> {
    const logs = await this.loadLogs();
    logs.push(EthicsLogSchema.parse(entry));
    await this.saveLogs(logs);
  }

  // ─── Private: Layer 1 evaluation ───

  /**
   * Checks the input description against all hardcoded Layer 1 rules.
   * Returns an EthicsVerdict with verdict "reject" and confidence 1.0 if any rule matches.
   * Returns null if no rule matches (pass to Layer 2).
   */
  private checkLayer1(description: string): EthicsVerdict | null {
    for (const rule of LAYER1_RULES) {
      if (rule.matches(description)) {
        return {
          verdict: "reject",
          category: rule.category,
          reasoning: rule.description,
          risks: [],
          confidence: 1.0,
        };
      }
    }
    return null;
  }

  // ─── Private: LLM evaluation ───

  private buildUserMessage(
    subjectType: EthicsSubjectType,
    description: string,
    context?: string,
    applyConstraints?: boolean
  ): string {
    const lines: string[] = [
      `Subject type: ${subjectType}`,
      `Description: ${description}`,
    ];
    if (context) {
      lines.push(`Additional context: ${context}`);
    }
    if (applyConstraints && this.customConstraints && this.customConstraints.constraints.length > 0) {
      const goalConstraints = this.customConstraints.constraints.filter(
        (c) => c.applies_to === "goal"
      );
      if (goalConstraints.length > 0) {
        lines.push("");
        lines.push("Additional organizational constraints:");
        for (const constraint of goalConstraints) {
          lines.push(`- ${constraint.description}`);
        }
        lines.push("You MUST flag or reject any subject that violates these constraints.");
      }
    }
    return lines.join("\n");
  }

  private buildMeansUserMessage(
    taskDescription: string,
    means: string,
    applyConstraints?: boolean
  ): string {
    const lines = [
      `Subject type: task (means evaluation)`,
      `Task description: ${taskDescription}`,
      `Proposed means / execution method: ${means}`,
    ];
    if (applyConstraints && this.customConstraints && this.customConstraints.constraints.length > 0) {
      const meansConstraints = this.customConstraints.constraints.filter(
        (c) => c.applies_to === "task_means"
      );
      if (meansConstraints.length > 0) {
        lines.push("");
        lines.push("Additional organizational constraints:");
        for (const constraint of meansConstraints) {
          lines.push(`- ${constraint.description}`);
        }
        lines.push("You MUST flag or reject any subject that violates these constraints.");
      }
    }
    return lines.join("\n");
  }

  private parseVerdictSafe(content: string): EthicsVerdict {
    try {
      return this.llmClient.parseJSON(content, EthicsVerdictSchema);
    } catch {
      return {
        verdict: "flag",
        category: "parse_error",
        reasoning: `Failed to parse LLM response as valid EthicsVerdict. Raw content: ${content.slice(0, 200)}`,
        risks: [],
        confidence: 0,
      };
    }
  }

  private applyConfidenceOverride(verdict: EthicsVerdict): EthicsVerdict {
    if (verdict.confidence < CONFIDENCE_FLAG_THRESHOLD && verdict.verdict === "pass") {
      return { ...verdict, verdict: "flag" };
    }
    return verdict;
  }

  /**
   * Runs Layer 2 (LLM evaluation), logs the result, and returns the verdict.
   * Called by both check() and checkMeans() after Layer 1 passes.
   */
  private async runLayer2(
    userMessage: string,
    subjectType: EthicsSubjectType,
    subjectId: string,
    subjectDescription: string
  ): Promise<EthicsVerdict> {
    let rawVerdict: EthicsVerdict;
    if (this.gateway) {
      rawVerdict = await this.gateway.execute({
        purpose: "ethics_evaluate",
        additionalContext: { ethics_prompt: userMessage },
        responseSchema: EthicsVerdictSchema,
        temperature: 0,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: ETHICS_SYSTEM_PROMPT, temperature: 0 }
      );
      rawVerdict = this.parseVerdictSafe(response.content);
    }
    const verdict = this.applyConfidenceOverride(rawVerdict);

    const logEntry: EthicsLog = EthicsLogSchema.parse({
      log_id: randomUUID(),
      timestamp: new Date().toISOString(),
      subject_type: subjectType,
      subject_id: subjectId,
      subject_description: subjectDescription,
      verdict,
      layer1_triggered: false,
    });
    await this.appendLog(logEntry);

    return verdict;
  }

  // ─── Public API ───

  /**
   * Evaluate a goal, subgoal, or task for ethical concerns.
   *
   * Steps:
   * 1. Run Layer 1 (checkLayer1) — synchronous, no LLM call
   *    - If match: log with layer1_triggered=true and return immediately
   * 2. Build LLM prompt, injecting custom constraints for "goal" applies_to
   * 3. Send ethics judgment prompt to LLM (Layer 2)
   * 4. Parse response with EthicsVerdictSchema
   * 5. If confidence < CONFIDENCE_FLAG_THRESHOLD, auto-override verdict to "flag"
   * 6. Create EthicsLog entry, persist
   * 7. Return verdict
   *
   * On LLM call failure: throws (caller handles).
   * On JSON parse failure: returns conservative fallback with verdict "flag".
   */
  async check(
    subjectType: EthicsSubjectType,
    subjectId: string,
    description: string,
    context?: string
  ): Promise<EthicsVerdict> {
    // Layer 1 check
    const layer1Result = this.checkLayer1(description);
    if (layer1Result !== null) {
      const logEntry: EthicsLog = EthicsLogSchema.parse({
        log_id: randomUUID(),
        timestamp: new Date().toISOString(),
        subject_type: subjectType,
        subject_id: subjectId,
        subject_description: description,
        verdict: layer1Result,
        layer1_triggered: true,
      });
      await this.appendLog(logEntry);
      return layer1Result;
    }

    // Layer 2: LLM evaluation
    const userMessage = this.buildUserMessage(subjectType, description, context, true);
    return this.runLayer2(userMessage, subjectType, subjectId, description);
  }

  /**
   * Evaluate the execution means of a task for ethical concerns.
   * Used by TaskLifecycle to screen proposed execution methods before execution.
   *
   * Steps:
   * 1. Run Layer 1 on combined taskDescription + means
   *    - If match: log with layer1_triggered=true and return immediately
   * 2. Build LLM prompt, injecting custom constraints for "task_means" applies_to
   * 3. LLM-based Layer 2 evaluation
   * 4. Log and return
   */
  async checkMeans(
    taskId: string,
    taskDescription: string,
    means: string
  ): Promise<EthicsVerdict> {
    const subjectDescription = `${taskDescription} | means: ${means}`;

    // Layer 1 check (combined input for full context)
    const layer1Result = this.checkLayer1(`${taskDescription} ${means}`);
    if (layer1Result !== null) {
      const logEntry: EthicsLog = EthicsLogSchema.parse({
        log_id: randomUUID(),
        timestamp: new Date().toISOString(),
        subject_type: "task",
        subject_id: taskId,
        subject_description: subjectDescription,
        verdict: layer1Result,
        layer1_triggered: true,
      });
      await this.appendLog(logEntry);
      return layer1Result;
    }

    // Layer 2: LLM evaluation
    const userMessage = this.buildMeansUserMessage(taskDescription, means, true);
    return this.runLayer2(userMessage, "task", taskId, subjectDescription);
  }

  /**
   * Retrieve all persisted ethics logs, with optional filtering.
   */
  async getLogs(filter?: {
    subjectId?: string;
    verdict?: "reject" | "flag" | "pass";
  }): Promise<EthicsLog[]> {
    let logs = await this.loadLogs();

    if (filter?.subjectId !== undefined) {
      const targetId = filter.subjectId;
      logs = logs.filter((log) => log.subject_id === targetId);
    }

    if (filter?.verdict !== undefined) {
      const targetVerdict = filter.verdict;
      logs = logs.filter((log) => log.verdict.verdict === targetVerdict);
    }

    return logs;
  }
}
