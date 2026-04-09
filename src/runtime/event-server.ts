import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import type { DriveSystem } from "../platform/drive/drive-system.js";
import { PulSeedEventSchema } from "../base/types/drive.js";
import { TriggerEventSchema, TriggerMappingsConfigSchema } from "../base/types/trigger.js";
import type { TriggerMappingsConfig } from "../base/types/trigger.js";
import { getEventsDir } from "../base/utils/paths.js";
import type { Logger } from "./logger.js";
import type { StateManager } from "../base/state/state-manager.js";
import type { TriggerMapper } from "./trigger-mapper.js";
import { findAvailablePort, DEFAULT_PORT, MAX_PORT_ATTEMPTS } from "./port-utils.js";
import type { ApprovalBroker } from "./approval-broker.js";
import { ZodError } from "zod";
import type { Envelope } from "./types/envelope.js";
import { createEnvelope } from "./types/envelope.js";

export interface EventServerConfig {
  host?: string; // default: "127.0.0.1" (localhost only!)
  port?: number; // default: 41700
  eventsDir?: string; // default: ~/.pulseed/events/
  stateManager?: StateManager;
  triggerMapper?: TriggerMapper;
  approvalBroker?: ApprovalBroker;
  commandHook?: (envelope: Envelope) => void | Promise<void>;
}

export class EventServer {
  private server: http.Server | null = null;
  private driveSystem: DriveSystem;
  private host: string;
  private port: number;
  private eventsDir: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private readonly processingFiles = new Set<string>();
  private readonly logger?: Logger;
  private readonly stateManager?: StateManager;
  private readonly triggerMapper?: TriggerMapper;
  private triggerMappingsCache: TriggerMappingsConfig | null = null;
  private sseClients: Set<http.ServerResponse> = new Set();
  private eventIdCounter = 0;
  private approvalQueue: Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private approvalBroker?: ApprovalBroker;
  private envelopeHook?: (eventData: Record<string, unknown>) => void | Promise<void>;
  private commandHook?: (envelope: Envelope) => void | Promise<void>;

  constructor(driveSystem: DriveSystem, config?: EventServerConfig, logger?: Logger) {
    this.driveSystem = driveSystem;
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? DEFAULT_PORT;
    // Default events directory: ~/.pulseed/events/
    this.eventsDir = config?.eventsDir ?? getEventsDir();
    this.logger = logger;
    this.stateManager = config?.stateManager;
    this.triggerMapper = config?.triggerMapper;
    this.approvalBroker = config?.approvalBroker;
    this.commandHook = config?.commandHook;
  }

  /** Start HTTP server, auto-retrying on EADDRINUSE up to MAX_PORT_ATTEMPTS times */
  async start(): Promise<void> {
    if (this.server) {
      return; // Already running
    }
    await fsp.mkdir(this.eventsDir, { recursive: true });
    await this.approvalBroker?.start();
    // If a specific non-zero port was requested, find the first available port
    // starting from it. Port 0 means OS-assigned — skip auto-detection.
    const startPort = this.port === 0 ? 0 : await findAvailablePort(this.port);
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      const server = this.server;
      server.listen(startPort, this.host, () => {
        // Capture the actual bound port (important for port 0 and auto-retry cases)
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        this.logger?.info(`EventServer listening on ${this.host}:${this.port}`);
        resolve();
      });
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        // EADDRINUSE should not reach here since findAvailablePort pre-checks,
        // but guard against a race condition.
        if (err.code === "EADDRINUSE" && startPort !== 0) {
          const fallbackStart = startPort + MAX_PORT_ATTEMPTS;
          findAvailablePort(fallbackStart).then((fallback) => {
            server.listen(fallback, this.host, () => {
              const addr = server.address();
              if (addr && typeof addr === "object") {
                this.port = addr.port;
              }
              this.logger?.info(`EventServer listening on ${this.host}:${this.port} (fallback)`);
              resolve();
            });
          }).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  /** Stop HTTP server */
  async stop(): Promise<void> {
    this.stopFileWatcher();
    await this.approvalBroker?.stop();
    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
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
      if (this.processingFiles.has(filename)) return;
      this.processingFiles.add(filename);
      void (async () => {
        try {
          await this.processEventFile(filePath, filename);
        } catch (err) {
          this.logger?.error(
            `EventServer: unhandled error processing event file "${filename}": ${String(err)}`
          );
        } finally {
          this.processingFiles.delete(filename);
        }
      })();
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

      // Dispatch through Gateway Envelope path or direct
      if (this.envelopeHook) {
        await this.envelopeHook(event as unknown as Record<string, unknown>);
      } else {
        await this.driveSystem.writeEvent(event);
      }

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

  /** Broadcast an SSE event to all connected clients */
  broadcast(eventType: string, data: unknown): void {
    for (const client of this.sseClients) {
      try {
        this.writeSseEvent(client, eventType, data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  /** Request human approval and wait for response (5 min timeout) */
  async requestApproval(goalId: string, task: { id: string; description: string; action: string }): Promise<boolean> {
    if (this.approvalBroker) {
      return this.approvalBroker.requestApproval(goalId, task);
    }
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.approvalQueue.delete(requestId);
        this.broadcast("approval_resolved", { requestId, approved: false, reason: "timeout" });
        resolve(false);
      }, 5 * 60 * 1000);
      this.approvalQueue.set(requestId, { resolve, timer });
      this.broadcast("approval_required", { requestId, goalId, task });
    });
  }

  /** Resolve a pending approval request */
  async resolveApproval(requestId: string, approved: boolean): Promise<boolean> {
    if (this.approvalBroker) {
      return this.approvalBroker.resolveApproval(requestId, approved, "http");
    }
    const entry = this.approvalQueue.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.approvalQueue.delete(requestId);
    entry.resolve(approved);
    this.broadcast("approval_resolved", { requestId, approved });
    return true;
  }

  /** Handle incoming HTTP request */
  /** Set a hook to intercept incoming events as Envelopes (used by HttpChannelAdapter). */
  setEnvelopeHook(hook: (eventData: Record<string, unknown>) => void | Promise<void>): void {
    this.envelopeHook = hook;
  }

  setApprovalBroker(broker: ApprovalBroker): void {
    this.approvalBroker = broker;
  }

  setCommandHook(hook: (envelope: Envelope) => void | Promise<void>): void {
    this.commandHook = hook;
  }

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

    // GET /stream — SSE event stream
    if (req.method === "GET" && urlPath === "/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      this.writeSseEvent(res, "connected", { timestamp: new Date().toISOString() }, false);
      this.sseClients.add(res);
      for (const pending of this.approvalBroker?.getPendingApprovalEvents() ?? []) {
        this.writeSseEvent(res, "approval_required", pending);
      }
      req.on("close", () => { this.sseClients.delete(res); });
      const keepAlive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { clearInterval(keepAlive); this.sseClients.delete(res); }
      }, 30_000);
      req.on("close", () => clearInterval(keepAlive));
      return;
    }

    // GET /daemon/status
    if (req.method === "GET" && urlPath === "/daemon/status") {
      void (async () => {
        const statePath = path.join(this.eventsDir.replace("/events", ""), "daemon-state.json");
        try {
          const raw = await fsp.readFile(statePath, "utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(raw);
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "daemon state not found" }));
        }
      })();
      return;
    }

    // POST /goals/:id/start|stop|approve|chat
    const goalActionMatch = /^\/goals\/([^/]+)\/([^/]+)$/.exec(urlPath);
    if (req.method === "POST" && goalActionMatch) {
      const goalId = goalActionMatch[1]!;
      const action = goalActionMatch[2]!;
      void (async () => {
        try {
          if (action === "start") {
            await this.acceptCommandEnvelope(createEnvelope({
              type: "command",
              name: "goal_start",
              source: "http",
              goal_id: goalId,
              priority: "high",
              payload: { goalId },
            }));
            this.broadcast("goal_start_requested", { goalId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, goalId }));
          } else if (action === "stop") {
            await this.acceptCommandEnvelope(createEnvelope({
              type: "command",
              name: "goal_stop",
              source: "http",
              goal_id: goalId,
              priority: "high",
              payload: { goalId },
            }));
            this.broadcast("goal_stop_requested", { goalId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, goalId }));
          } else if (action === "approve") {
            const body = await readBody(req);
            const { requestId, approved } = JSON.parse(body) as { requestId: string; approved: boolean };
            const resolved = await this.resolveApproval(requestId, approved);
            res.writeHead(resolved ? 200 : 404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: resolved }));
          } else if (action === "chat") {
            const body = await readBody(req);
            const { message } = JSON.parse(body) as { message: string };
            await this.acceptCommandEnvelope(createEnvelope({
              type: "command",
              name: "chat_message",
              source: "http",
              goal_id: goalId,
              priority: "high",
              payload: { goalId, message },
            }));
            this.broadcast("chat_message_received", { goalId, message });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to accept command", details: String(err) }));
        }
      })();
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
      void (async () => {
        try {
          const data = JSON.parse(body) as unknown;
          const event = PulSeedEventSchema.parse(data);
          if (this.envelopeHook) {
            // Route through Gateway Envelope path
            await this.envelopeHook(event as unknown as Record<string, unknown>);
          } else {
            // Direct path (no Gateway configured)
            await this.driveSystem.writeEvent(event);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", event_type: event.type }));
        } catch (err) {
          const status = err instanceof SyntaxError || err instanceof ZodError ? 400 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: status === 400 ? "Invalid event" : "Failed to accept event",
            details: String(err),
          }));
        }
      })();
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

  private writeSseEvent(
    res: http.ServerResponse,
    eventType: string,
    data: unknown,
    withId = true
  ): void {
    const lines: string[] = [];
    if (withId) {
      this.eventIdCounter++;
      lines.push(`id: ${String(this.eventIdCounter)}`);
    }
    lines.push(`event: ${eventType}`);
    lines.push(`data: ${JSON.stringify(data)}`);
    lines.push("");
    lines.push("");
    res.write(lines.join("\n"));
  }

  private async acceptCommandEnvelope(envelope: Envelope): Promise<void> {
    if (this.commandHook) {
      await this.commandHook(envelope);
    }
  }
}

/** Read the full request body as a string (max 1 MB). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const MAX = 1_048_576;
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX) { reject(new Error("Payload too large")); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
