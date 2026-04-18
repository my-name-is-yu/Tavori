import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type * as http from "node:http";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import { TriggerEventSchema, TriggerMappingsConfigSchema } from "../../base/types/trigger.js";
import type { TriggerMappingsConfig } from "../../base/types/trigger.js";
import type { Logger } from "../logger.js";
import type { TriggerMapper } from "../trigger-mapper.js";
import { readJsonBody, writeJsonError, writeJson } from "./server-http.js";

type TriggerInput = { source: string; event_type: string; data: Record<string, unknown>; goal_id?: string };

export class EventServerTriggerHandler {
  private triggerMappingsCache: TriggerMappingsConfig | null = null;

  constructor(
    private readonly eventsDir: string,
    private readonly logger: Logger | undefined,
    private readonly triggerMapper: TriggerMapper | undefined,
    private readonly dispatchEvent: (eventData: Record<string, unknown>) => Promise<void>
  ) {}

  invalidateCache(): void {
    this.triggerMappingsCache = null;
  }

  async handlePostTriggers(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const data = await readJsonBody<unknown>(req);
      const trigger = TriggerEventSchema.parse(data);

      let action: string;
      let goalId: string | undefined | null;

      if (this.triggerMapper) {
        const resolved = await this.triggerMapper.resolve(trigger, []);
        if (resolved.action === "none") {
          writeJson(res, 200, { status: "no_mapping" });
          return;
        }
        action = resolved.action;
        goalId = resolved.goal_id ?? undefined;
      } else {
        const mappingsConfig = await this.loadTriggerMappings();
        const mapping = mappingsConfig.mappings.find(
          (m) => m.source === trigger.source && m.event_type === trigger.event_type
        );

        goalId = mapping?.goal_id ?? trigger.goal_id;

        if (!mapping) {
          if (!trigger.goal_id) {
            writeJson(res, 200, { status: "no_mapping" });
            return;
          }
          action = "observe";
        } else {
          action = mapping.action;
        }
      }

      await this.executeTriggerAction(action, trigger, goalId ?? undefined);
      writeJson(res, 200, { status: "ok", action, goal_id: goalId ?? null });
    } catch (err) {
      if (err instanceof Error && err.message === "Payload too large") {
        writeJsonError(res, 413, "Payload too large");
        return;
      }
      writeJsonError(res, 400, "Invalid trigger", err);
    }
  }

  private async executeTriggerAction(
    action: string,
    trigger: TriggerInput,
    goalId?: string
  ): Promise<void> {
    if (action === "observe") {
      const event = PulSeedEventSchema.parse({
        type: "external",
        source: trigger.source,
        timestamp: new Date().toISOString(),
        data: { ...trigger.data, event_type: trigger.event_type, goal_id: goalId },
      });
      try {
        await this.dispatchEvent(event as Record<string, unknown>);
      } catch (err) {
        this.logger?.error(`EventServer: trigger observe failed: ${String(err)}`);
        throw err;
      }
      return;
    }

    if (action === "create_task") {
      const filename = `trigger_${Date.now()}_${Math.random().toString(36).slice(2)}.json`;
      const filePath = path.join(this.eventsDir, filename);
      const payload = {
        type: "external",
        source: trigger.source,
        timestamp: new Date().toISOString(),
        data: { ...trigger.data, event_type: trigger.event_type, action: "create_task", goal_id: goalId },
      };
      await fsp.writeFile(filePath, JSON.stringify(payload), "utf-8");
      return;
    }

    if (action === "notify") {
      this.logger?.warn(
        `EventServer: trigger notify — source=${trigger.source} event_type=${trigger.event_type} goal_id=${goalId ?? "none"}`
      );
      return;
    }

    if (action === "wake") {
      this.logger?.warn(
        `EventServer: trigger wake — source=${trigger.source} event_type=${trigger.event_type}`
      );
    }
  }

  private async loadTriggerMappings(): Promise<TriggerMappingsConfig> {
    if (this.triggerMappingsCache !== null) return this.triggerMappingsCache;

    const mappingsPath = path.join(this.eventsDir, "..", "trigger-mappings.json");
    try {
      const content = await fsp.readFile(mappingsPath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      this.triggerMappingsCache = TriggerMappingsConfigSchema.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.warn(`EventServer: failed to load trigger-mappings.json: ${String(err)}`);
      }
      this.triggerMappingsCache = { mappings: [] };
    }
    return this.triggerMappingsCache;
  }
}
