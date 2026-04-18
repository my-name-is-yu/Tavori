import type * as http from "node:http";
import { createEnvelope, type Envelope } from "../types/envelope.js";
import type { ApprovalBroker } from "../approval-broker.js";
import type { SlackChannelAdapter } from "../gateway/slack-channel-adapter.js";
import { RuntimeControlOperationKindSchema } from "../store/index.js";
import { readBody, writeJson, writeJsonError } from "./server-http.js";

export class EventServerCommandHandler {
  constructor(
    private readonly broadcast: (eventType: string, data: unknown) => Promise<void>,
    private readonly getCommandEnvelopeHook: () => ((envelope: Envelope) => void | Promise<void>) | undefined,
    private readonly hasPendingApprovalRequest: (requestId: string) => boolean,
    private readonly resolveApproval: (requestId: string, approved: boolean) => Promise<boolean>,
    private readonly getApprovalBroker: () => ApprovalBroker | undefined,
    private readonly getSlackChannelAdapter: () => SlackChannelAdapter | undefined
  ) {}

  async handleGoalAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    goalId: string,
    action: string
  ): Promise<void> {
    if (action === "start") {
      try {
        await this.dispatchCommandEnvelope({
          name: "goal_start",
          goalId,
          payload: { goalId },
        });
        await this.broadcast("goal_start_requested", { goalId });
        writeJson(res, 200, { ok: true, goalId });
      } catch (err) {
        writeJsonError(res, 500, "Command accept failed", err);
      }
      return;
    }

    if (action === "stop") {
      try {
        await this.dispatchCommandEnvelope({
          name: "goal_stop",
          goalId,
          payload: { goalId },
        });
        await this.broadcast("goal_stop_requested", { goalId });
        writeJson(res, 200, { ok: true, goalId });
      } catch (err) {
        writeJsonError(res, 500, "Command accept failed", err);
      }
      return;
    }

    if (action === "approve") {
      try {
        const body = await readBody(req);
        const { requestId, approved } = JSON.parse(body) as { requestId: string; approved: boolean };
        if (!this.getApprovalBroker() && !this.hasPendingApprovalRequest(requestId)) {
          writeJson(res, 404, { ok: false });
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
        writeJson(res, resolved ? 200 : 404, { ok: resolved });
      } catch (err) {
        if (err instanceof Error && err.message === "Payload too large") {
          writeJsonError(res, 413, "Payload too large");
          return;
        }
        writeJsonError(res, 400, "Invalid approval response", err);
      }
      return;
    }

    if (action === "chat") {
      try {
        const body = await readBody(req);
        const { message } = JSON.parse(body) as { message: string };
        await this.dispatchCommandEnvelope({
          name: "chat_message",
          goalId,
          payload: { goalId, message },
        });
        await this.broadcast("chat_message_received", { goalId, message });
        writeJson(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof Error && err.message === "Payload too large") {
          writeJsonError(res, 413, "Payload too large");
          return;
        }
        writeJsonError(res, 400, "Invalid chat message", err);
      }
      return;
    }

    writeJsonError(res, 404, "Not found");
  }

  async handlePostDaemonRuntimeControl(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const operationId = typeof parsed["operationId"] === "string" ? parsed["operationId"] : "";
      const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : "";
      const kind = RuntimeControlOperationKindSchema.parse(parsed["kind"]);
      if (!operationId) {
        writeJson(res, 400, { ok: false, error: "operationId is required" });
        return;
      }

      await this.dispatchCommandEnvelope({
        name: "runtime_control",
        priority: "critical",
        dedupeKey: `runtime_control:${operationId}`,
        payload: { operationId, kind, reason },
      });
      await this.broadcast("runtime_control_requested", { operationId, kind });
      writeJson(res, 200, { ok: true, operationId });
    } catch (err) {
      if (err instanceof Error && err.message === "Payload too large") {
        writeJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
      writeJson(res, 400, { ok: false, error: "Invalid runtime control request", details: String(err) });
    }
  }

  async handlePostScheduleRunNow(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawScheduleId: string
  ): Promise<void> {
    const scheduleId = decodeURIComponent(rawScheduleId).trim();
    if (!scheduleId) {
      writeJson(res, 400, { ok: false, error: "scheduleId is required" });
      return;
    }

    try {
      const body = await readBody(req);
      const parsed = body.trim() ? JSON.parse(body) as Record<string, unknown> : {};
      const allowEscalation = parsed["allowEscalation"] === true;
      await this.dispatchCommandEnvelope({
        name: "schedule_run_now",
        priority: "high",
        payload: { scheduleId, allowEscalation },
      });
      await this.broadcast("schedule_run_requested", { scheduleId, allowEscalation });
      writeJson(res, 200, { ok: true, scheduleId });
    } catch (err) {
      if (err instanceof Error && err.message === "Payload too large") {
        writeJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
      writeJson(res, 400, { ok: false, error: "Invalid schedule run request", details: String(err) });
    }
  }

  async handlePostSlackEvents(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const slackChannelAdapter = this.getSlackChannelAdapter();
    if (!slackChannelAdapter) {
      writeJson(res, 404, { ok: false, error: "Slack adapter is not configured" });
      return;
    }

    try {
      const body = await readBody(req);
      const headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
          .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value])
      );
      const response = slackChannelAdapter.handleRequest(body, headers);
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(response.body);
    } catch (err) {
      if (err instanceof Error && err.message === "Payload too large") {
        writeJson(res, 413, { ok: false, error: "Payload too large" });
        return;
      }
      writeJson(res, 400, { ok: false, error: "Invalid Slack event request", details: String(err) });
    }
  }

  private async dispatchCommandEnvelope(input: {
    name: string;
    goalId?: string;
    payload: Record<string, unknown>;
    priority?: Envelope["priority"];
    dedupeKey?: string;
  }): Promise<void> {
    const commandEnvelopeHook = this.getCommandEnvelopeHook();
    if (!commandEnvelopeHook) return;
    await commandEnvelopeHook(
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
}
