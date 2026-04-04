import { describe, it, expect, beforeEach, vi } from "vitest";
import { PipelineExecutor } from "../pipeline-executor.js";
import type { PipelineExecutorDeps } from "../pipeline-executor.js";
import { AdapterRegistry } from "../adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../adapter-layer.js";
import type { TaskPipeline } from "../../../base/types/pipeline.js";

// ─── Helpers ───

function makeAgentTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "Implement the feature",
    timeout_ms: 30000,
    adapter_type: "mock",
    ...overrides,
  };
}

function makeAdapter(
  type: string,
  resultOverrides: Partial<AgentResult> = {}
): IAdapter {
  return {
    adapterType: type,
    execute: vi.fn(async (_task: AgentTask): Promise<AgentResult> => ({
      success: true,
      output: `output from ${type}`,
      error: null,
      exit_code: 0,
      elapsed_ms: 100,
      stopped_reason: "completed",
      ...resultOverrides,
    })),
  };
}

function makeStateManager() {
  return {
    readRaw: vi.fn(async (_path: string) => null),
    writeRaw: vi.fn(async (_path: string, _data: unknown) => undefined),
  };
}

function makePipeline(overrides: Partial<TaskPipeline> = {}): TaskPipeline {
  return {
    stages: [
      { role: "implementor" },
      { role: "verifier" },
      { role: "reviewer" },
    ],
    fail_fast: true,
    ...overrides,
  };
}

// ─── Tests ───

describe("PipelineExecutor", () => {
  let registry: AdapterRegistry;
  let stateManager: ReturnType<typeof makeStateManager>;
  let adapter: IAdapter;
  let deps: PipelineExecutorDeps;

  beforeEach(() => {
    registry = new AdapterRegistry();
    stateManager = makeStateManager();
    adapter = makeAdapter("mock");
    registry.register(adapter);
    deps = {
      stateManager: stateManager as unknown as PipelineExecutorDeps["stateManager"],
      adapterRegistry: registry,
    };
  });

  // ─── 1. Normal sequential execution ───

  it("executes 3-stage pipeline and returns status=completed", async () => {
    const executor = new PipelineExecutor(deps);
    const result = await executor.run("task-1", makeAgentTask(), makePipeline());

    expect(result.status).toBe("completed");
    expect(result.stage_results).toHaveLength(3);
    expect(result.final_verdict).toBe("pass");
    expect(result.stage_results[0].role).toBe("implementor");
    expect(result.stage_results[1].role).toBe("verifier");
    expect(result.stage_results[2].role).toBe("reviewer");
  });

  it("sets all stage verdicts to pass when adapter succeeds", async () => {
    const executor = new PipelineExecutor(deps);
    const result = await executor.run("task-1", makeAgentTask(), makePipeline());

    for (const stage of result.stage_results) {
      expect(stage.verdict).toBe("pass");
    }
  });

  // ─── 2. Idempotency skip ───

  it("skips stage 0 when its idempotency_key is already in completed_stages", async () => {
    const preCompleted = {
      pipeline_id: "existing-pipeline",
      task_id: "task-2",
      current_stage_index: 1,
      completed_stages: [
        {
          stage_index: 0,
          role: "implementor",
          verdict: "pass",
          output: "pre-existing output",
          confidence: 0.9,
          idempotency_key: "task-2:0:0",
        },
      ],
      status: "interrupted",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    stateManager.readRaw.mockResolvedValueOnce(preCompleted);

    const pipeline: TaskPipeline = {
      stages: [{ role: "implementor" }, { role: "verifier" }],
      fail_fast: true,
    };

    const executor = new PipelineExecutor(deps);
    const result = await executor.run("task-2", makeAgentTask(), pipeline);

    // Stage 0 was skipped, only stage 1 ran via adapter
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    // Both stages appear in results (pre-existing + new)
    expect(result.stage_results).toHaveLength(2);
    expect(result.stage_results[0].idempotency_key).toBe("task-2:0:0");
    expect(result.status).toBe("completed");
  });

  // ─── 3. Fail-fast interruption ───

  it("stops pipeline after first failure when fail_fast=true", async () => {
    const failAdapter = makeAdapter("fail-adapter", {
      success: false,
      stopped_reason: "completed", // completed but not successful → partial/fail
    });
    // Make adapter return error on second stage
    const executeMock = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        output: "stage 0 ok",
        error: null,
        exit_code: 0,
        elapsed_ms: 50,
        stopped_reason: "completed",
      } as AgentResult)
      .mockResolvedValueOnce({
        success: false,
        output: "stage 1 failed",
        error: "test failure",
        exit_code: 1,
        elapsed_ms: 50,
        stopped_reason: "error",
      } as AgentResult);

    const mockAdapter: IAdapter = {
      adapterType: "mock",
      execute: executeMock,
    };
    const reg = new AdapterRegistry();
    reg.register(mockAdapter);
    const localDeps: PipelineExecutorDeps = {
      stateManager: stateManager as unknown as PipelineExecutorDeps["stateManager"],
      adapterRegistry: reg,
    };

    const pipeline: TaskPipeline = {
      stages: [{ role: "implementor" }, { role: "verifier" }, { role: "reviewer" }],
      fail_fast: true,
    };

    const executor = new PipelineExecutor(localDeps);
    const result = await executor.run("task-3", makeAgentTask(), pipeline);

    expect(result.status).toBe("failed");
    // Only 2 stages ran (0 passed, 1 failed and triggered fail_fast)
    expect(result.stage_results).toHaveLength(2);
    expect(result.final_verdict).toBe("fail");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  // ─── 4. State persistence ───

  it("calls writeRaw after each stage completion", async () => {
    const executor = new PipelineExecutor(deps);
    await executor.run("task-4", makeAgentTask(), makePipeline());

    // writeRaw called at: init + after stage 0 + after stage 1 + after stage 2 + final = 5
    expect(stateManager.writeRaw).toHaveBeenCalledWith(
      "pipelines/task-4.json",
      expect.objectContaining({ task_id: "task-4" })
    );
    // At minimum 4 calls: init + 3 stages
    expect(stateManager.writeRaw.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("persists pipeline_id consistently across writes", async () => {
    const executor = new PipelineExecutor(deps);
    await executor.run("task-4b", makeAgentTask(), makePipeline());

    const calls = stateManager.writeRaw.mock.calls;
    const pipelineIds = calls.map((c) => (c[1] as { pipeline_id: string }).pipeline_id);
    const unique = new Set(pipelineIds);
    expect(unique.size).toBe(1); // same pipeline_id throughout
  });

  // ─── 5. State restoration ───

  it("resumes from interrupted state at correct stage", async () => {
    const interruptedState = {
      pipeline_id: "resume-pipeline",
      task_id: "task-5",
      current_stage_index: 2,
      completed_stages: [
        {
          stage_index: 0,
          role: "implementor",
          verdict: "pass",
          output: "done",
          confidence: 0.8,
          idempotency_key: "task-5:0:0",
        },
        {
          stage_index: 1,
          role: "verifier",
          verdict: "pass",
          output: "verified",
          confidence: 0.8,
          idempotency_key: "task-5:1:0",
        },
      ],
      status: "interrupted",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    stateManager.readRaw.mockResolvedValueOnce(interruptedState);

    const pipeline: TaskPipeline = {
      stages: [
        { role: "implementor" },
        { role: "verifier" },
        { role: "reviewer" },
      ],
      fail_fast: true,
    };

    const executor = new PipelineExecutor(deps);
    const result = await executor.run("task-5", makeAgentTask(), pipeline);

    // Only stage 2 (reviewer) should have executed via adapter
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(result.stage_results).toHaveLength(3);
    expect(result.status).toBe("completed");
  });

  // ─── 6. Role-based context ───

  it("includes observation context for implementor but not for reviewer", async () => {
    const capturedPrompts: string[] = [];
    const capturingAdapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async (t: AgentTask): Promise<AgentResult> => {
        capturedPrompts.push(t.prompt);
        return {
          success: true,
          output: "ok",
          error: null,
          exit_code: 0,
          elapsed_ms: 10,
          stopped_reason: "completed",
        };
      }),
    };

    const reg = new AdapterRegistry();
    reg.register(capturingAdapter);
    const localDeps: PipelineExecutorDeps = {
      stateManager: stateManager as unknown as PipelineExecutorDeps["stateManager"],
      adapterRegistry: reg,
    };

    const pipeline: TaskPipeline = {
      stages: [{ role: "implementor" }, { role: "reviewer" }],
      fail_fast: true,
    };

    const executor = new PipelineExecutor(localDeps);
    await executor.run(
      "task-6",
      makeAgentTask({ prompt: "Base task" }),
      pipeline,
      "Observation: 42 tests passing"
    );

    // implementor prompt should include observation context
    expect(capturedPrompts[0]).toContain("Observation: 42 tests passing");
    // reviewer prompt should NOT include observation context
    expect(capturedPrompts[1]).not.toContain("Observation: 42 tests passing");
  });

  it("includes observation context for researcher but not for verifier", async () => {
    const capturedPrompts: string[] = [];
    const capturingAdapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async (t: AgentTask): Promise<AgentResult> => {
        capturedPrompts.push(t.prompt);
        return {
          success: true,
          output: "ok",
          error: null,
          exit_code: 0,
          elapsed_ms: 10,
          stopped_reason: "completed",
        };
      }),
    };

    const reg = new AdapterRegistry();
    reg.register(capturingAdapter);
    const localDeps: PipelineExecutorDeps = {
      stateManager: stateManager as unknown as PipelineExecutorDeps["stateManager"],
      adapterRegistry: reg,
    };

    const pipeline: TaskPipeline = {
      stages: [{ role: "researcher" }, { role: "verifier" }],
      fail_fast: true,
    };

    const executor = new PipelineExecutor(localDeps);
    await executor.run(
      "task-6b",
      makeAgentTask({ prompt: "Research this" }),
      pipeline,
      "Current state: branch main"
    );

    expect(capturedPrompts[0]).toContain("Current state: branch main");
    expect(capturedPrompts[1]).not.toContain("Current state: branch main");
  });

  // ─── 7. Prompt override ───

  it("prepends prompt_override to stage instructions", async () => {
    const capturedPrompts: string[] = [];
    const capturingAdapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async (t: AgentTask): Promise<AgentResult> => {
        capturedPrompts.push(t.prompt);
        return {
          success: true,
          output: "ok",
          error: null,
          exit_code: 0,
          elapsed_ms: 10,
          stopped_reason: "completed",
        };
      }),
    };

    const reg = new AdapterRegistry();
    reg.register(capturingAdapter);
    const localDeps: PipelineExecutorDeps = {
      stateManager: stateManager as unknown as PipelineExecutorDeps["stateManager"],
      adapterRegistry: reg,
    };

    const pipeline: TaskPipeline = {
      stages: [
        {
          role: "implementor",
          prompt_override: "IMPORTANT: Follow TDD approach.",
        },
      ],
      fail_fast: true,
    };

    const executor = new PipelineExecutor(localDeps);
    await executor.run("task-7", makeAgentTask({ prompt: "Write the module" }), pipeline);

    expect(capturedPrompts[0]).toMatch(/^IMPORTANT: Follow TDD approach\./);
    expect(capturedPrompts[0]).toContain("Write the module");
  });
});
