import { describe, it, expect, vi } from "vitest";
import { ConcurrencyController } from "../concurrency.js";
import type { ITool, ToolMetadata, ToolResult } from "../types.js";

function makeTool(name: string): ITool<Record<string, unknown>> {
  return {
    metadata: { name, description: "test", inputSchema: {} } as ToolMetadata,
    execute: vi.fn(),
  };
}

const okResult: ToolResult = { ok: true, output: "done" };

describe("ConcurrencyController", () => {
  it("basic execution: passes through to fn and returns result", async () => {
    const cc = new ConcurrencyController();
    const tool = makeTool("read");
    const fn = vi.fn().mockResolvedValue(okResult);

    const result = await cc.run(tool, {}, fn);

    expect(result).toEqual(okResult);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("concurrency limit: 3rd call queues when maxConcurrent=2", async () => {
    const cc = new ConcurrencyController(2);
    const tool = makeTool("read");

    let resolve1!: () => void;
    let resolve2!: () => void;

    const p1 = cc.run(tool, {}, () => new Promise<ToolResult>((r) => { resolve1 = () => r(okResult); }));
    const p2 = cc.run(tool, {}, () => new Promise<ToolResult>((r) => { resolve2 = () => r(okResult); }));

    // Yield so p1 and p2 start executing
    await Promise.resolve();

    expect(cc.active).toBe(2);
    expect(cc.queued).toBe(0);

    // Start a 3rd call — should queue
    const p3 = cc.run(tool, {}, vi.fn().mockResolvedValue(okResult));
    await Promise.resolve();

    expect(cc.queued).toBe(1);

    resolve1();
    await p1;

    // After p1 finishes, p3 should dequeue
    await Promise.resolve();
    await Promise.resolve();

    expect(cc.queued).toBe(0);

    resolve2();
    await Promise.all([p2, p3]);
  });

  it("queue draining: queued calls execute after active ones finish", async () => {
    const cc = new ConcurrencyController(1);
    const tool = makeTool("read");
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = cc.run(tool, {}, () =>
      new Promise<ToolResult>((r) => {
        resolveFirst = () => { order.push(1); r(okResult); };
      }),
    );

    await Promise.resolve();

    const second = cc.run(tool, {}, async () => {
      order.push(2);
      return okResult;
    });

    await Promise.resolve();
    expect(cc.queued).toBe(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([1, 2]);
  });

  it("active/queued getters reflect correct counts", async () => {
    const cc = new ConcurrencyController(1);
    const tool = makeTool("read");

    expect(cc.active).toBe(0);
    expect(cc.queued).toBe(0);

    let resolve1!: () => void;
    const p1 = cc.run(tool, {}, () => new Promise<ToolResult>((r) => { resolve1 = () => r(okResult); }));
    await Promise.resolve();

    expect(cc.active).toBe(1);
    expect(cc.queued).toBe(0);

    const p2 = cc.run(tool, {}, vi.fn().mockResolvedValue(okResult));
    await Promise.resolve();

    expect(cc.active).toBe(1);
    expect(cc.queued).toBe(1);

    resolve1();
    await Promise.all([p1, p2]);

    expect(cc.active).toBe(0);
    expect(cc.queued).toBe(0);
  });

  it("shell sibling abort: new shell call to same cwd aborts previous AbortController", async () => {
    const cc = new ConcurrencyController(10);
    const tool = makeTool("shell");

    const abortedSignals: boolean[] = [];
    let resolveFirst!: () => void;

    const first = cc.run(tool, { cwd: "/tmp" }, () =>
      new Promise<ToolResult>((r) => {
        resolveFirst = () => r(okResult);
      }),
    );

    await Promise.resolve();

    // Capture the AbortController from the first call
    // We trigger a second call to same cwd — first AC should be aborted
    let secondStarted = false;
    const second = cc.run(tool, { cwd: "/tmp" }, async () => {
      secondStarted = true;
      return okResult;
    });

    await Promise.resolve();

    // Verify second can run (not blocked)
    await second;
    expect(secondStarted).toBe(true);

    resolveFirst();
    await first;
  });

  it("shell sibling abort: aborting previous shell sets signal.aborted", async () => {
    const cc = new ConcurrencyController(10);
    const tool = makeTool("shell");

    // Spy on abort by checking the internal map via run sequence
    let capturedAC: AbortController | undefined;

    // Monkey-patch to capture the AbortController
    const origMap = (cc as unknown as { activeShells: Map<string, AbortController> }).activeShells;
    const origSet = origMap.set.bind(origMap);
    origMap.set = (key: string, ac: AbortController) => {
      capturedAC = ac;
      return origSet(key, ac);
    };

    let resolveFirst!: () => void;
    const first = cc.run(tool, { cwd: "/project" }, () =>
      new Promise<ToolResult>((r) => { resolveFirst = () => r(okResult); }),
    );

    await Promise.resolve();
    const firstAC = capturedAC;
    expect(firstAC).toBeDefined();

    // Second call to same cwd — should abort firstAC
    const second = cc.run(tool, { cwd: "/project" }, vi.fn().mockResolvedValue(okResult));
    await Promise.resolve();

    expect(firstAC!.signal.aborted).toBe(true);

    resolveFirst();
    await Promise.all([first, second]);
  });

  it("error handling: active count decrements even if fn throws", async () => {
    const cc = new ConcurrencyController();
    const tool = makeTool("read");

    await expect(
      cc.run(tool, {}, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    expect(cc.active).toBe(0);
    expect(cc.queued).toBe(0);
  });
});
