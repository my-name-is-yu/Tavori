import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TriggerMappingsConfigSchema } from "../types/trigger.js";
import type { TriggerEvent, TriggerMapping } from "../types/trigger.js";
import type { ILLMClient } from "../llm/llm-client.js";

export type TriggerAction = "observe" | "create_task" | "notify" | "wake" | "none";

export interface ResolveResult {
  action: TriggerAction;
  goal_id: string | null;
  source: "mapping" | "llm" | "default";
}

export interface GoalSummary {
  id: string;
  title: string;
  status: string;
}

export class TriggerMapper {
  private mappings: TriggerMapping[] = [];
  private llmCache: Map<string, { goal_id: string; action: string }> = new Map();

  constructor(
    private baseDir: string,
    private llmClient?: ILLMClient,
  ) {}

  async loadMappings(): Promise<void> {
    const mappingsPath = path.join(this.baseDir, "trigger-mappings.json");
    try {
      const content = await fsp.readFile(mappingsPath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      const config = TriggerMappingsConfigSchema.parse(raw);
      this.mappings = config.mappings;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.mappings = [];
        return;
      }
      // Malformed file — treat as empty
      this.mappings = [];
    }
  }

  async resolve(
    trigger: TriggerEvent,
    goalSummaries: Array<GoalSummary>,
  ): Promise<ResolveResult> {
    // 1. Check explicit mappings
    const mapping = this.mappings.find(
      (m) => m.source === trigger.source && m.event_type === trigger.event_type,
    );
    if (mapping) {
      return {
        action: mapping.action,
        goal_id: mapping.goal_id ?? trigger.goal_id ?? null,
        source: "mapping",
      };
    }

    // 2. If trigger has goal_id, use it with default action "observe"
    if (trigger.goal_id) {
      return { action: "observe", goal_id: trigger.goal_id, source: "mapping" };
    }

    // 3. If llmClient available, try LLM resolution
    if (this.llmClient) {
      const goals = goalSummaries.map((g) => ({ id: g.id, title: g.title }));
      const llmResult = await this.llmResolve(trigger, goals);
      if (llmResult) {
        const action = (llmResult.action as TriggerAction) ?? "observe";
        return { action, goal_id: llmResult.goal_id, source: "llm" };
      }
    }

    // 4. No match
    return { action: "none", goal_id: null, source: "default" };
  }

  private async llmResolve(
    trigger: TriggerEvent,
    goals: Array<{ id: string; title: string }>,
  ): Promise<{ goal_id: string; action: string } | null> {
    const cacheKey = `${trigger.source}:${trigger.event_type}`;
    const cached = this.llmCache.get(cacheKey);
    if (cached) return cached;

    try {
      const goalList = goals.map((g) => `- ${g.id}: ${g.title}`).join("\n");
      const prompt = `Given event ${trigger.source}/${trigger.event_type} with data ${JSON.stringify(trigger.data)}, and goals:\n${goalList}\nWhich goal is most relevant? What action (observe, create_task, notify, wake)? Respond JSON: {"goal_id": "...", "action": "..."}`;

      const response = await this.llmClient!.sendMessage([
        { role: "user", content: prompt },
      ]);

      const jsonMatch = /\{[^}]*"goal_id"[^}]*\}/.exec(response.content);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as { goal_id?: string; action?: string };
      if (!parsed.goal_id || !parsed.action) return null;

      const result = { goal_id: parsed.goal_id, action: parsed.action };
      this.llmCache.set(cacheKey, result);
      return result;
    } catch {
      return null;
    }
  }

  clearCache(): void {
    this.llmCache.clear();
  }

  getCacheSize(): number {
    return this.llmCache.size;
  }
}
