import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DriveSystem } from "../../platform/drive/drive-system.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import { TriggerEventSchema, TriggerMappingsConfigSchema } from "../../base/types/trigger.js";
import type { TriggerMappingsConfig } from "../../base/types/trigger.js";
import { getEventsDir } from "../../base/utils/paths.js";
import type { Logger } from "../logger.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { TriggerMapper } from "../trigger-mapper.js";
import { findAvailablePort, DEFAULT_PORT, MAX_PORT_ATTEMPTS } from "../port-utils.js";
import { createEnvelope, type Envelope } from "../types/envelope.js";
import type { ApprovalBroker, ApprovalRequiredEvent } from "../approval-broker.js";
import type { OutboxStore, OutboxRecord } from "../store/index.js";
import { EventServerSnapshotReader } from "./server-snapshot-reader.js";
import { EventServerSseManager } from "./server-sse.js";

export interface EventServerConfig {
  host?: string; // default: "127.0.0.1" (localhost only!)
  port?: number; // default: 41700
  eventsDir?: string; // default: ~/.pulseed/events/
  stateManager?: StateManager;
  triggerMapper?: TriggerMapper;
  approvalBroker?: ApprovalBroker;
  outboxStore?: OutboxStore;
  eventFileMaxAttempts?: number;
  eventFileRetryDelayMs?: number;
}

export interface EventServerSnapshot {
  daemon: Record<string, unknown> | null;
  goals: Array<{ id: string; title: string; status: string; loop_status: string }>;
  approvals: ApprovalRequiredEvent[];
  active_workers: Array<Record<string, unknown>>;
  last_outbox_seq: number;
}

type ActiveWorkersProvider = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;

const DAEMON_TOKEN_FILENAME = "daemon-token.json";
const DEFAULT_EVENT_FILE_MAX_ATTEMPTS = 3;
const DEFAULT_EVENT_FILE_RETRY_DELAY_MS = 250;

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
  private readonly snapshotReader: EventServerSnapshotReader;
  private readonly sseManager: EventServerSseManager;
  private triggerMappingsCache: TriggerMappingsConfig | null = null;
  private approvalQueue: Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private approvalBroker?: ApprovalBroker;
  private outboxStore?: OutboxStore;
  private readonly eventFileMaxAttempts: number;
  private readonly eventFileRetryDelayMs: number;
  private readonly eventFileAttempts = new Map<string, number>();
  private readonly eventFileRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fileWatcherGeneration = 0;
  private readonly authToken: string;
  private envelopeHook?: (eventData: Record<string, unknown>) => void | Promise<void>;
  private commandEnvelopeHook?: (envelope: Envelope) => void | Promise<void>;
  private activeWorkersProvider?: ActiveWorkersProvider;

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
    this.outboxStore = config?.outboxStore;
    this.eventFileMaxAttempts = Math.max(1, config?.eventFileMaxAttempts ?? DEFAULT_EVENT_FILE_MAX_ATTEMPTS);
    this.eventFileRetryDelayMs = Math.max(0, config?.eventFileRetryDelayMs ?? DEFAULT_EVENT_FILE_RETRY_DELAY_MS);
    this.authToken = randomBytes(32).toString("base64url");
    this.snapshotReader = new EventServerSnapshotReader(this.eventsDir);
    this.sseManager = new EventServerSseManager(this.logger, this.approvalBroker, this.outboxStore);
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
        void (async () => {
          try {
            await this.finishServerStartup(server);
            this.logger?.info(`EventServer listening on ${this.host}:${this.port}`);
            resolve();
          } catch (err) {
            server.close(() => reject(err));
          }
        })();
      });
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        // EADDRINUSE should not reach here since findAvailablePort pre-checks,
        // but guard against a race condition.
        if (err.code === "EADDRINUSE" && startPort !== 0) {
          const fallbackStart = startPort + MAX_PORT_ATTEMPTS;
          findAvailablePort(fallbackStart).then((fallback) => {
            server.listen(fallback, this.host, () => {
              void (async () => {
                try {
                  await this.finishServerStartup(server);
                  this.logger?.info(`EventServer listening on ${this.host}:${this.port} (fallback)`);
                  resolve();
                } catch (err) {
                  server.close(() => reject(err));
                }
              })();
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
    this.sseManager.closeAllClients();
    return new Promise((resolve) => {
      if (!this.server) {
        void this.removeAuthTokenFile().finally(() => resolve());
        return;
      }
      this.server.close(() => {
        this.server = null;
        void this.removeAuthTokenFile().finally(() => resolve());
      });
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
    const generation = ++this.fileWatcherGeneration;
    void this.rescanEventFiles(generation);

    this.fileWatcher = fs.watch(this.eventsDir, (eventType, filename) => {
      if (generation !== this.fileWatcherGeneration) return;
      if ((eventType !== "rename" && eventType !== "change") || !filename) return;
      this.queueEventFile(String(filename), 0, generation);
    });
  }

  /** Stop the file watcher and clean up the handle. */
  stopFileWatcher(): void {
    this.fileWatcherGeneration += 1;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    for (const timer of this.eventFileRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.eventFileRetryTimers.clear();
  }

  /**
   * Read, validate, dispatch, and move a single event file.
   * Errors are logged but never propagated (caller must not crash).
   */
  private async processEventFile(filePath: string, filename: string): Promise<void> {
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
    this.eventFileAttempts.delete(filename);
  }

  private async rescanEventFiles(generation: number): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.eventsDir);
    } catch {
      return;
    }
    if (generation !== this.fileWatcherGeneration) return;
    for (const entry of entries) {
      this.queueEventFile(entry, 0, generation);
    }
  }

  private queueEventFile(filename: string, delayMs = 0, generation = this.fileWatcherGeneration): void {
    if (generation !== this.fileWatcherGeneration) return;
    if (!this.shouldProcessEventFilename(filename)) return;
    if (this.eventFileRetryTimers.has(filename)) return;
    if (delayMs <= 0 && this.processingFiles.has(filename)) return;

    const run = (): void => {
      if (generation !== this.fileWatcherGeneration) {
        this.eventFileRetryTimers.delete(filename);
        return;
      }
      this.eventFileRetryTimers.delete(filename);
      if (this.processingFiles.has(filename)) return;
      this.processingFiles.add(filename);
      const filePath = path.join(this.eventsDir, filename);
      void (async () => {
        try {
          await this.processEventFile(filePath, filename);
        } catch (err) {
          await this.handleEventFileFailure(filePath, filename, err);
        } finally {
          this.processingFiles.delete(filename);
        }
      })();
    };

    if (delayMs <= 0) {
      run();
      return;
    }

    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    this.eventFileRetryTimers.set(filename, timer);
  }

  private shouldProcessEventFilename(filename: string): boolean {
    if (path.basename(filename) !== filename) return false;
    if (!filename.endsWith(".json") || filename.endsWith(".tmp")) return false;
    return filename !== "daemon-token.json";
  }

  private async handleEventFileFailure(
    filePath: string,
    filename: string,
    err: unknown
  ): Promise<void> {
    const attempt = (this.eventFileAttempts.get(filename) ?? 0) + 1;
    this.eventFileAttempts.set(filename, attempt);
    const message = err instanceof Error ? err.message : String(err);

    if (attempt < this.eventFileMaxAttempts) {
      this.logger?.warn(
        `EventServer: failed to process event file "${filename}", retrying (${attempt}/${this.eventFileMaxAttempts}): ${message}`
      );
      this.queueEventFile(filename, this.eventFileRetryDelayMs);
      return;
    }

    this.logger?.error(
      `EventServer: failed to process event file "${filename}" after ${attempt} attempts; moving to failed/: ${message}`
    );
    this.eventFileAttempts.delete(filename);
    await this.moveFailedEventFile(filePath, filename);
  }

  private async moveFailedEventFile(filePath: string, filename: string): Promise<void> {
    try {
      const failedDir = path.join(this.eventsDir, "failed");
      await fsp.mkdir(failedDir, { recursive: true });
      let dstPath = path.join(failedDir, filename);
      try {
        await fsp.access(dstPath);
        const parsed = path.parse(filename);
        dstPath = path.join(failedDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
      } catch {
        // Destination is free.
      }
      await fsp.rename(filePath, dstPath);
    } catch (moveErr) {
      this.logger?.error(
        `EventServer: failed to quarantine event file "${filename}": ${String(moveErr)}`
      );
    }
  }

  /** Broadcast an SSE event to all connected clients */
  async broadcast(eventType: string, data: unknown): Promise<void> {
    await this.sseManager.broadcast(eventType, data);
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
        void this.broadcast("approval_resolved", { requestId, goalId, approved: false, reason: "timeout" });
        resolve(false);
      }, 5 * 60 * 1000);
      this.approvalQueue.set(requestId, { resolve, timer });
      void this.broadcast("approval_required", { requestId, goalId, task });
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
    void this.broadcast("approval_resolved", { requestId, approved });
    return true;
  }

  /** Handle incoming HTTP request */
  /** Set a hook to intercept incoming events as Envelopes (used by HttpChannelAdapter). */
  setEnvelopeHook(hook: (eventData: Record<string, unknown>) => void | Promise<void>): void {
    this.envelopeHook = hook;
  }

  /** Set a hook to intercept command-style HTTP actions as Envelopes. */
  setCommandEnvelopeHook(hook: (envelope: Envelope) => void | Promise<void>): void {
    this.commandEnvelopeHook = hook;
  }

  setApprovalBroker(broker: ApprovalBroker): void {
    this.approvalBroker = broker;
    this.sseManager.setApprovalBroker(broker);
  }

  setOutboxStore(store: OutboxStore): void {
    this.outboxStore = store;
    this.sseManager.setOutboxStore(store);
  }

  setActiveWorkersProvider(provider: ActiveWorkersProvider): void {
    this.activeWorkersProvider = provider;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const urlPath = requestUrl.pathname;

    // GET /health
    if (req.method === "GET" && urlPath === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    if (!this.authorizeRequest(req, res)) {
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

    if (req.method === "GET" && urlPath === "/snapshot") {
      void this.handleGetSnapshot(res);
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
      void this.handleStream(req, res, requestUrl);
      return;
    }

    // GET /daemon/status
    if (req.method === "GET" && urlPath === "/daemon/status") {
      void (async () => {
        const raw = await this.snapshotReader.readDaemonStateRaw();
        if (raw !== null) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(raw);
        } else {
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
        if (action === "start") {
          try {
            await this.dispatchCommandEnvelope({
              name: "goal_start",
              goalId,
              payload: { goalId },
            });
            await this.broadcast("goal_start_requested", { goalId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, goalId }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Command accept failed", details: String(err) }));
          }
        } else if (action === "stop") {
          try {
            await this.dispatchCommandEnvelope({
              name: "goal_stop",
              goalId,
              payload: { goalId },
            });
            await this.broadcast("goal_stop_requested", { goalId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, goalId }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Command accept failed", details: String(err) }));
          }
        } else if (action === "approve") {
          try {
            const body = await readBody(req);
            const { requestId, approved } = JSON.parse(body) as { requestId: string; approved: boolean };
            if (!this.approvalBroker && !this.approvalQueue.has(requestId)) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false }));
              return;
            }
            await this.dispatchCommandEnvelope({
              name: "approval_response",
              goalId,
              priority: "high",
              dedupeKey: `approval_response:${requestId}`,
              payload: { goalId, requestId, approved },
            });
            const resolved = await this.resolveApproval(requestId, approved);
            res.writeHead(resolved ? 200 : 404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: resolved }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid approval response", details: String(err) }));
          }
        } else if (action === "chat") {
          try {
            const body = await readBody(req);
            const { message } = JSON.parse(body) as { message: string };
            await this.dispatchCommandEnvelope({
              name: "chat_message",
              goalId,
              payload: { goalId, message },
            });
            await this.broadcast("chat_message_received", { goalId, message });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid chat message", details: String(err) }));
          }
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
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
            // Route through Gateway Envelope path and wait for durable accept.
            await this.envelopeHook(event as unknown as Record<string, unknown>);
          } else {
            await this.driveSystem.writeEvent(event);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", event_type: event.type }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid event", details: String(err) }));
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
      try {
        if (this.envelopeHook) {
          await this.envelopeHook(event as unknown as Record<string, unknown>);
        } else {
          await this.driveSystem.writeEvent(event);
        }
      } catch (err) {
        this.logger?.error(`EventServer: trigger observe failed: ${String(err)}`);
        throw err;
      }
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
      const goals = await this.snapshotReader.readGoalSummaries();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(goals));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async handleGetGoalById(res: http.ServerResponse, goalId: string): Promise<void> {
    try {
      const goal = await this.snapshotReader.readGoalDetail(goalId);
      if (goal === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Goal not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(goal));
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

  getAuthToken(): string {
    return this.authToken;
  }

  private async handleGetSnapshot(res: http.ServerResponse): Promise<void> {
    try {
      const snapshot = await this.buildSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async handleStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    await this.sseManager.handleStream(req, res, requestUrl);
  }

  private async dispatchCommandEnvelope(input: {
    name: string;
    goalId: string;
    payload: Record<string, unknown>;
    priority?: Envelope["priority"];
    dedupeKey?: string;
  }): Promise<void> {
    if (!this.commandEnvelopeHook) return;
    await this.commandEnvelopeHook(
      createEnvelope({
        type: "command",
        name: input.name,
        source: "http",
        goal_id: input.goalId,
        priority: input.priority,
        dedupe_key: input.dedupeKey,
        payload: input.payload,
      })
    );
  }

  private async buildSnapshot(): Promise<EventServerSnapshot> {
    return this.snapshotReader.buildSnapshot(
      this.approvalBroker?.getPendingApprovalEvents() ?? [],
      this.outboxStore,
      this.activeWorkersProvider
    );
  }

  private async finishServerStartup(server: http.Server): Promise<void> {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      this.port = addr.port;
    }
    await this.persistAuthToken();
  }

  private getAuthTokenPath(): string {
    return path.join(path.dirname(this.eventsDir), DAEMON_TOKEN_FILENAME);
  }

  private async persistAuthToken(): Promise<void> {
    const tokenPath = this.getAuthTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    const payload = {
      token: this.authToken,
      host: this.host,
      port: this.port,
      pid: process.pid,
      created_at: new Date().toISOString(),
    };
    await fsp.writeFile(tokenPath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fsp.chmod(tokenPath, 0o600).catch(() => undefined);
  }

  private async removeAuthTokenFile(): Promise<void> {
    const tokenPath = this.getAuthTokenPath();
    try {
      const raw = await fsp.readFile(tokenPath, "utf-8");
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (parsed.token !== this.authToken) return;
      await fsp.unlink(tokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn(`EventServer: failed to remove auth token file: ${String(err)}`);
      }
    }
  }

  private authorizeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.isAllowedHost(req.headers.host)) {
      this.writeJsonError(res, 403, "Forbidden host");
      return false;
    }

    if (!this.isAllowedOrigin(req.headers.origin)) {
      this.writeJsonError(res, 403, "Forbidden origin");
      return false;
    }

    const fetchSite = this.singleHeader(req.headers["sec-fetch-site"])?.toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      this.writeJsonError(res, 403, "Forbidden browser request");
      return false;
    }

    if (!this.hasValidAuth(req.headers.authorization)) {
      this.writeJsonError(res, 401, "Unauthorized");
      return false;
    }

    if (req.method === "POST" && !this.hasJsonContentType(req.headers["content-type"])) {
      this.writeJsonError(res, 415, "Content-Type must be application/json");
      return false;
    }

    return true;
  }

  private hasValidAuth(header: string | string[] | undefined): boolean {
    const value = this.singleHeader(header);
    if (!value?.startsWith("Bearer ")) return false;
    const candidate = value.slice("Bearer ".length).trim();
    const expected = Buffer.from(this.authToken);
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private hasJsonContentType(header: string | string[] | undefined): boolean {
    const value = this.singleHeader(header);
    return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
  }

  private isAllowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const hostname = this.parseHostname(hostHeader);
    if (!hostname) return false;
    return this.isAllowedHostname(hostname);
  }

  private isAllowedOrigin(originHeader: string | string[] | undefined): boolean {
    const origin = this.singleHeader(originHeader);
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:") return false;
      if (!this.isAllowedHostname(parsed.hostname)) return false;
      const originPort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
      return originPort === this.port;
    } catch {
      return false;
    }
  }

  private isAllowedHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    return normalized === this.host.toLowerCase()
      || normalized === "127.0.0.1"
      || normalized === "localhost"
      || normalized === "::1";
  }

  private parseHostname(hostHeader: string): string | null {
    try {
      return new URL(`http://${hostHeader}`).hostname;
    } catch {
      return null;
    }
  }

  private singleHeader(header: string | string[] | undefined): string | undefined {
    return Array.isArray(header) ? header[0] : header;
  }

  private writeJsonError(res: http.ServerResponse, status: number, error: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
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
