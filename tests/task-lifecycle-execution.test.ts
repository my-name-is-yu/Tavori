import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { TaskLifecycle } from "../src/execution/task-lifecycle.js";
import type { Task } from "../src/types/task.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Spy LLM Client ───

function createSpyLLMClient(responses: string[]): ILLMClient & { calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> } {
  let callIndex = 0;
  const calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  return {
    calls,
    async sendMessage(
      messages: LLMMessage[],
      options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      calls.push({ messages, options });
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [
        null,
        content,
      ];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

// ─── Phase 2 helpers ───

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAdapter(
  results: Array<Partial<import("../src/execution/task-lifecycle.js").AgentResult>>
): import("../src/execution/task-lifecycle.js").IAdapter {
  let callIndex = 0;
  return {
    adapterType: "mock",
    async execute(
      _task: import("../src/execution/task-lifecycle.js").AgentTask
    ): Promise<import("../src/execution/task-lifecycle.js").AgentResult> {
      const r = results[callIndex++] ?? {};
      return {
        success: true,
        output: "Task completed successfully",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
        ...r,
      };
    },
  };
}

// ─── Test Suite ───

describe("TaskLifecycle", async () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLifecycle(
    llmClient: ILLMClient,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      logger?: import("../src/runtime/logger.js").Logger;
      adapterRegistry?: import("../src/execution/task-lifecycle.js").AdapterRegistry;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      options
    );
  }

  // ─────────────────────────────────────────────
  // executeTask
  // ─────────────────────────────────────────────

  describe("executeTask", async () => {
    it("creates a session with correct type and IDs", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      // Verify session was created by checking state
      const sessions = await sessionManager.getActiveSessions("goal-1");
      // Session should be ended (not active anymore)
      expect(sessions.length).toBe(0);
    });

    it("calls adapter.execute()", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let executeCalled = false;
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          executeCalled = true;
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.executeTask(makeTask(), adapter);
      expect(executeCalled).toBe(true);
    });

    it("returns AgentResult from adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: true,
        output: "test output",
        elapsed_ms: 200,
      }]);

      const result = await lifecycle.executeTask(makeTask(), adapter);
      expect(result.success).toBe(true);
      expect(result.output).toBe("test output");
      expect(result.elapsed_ms).toBe(200);
    });

    it("updates task status to completed on success", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true, stopped_reason: "completed" }]);
      const task = makeTask();

      // Persist task first
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("completed");
    });

    it("updates task status to timed_out on timeout", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: false,
        stopped_reason: "timeout",
        error: "Timed out",
      }]);
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("timed_out");
    });

    it("updates task status to error on error", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: false,
        stopped_reason: "error",
        error: "Something went wrong",
      }]);
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("error");
    });

    it("persists updated task after execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted).not.toBeNull();
      expect(persisted.completed_at).toBeDefined();
    });

    it("ends session after execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      // All sessions should be ended (no active ones)
      const activeSessions = await sessionManager.getActiveSessions("goal-1");
      expect(activeSessions.length).toBe(0);
    });

    it("handles adapter throwing an error", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          throw new Error("Adapter crashed");
        },
      };
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Adapter crashed");
      expect(result.stopped_reason).toBe("error");
    });

    it("builds prompt from context slots", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);
      expect(receivedPrompt).toContain("task_definition_and_success_criteria");
      expect(receivedPrompt).toContain("goal-1");
    });

    it("builds github-issue JSON block for github_issue adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "github_issue",
        formatPrompt(t: Task) {
          const titleLine = t.work_description.split("\n")[0]?.trim() ?? t.work_description;
          const title = titleLine.length > 120 ? titleLine.slice(0, 117) + "..." : titleLine;
          return `\`\`\`github-issue\n${JSON.stringify({ title, body: t.work_description })}\n\`\`\``;
        },
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "https://github.com/owner/repo/issues/1", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ work_description: "Fix memory leak in cache module" });

      await lifecycle.executeTask(task, adapter);
      expect(receivedPrompt).toContain("```github-issue");
      const jsonMatch = receivedPrompt.match(/```github-issue\s*([\s\S]*?)```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1].trim());
      expect(parsed.title).toBe("Fix memory leak in cache module");
      expect(parsed.body).toBe("Fix memory leak in cache module");
      expect(receivedPrompt).not.toContain("task_definition_and_success_criteria");
    });

    it("truncates long work_description title to 120 chars for github_issue adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "github_issue",
        formatPrompt(t: Task) {
          const titleLine = t.work_description.split("\n")[0]?.trim() ?? t.work_description;
          const title = titleLine.length > 120 ? titleLine.slice(0, 117) + "..." : titleLine;
          return `\`\`\`github-issue\n${JSON.stringify({ title, body: t.work_description })}\n\`\`\``;
        },
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "https://github.com/owner/repo/issues/2", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const longDesc = "A".repeat(200);
      const task = makeTask({ work_description: longDesc });

      await lifecycle.executeTask(task, adapter);
      const jsonMatch = receivedPrompt.match(/```github-issue\s*([\s\S]*?)```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1].trim());
      expect(parsed.title.length).toBeLessThanOrEqual(120);
      expect(parsed.body).toBe(longDesc);
    });

    it("sets timeout_ms from estimated_duration", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedTimeout = 0;
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedTimeout = agentTask.timeout_ms;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ estimated_duration: { value: 2, unit: "hours" } });

      await lifecycle.executeTask(task, adapter);
      expect(receivedTimeout).toBe(2 * 60 * 60 * 1000);
    });

    it("uses default timeout when estimated_duration is null", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedTimeout = 0;
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedTimeout = agentTask.timeout_ms;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ estimated_duration: null });

      await lifecycle.executeTask(task, adapter);
      expect(receivedTimeout).toBe(30 * 60 * 1000); // default 30 minutes
    });

    it("sets adapter_type in AgentTask", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedType = "";
      const adapter: import("../src/execution/task-lifecycle.js").IAdapter = {
        adapterType: "claude_api",
        async execute(agentTask) {
          receivedType = agentTask.adapter_type;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.executeTask(makeTask(), adapter);
      expect(receivedType).toBe("claude_api");
    });

    it("sets started_at on the running task", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      // started_at should be set when task moves to running
      expect(persisted.started_at).toBeDefined();
      expect(typeof persisted.started_at).toBe("string");
    });

    // ─── filesChanged annotation (git diff check) ───

    it("sets filesChanged=true when git diff --stat reports changed files", async () => {
      // Inject mock via execFileSyncFn option to avoid ES module spy issues
      const mockExecFileSync = vi.fn().mockReturnValue("src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)");

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, { execFileSyncFn: mockExecFileSync });
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.filesChanged).toBe(true);
    });

    it("sets filesChanged=false and logs warning when git diff --stat is empty", async () => {
      // Inject mock that returns empty string (no files changed)
      const mockExecFileSync = vi.fn().mockReturnValue("");

      const warnCalls: Array<[string, Record<string, unknown>?]> = [];
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          warnCalls.push(args as [string, Record<string, unknown>?]);
        }),
        error: vi.fn(),
      };

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        logger: mockLogger as unknown as import("../src/runtime/logger.js").Logger,
        execFileSyncFn: mockExecFileSync,
      });
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.filesChanged).toBe(false);
      // Logger.warn should have been called with the no-files-modified message
      expect(warnCalls.some(([msg]) => msg.includes("no files were modified"))).toBe(true);
    });

    it("does not annotate filesChanged when git is unavailable", async () => {
      // Inject mock that throws (simulates git not available / not a git repo)
      const mockExecFileSync = vi.fn().mockImplementation(() => {
        throw new Error("git: command not found");
      });

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, { execFileSyncFn: mockExecFileSync });
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      // Should not throw, and filesChanged should be undefined (check skipped)
      const result = await lifecycle.executeTask(task, adapter);

      expect(result.success).toBe(true);
      expect(result.filesChanged).toBeUndefined();
    });

    it("does not run git diff check when adapter reports failure", async () => {
      const mockExecFileSync = vi.fn().mockReturnValue("some output");

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, { execFileSyncFn: mockExecFileSync });
      const adapter = createMockAdapter([{ success: false, stopped_reason: "error" }]);
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);

      // Git diff check is skipped for failed tasks
      expect(result.filesChanged).toBeUndefined();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });
});
