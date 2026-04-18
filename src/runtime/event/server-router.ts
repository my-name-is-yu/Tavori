import type * as http from "node:http";
import { writeJson, writeJsonError } from "./server-http.js";

interface EventServerRouterDeps {
  slackEventsPath: string;
  isSlackConfigured: () => boolean;
  authorizeRequest: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  handlePostSlackEvents: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  handlePostEvents: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  handlePostTriggers: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  handleGetGoals: (res: http.ServerResponse) => Promise<void>;
  handleGetSnapshot: (res: http.ServerResponse) => Promise<void>;
  handleGetGoalById: (res: http.ServerResponse, goalId: string) => Promise<void>;
  handleStream: (req: http.IncomingMessage, res: http.ServerResponse, requestUrl: URL) => Promise<void>;
  readDaemonStateRaw: () => Promise<string | null>;
  handlePostDaemonRuntimeControl: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  handlePostScheduleRunNow: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scheduleId: string
  ) => Promise<void>;
  handleGoalAction: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    goalId: string,
    action: string
  ) => Promise<void>;
}

export class EventServerRouter {
  constructor(private readonly deps: EventServerRouterDeps) {}

  setSlackEventsPath(slackEventsPath: string): void {
    this.deps.slackEventsPath = slackEventsPath;
  }

  route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const urlPath = requestUrl.pathname;

    if (req.method === "GET" && urlPath === "/health") {
      writeJson(res, 200, { status: "ok", uptime: process.uptime() });
      return;
    }

    if (req.method === "POST" && this.deps.isSlackConfigured() && urlPath === this.deps.slackEventsPath) {
      void this.deps.handlePostSlackEvents(req, res);
      return;
    }

    if (!this.deps.authorizeRequest(req, res)) {
      return;
    }

    if (req.method === "POST" && urlPath === "/events") {
      void this.deps.handlePostEvents(req, res);
      return;
    }

    if (req.method === "POST" && urlPath === "/triggers") {
      void this.deps.handlePostTriggers(req, res);
      return;
    }

    if (req.method === "GET" && urlPath === "/goals") {
      void this.deps.handleGetGoals(res);
      return;
    }

    if (req.method === "GET" && urlPath === "/snapshot") {
      void this.deps.handleGetSnapshot(res);
      return;
    }

    const goalsMatch = /^\/goals\/([^/]+)$/.exec(urlPath);
    if (req.method === "GET" && goalsMatch) {
      void this.deps.handleGetGoalById(res, goalsMatch[1]!);
      return;
    }

    if (req.method === "GET" && urlPath === "/stream") {
      void this.deps.handleStream(req, res, requestUrl);
      return;
    }

    if (req.method === "GET" && urlPath === "/daemon/status") {
      void this.handleGetDaemonStatus(res);
      return;
    }

    if (req.method === "POST" && urlPath === "/daemon/runtime-control") {
      void this.deps.handlePostDaemonRuntimeControl(req, res);
      return;
    }

    const scheduleRunMatch = /^\/schedules\/([^/]+)\/run$/.exec(urlPath);
    if (req.method === "POST" && scheduleRunMatch) {
      void this.deps.handlePostScheduleRunNow(req, res, scheduleRunMatch[1]!);
      return;
    }

    const goalActionMatch = /^\/goals\/([^/]+)\/([^/]+)$/.exec(urlPath);
    if (req.method === "POST" && goalActionMatch) {
      void this.deps.handleGoalAction(req, res, goalActionMatch[1]!, goalActionMatch[2]!);
      return;
    }

    writeJsonError(res, 404, "Not found");
  }

  private async handleGetDaemonStatus(res: http.ServerResponse): Promise<void> {
    const raw = await this.deps.readDaemonStateRaw();
    if (raw !== null) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(raw);
      return;
    }
    writeJsonError(res, 404, "daemon state not found");
  }
}
