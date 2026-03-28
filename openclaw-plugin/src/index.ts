/**
 * PulSeed OpenClaw Gateway Plugin — PulSeedEngine pattern
 * Detects goals in user messages, drives pulseed CLI in background,
 * streams progress back into the session via state-file polling.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { detectGoal } from "./goal-detector.js";
import type { ILLMClient } from "./goal-detector.js";
import {
  formatProgress, formatGoalStart, formatStall,
  formatCompletion, formatSessionResume,
} from "./progress-reporter.js";
import type { ProgressEvent, LoopResultSummary, StallInfo } from "./progress-reporter.js";

const execFileAsync = promisify(execFile);
const PULSEED_CLI = process.env["PULSEED_CLI_PATH"] ?? "pulseed";
const PULSEED_DIR = join(homedir(), ".pulseed");
const POLL_MS = 3_000;

// ---------------------------------------------------------------------------
// Types — OpenClaw Plugin API
// ---------------------------------------------------------------------------

interface Logger { info(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void; }
interface SessionContext { sessionKey: string; profile: string; model: string; startedAt: string; }
interface MessageContext { sessionKey: string; role: "user" | "assistant"; content: string; timestamp: string; }
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: string }>;
interface ToolConfig { description: string; parameters: Record<string, unknown>; handler: ToolHandler; }

export interface OpenClawPluginApi {
  onSessionStart(h: (s: SessionContext) => Promise<void>): void;
  onMessage(h: (m: MessageContext) => Promise<void>): void;
  onSessionEnd(h: (s: SessionContext) => Promise<void>): void;
  registerTool(name: string, config: ToolConfig): void;
  sendMessage(sessionKey: string, message: string): Promise<void>;
  log: Logger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCLI(args: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(PULSEED_CLI, args, { timeout: 15_000 });
    return { success: true, output: stdout || stderr };
  } catch (err) { return { success: false, output: err instanceof Error ? err.message : String(err) }; }
}

interface GoalState {
  id: string; description: string;
  status: "active" | "completed" | "stalled" | "error" | "stopped";
  gap?: number; confidence?: number; iteration?: number;
  maxIterations?: number; stallCount?: number; strategy?: string;
}

async function readGoalState(goalId: string): Promise<GoalState | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(goalId)) return null;
  try { return JSON.parse(await readFile(join(PULSEED_DIR, "goals", goalId, "state.json"), "utf8")) as GoalState; }
  catch { return null; }
}

async function listActiveGoals(): Promise<GoalState[]> {
  const r = await runCLI(["goal", "list", "--active", "--json"]);
  try { return r.success && r.output.trim() ? (JSON.parse(r.output) as GoalState[]) : []; } catch { return []; }
}

function makeLLMStub(log: Logger): ILLMClient {
  return { async sendMessage(messages) {
    const r = await runCLI(["llm-call", "--message", messages[messages.length - 1]?.content ?? ""]);
    if (!r.success) { log.warn("PulSeed: LLM stub failed"); return { content: '{"isGoal":false,"confidence":0}' }; }
    return { content: r.output };
  }};
}

// ---------------------------------------------------------------------------
// PulSeedEngine
// ---------------------------------------------------------------------------

class PulSeedEngine {
  private goalId: string | null = null;
  private running = false;
  private proc: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGap: number | undefined;

  constructor(private readonly api: OpenClawPluginApi) {}

  async resumeGoals(session: SessionContext): Promise<void> {
    const goals = await listActiveGoals();
    const top = goals[0];
    if (!top) return;
    await this.api.sendMessage(session.sessionKey, formatSessionResume(top.description, top.gap ?? 1));
    this.goalId = top.id;
    this.running = true;
    this.proc = spawn(PULSEED_CLI, ["run", "--goal", top.id, "--adapter", "openclaw_gateway", "--yes"], { stdio: "ignore" });
    this.proc.on("error", (e) => { this.api.log.error("PulSeed: resume run error", e); this.running = false; this.clearPoll(); });
    this.poll(session.sessionKey, top.id);
    this.api.log.info(`PulSeed: resumed goal ${top.id}`);
  }

  async interceptMessage(msg: MessageContext): Promise<void> {
    if (msg.role !== "user" || this.running) return;
    let result;
    try { result = await detectGoal(msg.content, makeLLMStub(this.api.log)); }
    catch (err) { this.api.log.error("PulSeed: detectGoal failed", err); return; }
    if (!result.isGoal) return;
    const desc = result.description ?? msg.content;
    await this.api.sendMessage(msg.sessionKey, formatGoalStart(desc, result.dimensions ?? []));
    await this.startGoal(msg.sessionKey, desc);
  }

  async checkpoint(_session: SessionContext): Promise<void> {
    this.clearPoll();
    this.running = false;
    this.goalId = null;
    this.api.log.info("PulSeed: session ended, state persisted to ~/.pulseed/");
  }

  async getStatus(): Promise<{ content: string }> {
    const r = await runCLI(["status"]);
    return { content: r.success ? r.output : `Error: ${r.output}` };
  }

  async stopLoop(): Promise<{ content: string }> {
    this.clearPoll();
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.running = false;
    return { content: "PulSeedループを停止しました" };
  }

  private async startGoal(sessionKey: string, desc: string): Promise<void> {
    this.running = true;
    const neg = await runCLI(["negotiate", "--description", desc, "--json", "--yes"]);
    if (!neg.success) {
      await this.api.sendMessage(sessionKey, `ゴール設定失敗: ${neg.output}`);
      this.running = false;
      return;
    }
    let goal: { id: string };
    try { goal = JSON.parse(neg.output) as { id: string }; }
    catch (err) { this.api.log.error("PulSeed: parse negotiate failed", err); this.running = false; return; }
    this.goalId = goal.id;
    this.proc = spawn(PULSEED_CLI, ["run", "--goal", goal.id, "--adapter", "openclaw_gateway", "--yes"], { stdio: "ignore" });
    this.proc.on("error", (e) => { this.api.log.error("PulSeed: run error", e); this.running = false; this.clearPoll(); });
    this.poll(sessionKey, goal.id);
  }

  private poll(sessionKey: string, goalId: string): void {
    this.clearPoll();
    this.lastGap = undefined;
    this.timer = setInterval(() => void this.tick(sessionKey, goalId), POLL_MS);
  }

  private clearPoll(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick(sessionKey: string, goalId: string): Promise<void> {
    const s = await readGoalState(goalId);
    if (!s) return;
    if (["completed", "stalled", "error", "stopped"].includes(s.status)) {
      this.clearPoll(); this.running = false;
      const summary: LoopResultSummary = { goalId: s.id, goalDescription: s.description,
        finalStatus: s.status as LoopResultSummary["finalStatus"],
        totalIterations: s.iteration ?? 0, endValue: s.gap !== undefined ? 1 - s.gap : undefined };
      await this.api.sendMessage(sessionKey, formatCompletion(summary)); return;
    }
    if ((s.stallCount ?? 0) > 0) {
      const info: StallInfo = { stallType: "repeated_failure", escalationLevel: Math.min(s.stallCount ?? 1, 3), newStrategy: s.strategy };
      await this.api.sendMessage(sessionKey, formatStall(info));
      return;
    }
    if (s.gap !== this.lastGap && s.iteration !== undefined) {
      this.lastGap = s.gap;
      const ev: ProgressEvent = { iteration: s.iteration, maxIterations: s.maxIterations ?? 10, phase: "Executing task...", gap: s.gap, confidence: s.confidence };
      const msg = formatProgress(ev);
      if (msg) await this.api.sendMessage(sessionKey, msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export function activate(api: OpenClawPluginApi): void {
  const engine = new PulSeedEngine(api);
  api.onSessionStart((s) => engine.resumeGoals(s));
  api.onMessage((m) => engine.interceptMessage(m));
  api.onSessionEnd((s) => engine.checkpoint(s));
  api.registerTool("pulseed_status", { description: "Show current PulSeed goal status", parameters: {}, handler: () => engine.getStatus() });
  api.registerTool("pulseed_stop", { description: "Stop the PulSeed loop", parameters: {}, handler: () => engine.stopLoop() });
  api.log.info("PulSeed plugin activated — goal-driven orchestration enabled");
}
