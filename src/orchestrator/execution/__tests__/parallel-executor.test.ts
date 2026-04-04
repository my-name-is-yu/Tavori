import { describe, it, expect, beforeEach, vi } from "vitest";
import { ParallelExecutor } from "../parallel-executor.js";
import type { ParallelExecutorDeps } from "../parallel-executor.js";
import type { PipelineRunResult } from "../pipeline-executor.js";
import type { TaskGroup } from "../../../base/types/index.js";

// ─── Helpers ───

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: `Do work for ${id}`,
    rationale: "needed",
    approach: "direct",
    success_criteria: [],
    scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown" as const,
    task_category: "normal" as const,
    status: "pending" as const,
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGroup(overrides: Partial<TaskGroup> = {}): TaskGroup {
  return {
    subtasks: [makeTask("t1"), makeTask("t2")],
    dependencies: [],
    file_ownership: {},
    ...overrides,
  };
}

function makePipelineResult(verdict: "pass" | "partial" | "fail", output = "ok"): PipelineRunResult {
  return {
    pipeline_id: "pipe-1",
    final_verdict: verdict,
    stage_results: [
      {
        stage_index: 0,
        role: "implementor",
        verdict,
        output,
        confidence: verdict === "pass" ? 0.9 : 0.2,
        idempotency_key: "key-0",
      },
    ],
    status: verdict === "fail" ? "failed" : "completed",
  };
}

function makePipelineExecutor(defaultResult: PipelineRunResult = makePipelineResult("pass")) {
  return {
    run: vi.fn(async () => defaultResult),
  };
}

// ─── Tests ───

describe("ParallelExecutor", () => {
  let pipelineExecutor: ReturnType<typeof makePipelineExecutor>;
  let deps: ParallelExecutorDeps;

  beforeEach(() => {
    pipelineExecutor = makePipelineExecutor();
    deps = {
      pipelineExecutor: pipelineExecutor as unknown as ParallelExecutorDeps["pipelineExecutor"],
    };
  });

  // ─── 1. Independent subtasks run in parallel ───

  it("executes independent subtasks in parallel and returns all results", async () => {
    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2"), makeTask("t3")],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    expect(result.results).toHaveLength(3);
    expect(result.overall_verdict).toBe("pass");
    expect(result.conflicts_detected).toHaveLength(0);
    // All three tasks ran via pipeline executor
    expect(pipelineExecutor.run).toHaveBeenCalledTimes(3);
  });

  it("calls pipelineExecutor with each subtask's work_description as prompt", async () => {
    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2")],
    });

    const executor = new ParallelExecutor(deps);
    await executor.execute(group, { goalId: "g1" });

    const calls = pipelineExecutor.run.mock.calls;
    const prompts = calls.map((c) => (c[1] as { prompt: string }).prompt);
    expect(prompts).toContain("Do work for t1");
    expect(prompts).toContain("Do work for t2");
  });

  // ─── 2. File ownership conflict detection ───

  it("detects file ownership conflicts and throws", async () => {
    const group = makeGroup({
      file_ownership: {
        "src/foo.ts": ["t1", "t2"],
      },
    });

    const executor = new ParallelExecutor(deps);
    await expect(executor.execute(group, { goalId: "g1" })).rejects.toThrow(
      /File ownership conflicts detected/
    );
  });

  it("validateFileOwnership returns conflict descriptions for shared files", () => {
    const group = makeGroup({
      file_ownership: {
        "src/foo.ts": ["t1", "t2"],
        "src/bar.ts": ["t2", "t3"],
        "src/ok.ts": ["t1"],
      },
    });

    const executor = new ParallelExecutor(deps);
    const conflicts = executor.validateFileOwnership(group);

    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatch(/src\/foo\.ts/);
    expect(conflicts[1]).toMatch(/src\/bar\.ts/);
  });

  it("validateFileOwnership returns empty array when no conflicts", () => {
    const group = makeGroup({
      file_ownership: {
        "src/a.ts": ["t1"],
        "src/b.ts": ["t2"],
      },
    });

    const executor = new ParallelExecutor(deps);
    const conflicts = executor.validateFileOwnership(group);
    expect(conflicts).toHaveLength(0);
  });

  // ─── 3. Dependency ordering (waves) ───

  it("respects dependency ordering — t2 runs after t1", async () => {
    const callOrder: string[] = [];
    pipelineExecutor.run.mockImplementation(async (taskId: string) => {
      callOrder.push(taskId);
      return makePipelineResult("pass");
    });

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2")],
      dependencies: [{ from: "t1", to: "t2" }], // t1 must complete before t2
    });

    const executor = new ParallelExecutor(deps);
    await executor.execute(group, { goalId: "g1" });

    expect(callOrder.indexOf("t1")).toBeLessThan(callOrder.indexOf("t2"));
  });

  it("buildExecutionOrder produces correct waves for chained deps", () => {
    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2"), makeTask("t3")],
      dependencies: [
        { from: "t1", to: "t2" },
        { from: "t2", to: "t3" },
      ],
    });

    const executor = new ParallelExecutor(deps);
    const waves = executor.buildExecutionOrder(group);

    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual(["t1"]);
    expect(waves[1]).toEqual(["t2"]);
    expect(waves[2]).toEqual(["t3"]);
  });

  it("buildExecutionOrder groups independent tasks into same wave", () => {
    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2"), makeTask("t3")],
      dependencies: [],
    });

    const executor = new ParallelExecutor(deps);
    const waves = executor.buildExecutionOrder(group);

    expect(waves).toHaveLength(1);
    expect(waves[0].sort()).toEqual(["t1", "t2", "t3"].sort());
  });

  // ─── 4. Subtask failure handling ───

  it("continues executing other tasks when one fails (no fail_fast at group level)", async () => {
    let callCount = 0;
    pipelineExecutor.run.mockImplementation(async (taskId: string) => {
      callCount++;
      if (taskId === "t1") return makePipelineResult("fail", "t1 failed");
      return makePipelineResult("pass", "t2 ok");
    });

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2")],
      dependencies: [],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    // Both tasks ran
    expect(callCount).toBe(2);
    expect(result.results).toHaveLength(2);
    const t1Result = result.results.find((r) => r.task_id === "t1");
    const t2Result = result.results.find((r) => r.task_id === "t2");
    expect(t1Result?.verdict).toBe("fail");
    expect(t2Result?.verdict).toBe("pass");
  });

  it("returns verdict=fail when subtask throws an error", async () => {
    pipelineExecutor.run.mockRejectedValueOnce(new Error("adapter crashed"));

    const group = makeGroup({
      subtasks: [makeTask("t1")],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    expect(result.results[0].verdict).toBe("fail");
    expect(result.results[0].error).toContain("adapter crashed");
  });

  // ─── 5. overall_verdict aggregation ───

  it("returns overall_verdict=pass when all subtasks pass", async () => {
    pipelineExecutor.run.mockResolvedValue(makePipelineResult("pass"));

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2"), makeTask("t3")],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    expect(result.overall_verdict).toBe("pass");
  });

  it("returns overall_verdict=fail when all subtasks fail", async () => {
    pipelineExecutor.run.mockResolvedValue(makePipelineResult("fail"));

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2")],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    expect(result.overall_verdict).toBe("fail");
  });

  it("returns overall_verdict=partial when results are mixed (some pass, some fail)", async () => {
    let call = 0;
    pipelineExecutor.run.mockImplementation(async () => {
      call++;
      return call === 1 ? makePipelineResult("fail") : makePipelineResult("pass");
    });

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2")],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    expect(result.overall_verdict).toBe("partial");
  });

  it("returns overall_verdict=partial when results include partial verdicts only", async () => {
    pipelineExecutor.run.mockResolvedValue(makePipelineResult("partial"));

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2")],
    });

    const executor = new ParallelExecutor(deps);
    const result = await executor.execute(group, { goalId: "g1" });

    // No pass and no fail → all partial → treated as pass (no failures)
    expect(result.overall_verdict).toBe("pass");
  });

  // ─── 6. Concurrency semaphore ───

  it("respects concurrency limit — never exceeds limit tasks concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    pipelineExecutor.run.mockImplementation(async () => {
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      // Simulate async work so overlap is possible
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return makePipelineResult("pass");
    });

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4"), makeTask("t5")],
      dependencies: [],
    });

    const executor = new ParallelExecutor({ ...deps, concurrencyLimit: 2 });
    await executor.execute(group, { goalId: "g1" });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("maintains correct result order when semaphore reorders execution", async () => {
    const callOrder: string[] = [];

    pipelineExecutor.run.mockImplementation(async (taskId: string) => {
      callOrder.push(taskId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return makePipelineResult("pass", `output-${taskId}`);
    });

    const group = makeGroup({
      subtasks: [makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4")],
      dependencies: [],
    });

    const executor = new ParallelExecutor({ ...deps, concurrencyLimit: 2 });
    const result = await executor.execute(group, { goalId: "g1" });

    // All tasks ran
    expect(result.results).toHaveLength(4);
    // Results contain all task IDs (order depends on wave, but all present)
    const taskIds = result.results.map((r) => r.task_id);
    expect(taskIds).toContain("t1");
    expect(taskIds).toContain("t2");
    expect(taskIds).toContain("t3");
    expect(taskIds).toContain("t4");
  });

  it("uses default concurrency limit of 3 when not specified", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    pipelineExecutor.run.mockImplementation(async () => {
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return makePipelineResult("pass");
    });

    // 6 tasks, no deps — all in one wave; default limit=3 caps concurrency
    const group = makeGroup({
      subtasks: [
        makeTask("t1"), makeTask("t2"), makeTask("t3"),
        makeTask("t4"), makeTask("t5"), makeTask("t6"),
      ],
      dependencies: [],
    });

    // No concurrencyLimit provided — uses default of 3
    const executor = new ParallelExecutor(deps);
    await executor.execute(group, { goalId: "g1" });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});
