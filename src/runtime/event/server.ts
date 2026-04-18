import * as fsp from "node:fs/promises";
import * as http from "node:http";
import type { DriveSystem } from "../../platform/drive/drive-system.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import { getEventsDir } from "../../base/utils/paths.js";
import type { Logger } from "../logger.js";
import { DEFAULT_PORT } from "../port-utils.js";
import type { ApprovalBroker } from "../approval-broker.js";
import type { OutboxStore } from "../store/index.js";
import type { Envelope } from "../types/envelope.js";
import type { SlackChannelAdapter } from "../gateway/slack-channel-adapter.js";
import { EventServerAuth } from "./server-auth.js";
import { EventServerCommandHandler } from "./server-command-handler.js";
import { EventServerFileIngestion } from "./server-file-ingestion.js";
import { readJsonBody, writeJson, writeJsonError } from "./server-http.js";
import { EventServerRouter } from "./server-router.js";
import { EventServerSnapshotReader } from "./server-snapshot-reader.js";
import { EventServerSseManager } from "./server-sse.js";
import { EventServerTriggerHandler } from "./server-trigger-handler.js";
import type {
  ActiveWorkersProvider,
  EventServerConfig,
  EventServerSnapshot,
} from "./server-types.js";

const DEFAULT_EVENT_FILE_MAX_ATTEMPTS = 3;
const DEFAULT_EVENT_FILE_RETRY_DELAY_MS = 250;

export type { EventServerConfig, EventServerSnapshot } from "./server-types.js";

export class EventServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private port: number;
  private readonly eventsDir: string;
  private readonly logger?: Logger;
  private approvalBroker?: ApprovalBroker;
  private outboxStore?: OutboxStore;
  private readonly snapshotReader: EventServerSnapshotReader;
  private readonly sseManager: EventServerSseManager;
  private readonly auth: EventServerAuth;
  private readonly fileIngestion: EventServerFileIngestion;
  private readonly triggerHandler: EventServerTriggerHandler;
  private readonly commandHandler: EventServerCommandHandler;
  private readonly router: EventServerRouter;
  private readonly approvalQueue = new Map<
    string,
    { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private envelopeHook?: (eventData: Record<string, unknown>) => void | Promise<void>;
  private commandEnvelopeHook?: (envelope: Envelope) => void | Promise<void>;
  private activeWorkersProvider?: ActiveWorkersProvider;
  private slackChannelAdapter?: SlackChannelAdapter;
  private slackEventsPath = "/slack/events";

  constructor(
    private readonly driveSystem: DriveSystem,
    private readonly config?: EventServerConfig,
    logger?: Logger,
  ) {
    this.host = config?.host ?? "127.0.0.1";
    this.port = config?.port ?? DEFAULT_PORT;
    this.eventsDir = config?.eventsDir ?? getEventsDir();
    this.logger = logger;
    this.approvalBroker = config?.approvalBroker;
    this.outboxStore = config?.outboxStore;
    this.snapshotReader = new EventServerSnapshotReader(this.eventsDir);
    this.sseManager = new EventServerSseManager(this.logger, this.approvalBroker, this.outboxStore);
    this.auth = new EventServerAuth(this.host, this.eventsDir, () => this.port, this.logger);
    this.fileIngestion = new EventServerFileIngestion(
      this.eventsDir,
      this.logger,
      Math.max(1, config?.eventFileMaxAttempts ?? DEFAULT_EVENT_FILE_MAX_ATTEMPTS),
      Math.max(0, config?.eventFileRetryDelayMs ?? DEFAULT_EVENT_FILE_RETRY_DELAY_MS),
      async (eventData) => this.dispatchEvent(eventData),
    );
    this.triggerHandler = new EventServerTriggerHandler(
      this.eventsDir,
      this.logger,
      config?.triggerMapper,
      async (eventData) => this.dispatchEvent(eventData),
    );
    this.commandHandler = new EventServerCommandHandler(
      async (eventType, data) => this.broadcast(eventType, data),
      () => this.commandEnvelopeHook,
      (requestId) => this.approvalQueue.has(requestId),
      async (requestId, approved) => this.resolveApproval(requestId, approved),
      () => this.approvalBroker,
      () => this.slackChannelAdapter,
    );
    this.router = new EventServerRouter({
      slackEventsPath: this.slackEventsPath,
      isSlackConfigured: () => this.slackChannelAdapter !== undefined,
      authorizeRequest: (req, res) => this.auth.authorizeRequest(req, res),
      handlePostSlackEvents: async (req, res) => this.commandHandler.handlePostSlackEvents(req, res),
      handlePostEvents: async (req, res) => this.handlePostEvents(req, res),
      handlePostTriggers: async (req, res) => this.triggerHandler.handlePostTriggers(req, res),
      handleGetGoals: async (res) => this.handleGetGoals(res),
      handleGetSnapshot: async (res) => this.handleGetSnapshot(res),
      handleGetGoalById: async (res, goalId) => this.handleGetGoalById(res, goalId),
      handleStream: async (req, res, requestUrl) => this.sseManager.handleStream(req, res, requestUrl),
      readDaemonStateRaw: async () => this.snapshotReader.readDaemonStateRaw(),
      handlePostDaemonRuntimeControl: async (req, res) => this.commandHandler.handlePostDaemonRuntimeControl(req, res),
      handlePostScheduleRunNow: async (req, res, scheduleId) =>
        this.commandHandler.handlePostScheduleRunNow(req, res, scheduleId),
      handleGoalAction: async (req, res, goalId, action) =>
        this.commandHandler.handleGoalAction(req, res, goalId, action),
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    await fsp.mkdir(this.eventsDir, { recursive: true });
    await this.approvalBroker?.start();
    const startPort = this.port;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.router.route(req, res));
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
        this.server = null;
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopFileWatcher();
    await this.approvalBroker?.stop();
    this.sseManager.closeAllClients();
    return new Promise((resolve) => {
      if (!this.server) {
        void this.auth.removeAuthTokenFile().finally(() => resolve());
        return;
      }
      this.server.close(() => {
        this.server = null;
        void this.auth.removeAuthTokenFile().finally(() => resolve());
      });
    });
  }

  startFileWatcher(): void {
    this.fileIngestion.start();
  }

  stopFileWatcher(): void {
    this.fileIngestion.stop();
  }

  async broadcast(eventType: string, data: unknown): Promise<void> {
    await this.sseManager.broadcast(eventType, data);
  }

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

  setEnvelopeHook(hook: (eventData: Record<string, unknown>) => void | Promise<void>): void {
    this.envelopeHook = hook;
  }

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

  setSlackChannelAdapter(adapter: SlackChannelAdapter, eventsPath = "/slack/events"): void {
    this.slackChannelAdapter = adapter;
    this.slackEventsPath = eventsPath.startsWith("/") ? eventsPath : `/${eventsPath}`;
    this.router.setSlackEventsPath(this.slackEventsPath);
  }

  invalidateTriggerMappingsCache(): void {
    this.triggerHandler.invalidateCache();
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  isWatching(): boolean {
    return this.fileIngestion.isWatching();
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
    return this.auth.getToken();
  }

  private async dispatchEvent(eventData: Record<string, unknown>): Promise<void> {
    if (this.envelopeHook) {
      await this.envelopeHook(eventData);
      return;
    }
    await this.driveSystem.writeEvent(eventData as never);
  }

  private async handlePostEvents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const data = await readJsonBody<unknown>(req);
      const event = PulSeedEventSchema.parse(data);
      await this.dispatchEvent(event as unknown as Record<string, unknown>);
      writeJson(res, 200, { status: "accepted", event_type: event.type });
    } catch (err) {
      writeJsonError(res, 400, "Invalid event", err);
    }
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

  private async handleGetSnapshot(res: http.ServerResponse): Promise<void> {
    try {
      const snapshot = await this.snapshotReader.buildSnapshot(
        this.approvalBroker?.getPendingApprovalEvents() ?? [],
        this.outboxStore,
        this.activeWorkersProvider,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error", details: String(err) }));
    }
  }

  private async finishServerStartup(server: http.Server): Promise<void> {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      this.port = addr.port;
    }
    await this.auth.persistAuthToken();
  }
}
