import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import type { DriveSystem } from "../drive/drive-system.js";
import { PulSeedEventSchema } from "../types/drive.js";
import { TriggerEventSchema, TriggerMappingsConfigSchema } from "../types/trigger.js";
import type { TriggerMappingsConfig } from "../types/trigger.js";
import { getEventsDir } from "../utils/paths.js";
import type { Logger } from "./logger.js";
import type { StateManager } from "../state/state-manager.js";
import type { TriggerMapper } from "./trigger-mapper.js";

export interface EventServerConfig {
  host?: string; // default: "127.0.0.1" (localhost only!)
  port?: number; // default: 41700
  eventsDir?: string; // default: ~/.pulseed/events/
  stateManager?: StateManager;
  triggerMapper?: TriggerMapper;
}

export class EventServer {
  private server: http.Server | null = null;
  private driveSystem: DriveSystem;
  private host: string;
  private port: number;
  private eventsDir: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private readonly logger?: Logger;
  private readonly stateManager?: StateManager;
  private readonly triggerMapper?: TriggerMapper;
  private triggerMappingsCache: TriggerMappingsConfig | null = null;

  constructor(driveSystem: DriveSystem, config?: EventServerConfig, logger?: Logger) {
    this.driveSystem = driveSystem;
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? 41700;
    // Default events directory: ~/.pulseed/events/
    this.eventsDir = config?.eventsDir ?? getEventsDir();
    this.logger = logger;
    this.stateManager = config?.stateManager;
    this.triggerMapper = config?.triggerMapper;
  }

  /** Start HTTP server */
  async start(): Promise<void> {
    await fsp.mkdir(this.eventsDir, { recursive: true });
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      const server = this.server;
      server.listen(this.port, this.host, () => {
        // When port 0 is used, capture the OS-assigned port
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
      this.server.on("error", reject);
    });
  }

  /** Stop HTTP server */
  async stop(): Promise<void> {
    this.stopFileWatcher();
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * Start watching the events directory for new `.json` files.
   * When a file appears:
   *   1. Read and parse it
   *   2. Validate via PulSeedEventSchema
   *   3. Dispatch to DriveSystem (writeEvent)
   *   4. Move to events/processed/ subdirectory
   *   5. Log errors for malformed files but don't crash
   *
   * Creates the events directory if it doesn't exist.
   */
  startFileWatcher(): void {
    if (this.fileWatcher) return; // already watching

    fs.mkdirSync(this.eventsDir, { recursive: true });

    this.fileWatcher = fs.watch(this.eventsDir, (eventType, filename) => {
      if ((eventType !== "rename" && eventType !== "change") || !filename) return;
      if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return;

      const filePath = path.join(this.eventsDir, filename);
      void this.processEventFile(filePath, filename).catch((err) => {
        this.logger?.error(
          `EventServer: unhandled error processing event file "${filename}": ${String(err)}`
        );
      });
    });
  }

  /** Stop the file watcher and clean up the handle. */
  stopFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  /**
   * Read, validate, dispatch, and move a single event file.
   * Errors are logged but never propagated (caller must not crash).
   */
  private async processEventFile(filePath: string, filename: string): Promise<void> {
    try {
      let stat;
      try {
        // Retry on ENOENT: on macOS, fs.watch fires 'rename' before the file
        // is visible to fsp.stat, so retry up to 3 times with 20ms delay.
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            stat = await fsp.stat(filePath);
            break;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw err;
            lastErr = err;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        if (!stat) {
          // File never appeared — already removed
          void lastErr; // suppress unused warning
          return;
        }
      } catch {
        return; // non-ENOENT error — file already removed or inaccessible
      }
      if (!stat.isFile()) return;

      const content = await fsp.readFile(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      const event = PulSeedEventSchema.parse(raw);

      // Dispatch to DriveSystem
      await this.driveSystem.writeEvent(event);

      // Move to processed/
      const processedDir = path.join(this.eventsDir, "processed");
      await fsp.mkdir(processedDir, { recursive: true });
      const dstPath = path.join(processedDir, filename);
      await fsp.rename(filePath, dstPath);
    } catch (err) {
      this.logger?.error(
        `EventServer: failed to process event file "${filename}": ${String(err)}`
      );
      // Do not re-throw — watcher must keep running
    }
  }

  /** Handle incoming HTTP request */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = req.url?.split("?")[0] ?? "/";

    // GET /health
    if (req.method === "GET" && urlPath === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    // POST /events
    if (req.method === "POST" && urlPath === "/events") {
      this.handlePostEvents(req, res);
      return;
    }

    // POST /triggers
    if (req.method === "POST" && urlPath === "/triggers") {
      this.handlePostTriggers(req, res);
      return;
    }

    // GET /goals
    if (req.method === "GET" && urlPath === "/goals") {
      void this.handleGetGoals(res);
      return;
    }

    // GET /goals/:id
    const goalsMatch = /^\/goals\/([^/]+)$/.exec(urlPath);
    if (req.method === "GET" && goalsMatch) {
      void this.handleGetGoalById(res, goalsMatch[1]!);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private handlePostEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    const MAX_BODY_SIZE = 1_048_576; // 1 MB
    let body = "";
    let bytesReceived = 0;
    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as unknown;
        const event = PulSeedEventSchema.parse(data);
        void this.driveSystem.writeEvent(event).catch((err) => {
          this.logger?.error(`EventServer: writeEvent failed: ${String(err)}`);
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", event_type: event.type }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid event", details: String(err) }));
      }
    });
  }

  private handlePostTriggers(req: http.IncomingMessage, res: http.ServerResponse): void {
    const MAX_BODY_SIZE = 1_048_576;
    let body = "";
    let bytesReceived = 0;
    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      void (async () => {
        try {
          const data = JSON.parse(body) as unknown;
          const trigger = TriggerEventSchema.parse(data);

          let action: string;
          let goalId: string | undefined | null;

          if (this.triggerMapper) {
            const resolved = await this.triggerMapper.resolve(trigger, []);
            if (resolved.action === "none") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "no_mapping" }));
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
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "no_mapping" }));
                return;
              }
              action = "observe";
            } else {
              action = mapping.action;
            }
          }

          await this.executeTriggerAction(action, trigger, goalId ?? undefined);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", action, goal_id: goalId ?? null }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid trigger", details: String(err) }));
        }
      })();
    });
  }

  private async executeTriggerAction(
    action: string,
    trigger: { source: string; event_type: string; data: Record<string, unknown>; goal_id?: string },
    goalId?: string
  ): Promise<void> {
    if (action === "observe") {
      const event = PulSeedEventSchema.parse({
        type: "external",
        source: trigger.source,
        timestamp: new Date().toISOString(),
        data: { ...trigger.data, event_type: trigger.event_type, goal_id: goalId },
      });
      void this.driveSystem.writeEvent(event).catch((err) => {
        this.logger?.error(`EventServer: trigger observe failed: ${String(err)}`);
      });
    } else if (action === "create_task") {
      const filename = `trigger_${Date.now()}_${Math.random().toString(36).slice(2)}.json`;
      const filePath = path.join(this.eventsDir, filename);
      const payload = {
        type: "external",
        source: trigger.source,
        timestamp: new Date().toISOString(),
        data: { ...trigger.data, event_type: trigger.event_type, action: "create_task", goal_id: goalId },
      };
      await fsp.writeFile(filePath, JSON.stringify(payload), "utf-8");
    } else if (action === "notify") {
      this.logger?.warn(
        `EventServer: trigger notify — source=${trigger.source} event_type=${trigger.event_type} goal_id=${goalId ?? "none"}`
      );
    } else if (action === "wake") {
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

  /** Invalidate the trigger mappings cache (for testing or hot-reload). */
  invalidateTriggerMappingsCache(): void {
    this.triggerMappingsCache = null;
  }

  private async handleGetGoals(res: http.ServerResponse): Promise<void> {
    try {
      const goalsDir = path.join(path.dirname(this.eventsDir), "goals");
      let entries: string[];
      try {
        entries = await fsp.readdir(goalsDir);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      const goals: Array<{ id: string; title: string; status: string; loop_status: string }> = [];
      for (const entry of entries) {
        const goalFile = path.join(goalsDir, entry, "goal.json");
        try {
          const content = await fsp.readFile(goalFile, "utf-8");
          const raw = JSON.parse(content) as Record<string, unknown>;
          goals.push({
            id: String(raw["id"] ?? entry),
            title: String(raw["title"] ?? ""),
            status: String(raw["status"] ?? "active"),
            loop_status: String(raw["loop_status"] ?? "idle"),
          });
        } catch {
          // Skip unreadable entries
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(goals));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async handleGetGoalById(res: http.ServerResponse, goalId: string): Promise<void> {
    try {
      const goalFile = path.join(path.dirname(this.eventsDir), "goals", goalId, "goal.json");
      let goalRaw: Record<string, unknown>;
      try {
        const content = await fsp.readFile(goalFile, "utf-8");
        goalRaw = JSON.parse(content) as Record<string, unknown>;
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Goal not found" }));
        return;
      }

      const gapFile = path.join(path.dirname(this.eventsDir), "goals", goalId, "gap-history.json");
      let currentGap: unknown = null;
      try {
        const gapContent = await fsp.readFile(gapFile, "utf-8");
        const gapHistory = JSON.parse(gapContent) as unknown[];
        currentGap = gapHistory.at(-1) ?? null;
      } catch {
        // Gap file may not exist
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...goalRaw, current_gap: currentGap }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  /** Check if server is running */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Check if file watcher is active (internal use) */
  isWatching(): boolean {
    return this.fileWatcher !== null;
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.host;
  }

  getEventsDir(): string {
    return this.eventsDir;
  }
}
