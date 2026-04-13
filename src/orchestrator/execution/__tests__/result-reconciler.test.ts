import { describe, it, expect, vi } from "vitest";
import {
  reconcileResults,
  buildReconciliationPrompt,
} from "../result-reconciler.js";
import type { ReconcilerDeps } from "../result-reconciler.js";
import type { SubtaskResult } from "../parallel-execution-types.js";

// ─── Helpers ───

function makeResult(overrides: Partial<SubtaskResult> = {}): SubtaskResult {
  return {
    task_id: "task-1",
    verdict: "pass",
    output: "Some task output",
    ...overrides,
  };
}

function makeDeps(
  llmResponse: string | Error,
  options: { gatewayResponse?: unknown } = {}
): ReconcilerDeps {
  const sendMessage = vi.fn(async () => {
    if (llmResponse instanceof Error) throw llmResponse;
    return {
      content: llmResponse,
      usage: { input_tokens: 10, output_tokens: 20 },
      stop_reason: "end_turn",
    };
  });
  const parseJSON = vi.fn(
    (content: string, schema: { parse: (value: unknown) => unknown }) =>
      schema.parse(JSON.parse(content))
  ) as unknown as ReconcilerDeps["llmClient"]["parseJSON"];
  const gateway =
    options.gatewayResponse === undefined
      ? undefined
      : ({
          execute: vi.fn(async () => options.gatewayResponse) as unknown as NonNullable<
            ReconcilerDeps["gateway"]
          >["execute"],
        } satisfies NonNullable<ReconcilerDeps["gateway"]>);

  return {
    llmClient: {
      sendMessage,
      parseJSON,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ReconcilerDeps["logger"],
    ...(gateway ? { gateway } : {}),
  };
}

// ─── Tests ───

describe("reconcileResults", () => {
  it("single result returns no contradictions with confidence 1.0", async () => {
    const deps = makeDeps('{"contradictions":[]}');
    const result = await reconcileResults(deps, [makeResult()]);

    expect(result.has_contradictions).toBe(false);
    expect(result.contradictions).toHaveLength(0);
    expect(result.confidence).toBe(1.0);
    expect(deps.llmClient.sendMessage).not.toHaveBeenCalled();
  });

  it("two compatible results return no contradictions", async () => {
    const deps = makeDeps('{"contradictions":[]}');
    const results = [
      makeResult({ task_id: "task-1", output: "Added feature A" }),
      makeResult({ task_id: "task-2", output: "Added feature B" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(false);
    expect(report.contradictions).toHaveLength(0);
    expect(report.confidence).toBe(1.0);
    expect(deps.llmClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("two contradicting results are detected", async () => {
    const llmResponse = JSON.stringify({
      contradictions: [
        {
          task_a_id: "task-a",
          task_b_id: "task-b",
          description: "Task A disables caching while Task B enables it",
          severity: "critical",
        },
      ],
    });
    const deps = makeDeps(llmResponse);
    const results = [
      makeResult({ task_id: "task-a", output: "Disabled caching" }),
      makeResult({ task_id: "task-b", output: "Enabled caching" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(true);
    expect(report.contradictions).toHaveLength(1);
    expect(report.contradictions[0].task_a_id).toBe("task-a");
    expect(report.contradictions[0].task_b_id).toBe("task-b");
    expect(report.contradictions[0].severity).toBe("critical");
    expect(report.confidence).toBe(1.0);
  });

  it("LLM failure returns fail-open: no contradictions, confidence 0", async () => {
    const deps = makeDeps(new Error("LLM timeout"));
    const results = [
      makeResult({ task_id: "task-1" }),
      makeResult({ task_id: "task-2" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(false);
    expect(report.contradictions).toHaveLength(0);
    expect(report.confidence).toBe(0.0);
  });

  it("multiple results still use a single LLM call", async () => {
    const deps = makeDeps('{"contradictions":[]}');
    const results = [
      makeResult({ task_id: "task-1" }),
      makeResult({ task_id: "task-2" }),
      makeResult({ task_id: "task-3" }),
    ];

    await reconcileResults(deps, results);

    expect(deps.llmClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("gateway path also uses a single call", async () => {
    const deps = makeDeps('{"contradictions":[]}', {
      gatewayResponse: {
        contradictions: [
          {
            task_a_id: "task-1",
            task_b_id: "task-2",
            description: "Conflicting outcomes",
            severity: "warning",
          },
        ],
      },
    });
    const results = [
      makeResult({ task_id: "task-1", output: "Enabled caching" }),
      makeResult({ task_id: "task-2", output: "Disabled caching" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.has_contradictions).toBe(true);
    expect(report.contradictions).toHaveLength(1);
    expect(deps.llmClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.gateway?.execute).toHaveBeenCalledTimes(1);
    expect(deps.gateway?.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalContext: {
          recentTaskResults: expect.stringContaining("Task results:"),
        },
      })
    );
  });

  it("filters invalid task references, severities, and reversed duplicates", async () => {
    const deps = makeDeps(JSON.stringify({
      contradictions: [
        {
          task_a_id: "task-1",
          task_b_id: "task-2",
          description: "Same conflict",
          severity: "warning",
        },
        {
          task_a_id: "task-2",
          task_b_id: "task-1",
          description: "Same conflict",
          severity: "warning",
        },
        {
          task_a_id: "task-1",
          task_b_id: "missing",
          description: "Unknown task",
          severity: "warning",
        },
        {
          task_a_id: "task-1",
          task_b_id: "task-2",
          description: "Bad severity",
          severity: "urgent",
        },
        {
          task_a_id: "task-1",
          description: "Missing task B",
          severity: "warning",
        },
        "not an object",
      ],
    }));
    const results = [
      makeResult({ task_id: "task-1" }),
      makeResult({ task_id: "task-2" }),
    ];

    const report = await reconcileResults(deps, results);

    expect(report.contradictions).toEqual([
      {
        task_a_id: "task-1",
        task_b_id: "task-2",
        description: "Same conflict",
        severity: "warning",
      },
    ]);
  });
});

describe("buildReconciliationPrompt", () => {
  it("includes both task IDs and outputs in the prompt", () => {
    const resultA = makeResult({ task_id: "task-a", output: "Output A" });
    const resultB = makeResult({ task_id: "task-b", output: "Output B" });

    const prompt = buildReconciliationPrompt(resultA, resultB);

    expect(prompt).toContain("task-a");
    expect(prompt).toContain("task-b");
    expect(prompt).toContain("Output A");
    expect(prompt).toContain("Output B");
  });
});
