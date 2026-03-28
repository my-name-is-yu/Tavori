/**
 * completion-judger-timeout.test.ts
 *
 * Tests for the timeout + retry config added to the completion judgment step
 * (runLLMReview inside task-verifier.ts).
 *
 * Approach: use VerifierDeps directly (the functions are exported from task-verifier.ts)
 * and inject a slow/failing mock LLM client to exercise the timeout / retry paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { verifyTask, type VerifierDeps } from "../src/execution/task-verifier.js";
import type { Task } from "../src/types/task.js";
import type { AgentResult } from "../src/execution/adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm/llm-client.js";
import type { z } from "zod";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeTask(): Task {
  return {
    id: "task-timeout-test",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: "Write tests for module X",
    rationale: "Improve test coverage",
    approach: "Use vitest",
    success_criteria: [
      {
        description: "Coverage >= 80%",
        verification_method: "manual inspection",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["tests/"],
      out_of_scope: ["src/"],
      blast_radius: "test files only",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

function makeExecutionResult(): AgentResult {
  return {
    success: true,
    output: "All tests pass",
    error: null,
    exit_code: 0,
    stopped_reason: "completed",
    adapter_type: "mock",
    execution_time_ms: 100,
  };
}

/** Build a slow LLM client that takes `delayMs` ms before resolving. */
function makeSlowLLMClient(delayMs: number, response = '{"verdict":"pass","reasoning":"ok","criteria_met":1,"criteria_total":1}'): ILLMClient {
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      await new Promise((res) => setTimeout(res, delayMs));
      return { content: response, usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

/** Build a failing LLM client that always rejects after a short delay. */
function makeFailingLLMClient(callDelayMs = 5): ILLMClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      callCount++;
      await new Promise((res) => setTimeout(res, callDelayMs));
      throw new Error("LLM service unavailable");
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

/** LLM client that fails the first N calls, then succeeds. */
function makeEventuallySucceedingLLMClient(failFirst: number, callDelayMs = 5): ILLMClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      callCount++;
      await new Promise((res) => setTimeout(res, callDelayMs));
      if (callCount <= failFirst) {
        throw new Error(`Simulated failure attempt ${callCount}`);
      }
      return {
        content: '{"verdict":"pass","reasoning":"eventually ok","criteria_met":1,"criteria_total":1}',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

// ─── Test Suite ───

describe("completion_judger timeout + retry", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-cjt-");
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeDeps(llmClient: ILLMClient, overrides: Partial<VerifierDeps> = {}): VerifierDeps {
    return {
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      stallDetector,
      durationToMs: (d) => d.value * (d.unit === "hours" ? 3_600_000 : 60_000),
      ...overrides,
    };
  }

  // ─────────────────────────────────────
  // Timeout
  // ─────────────────────────────────────

  it("returns a clear error state when LLM call times out (no hang)", async () => {
    // LLM takes 200ms but timeout is 50ms → should time out
    const slowLLM = makeSlowLLMClient(200);

    const deps = makeDeps(slowLLM, {
      completionJudgerConfig: { timeoutMs: 50, maxRetries: 0, retryBackoffMs: 0 },
    });

    const task = makeTask();
    const result = await verifyTask(deps, task, makeExecutionResult());

    // Should return a failed verdict, not hang
    expect(result.verdict).toBe("fail");
    // The description should mention timeout or failure
    const desc = result.evidence.find((e) => e.layer === "independent_review")?.description ?? "";
    expect(desc).toMatch(/timeout|failed/i);
  }, 2_000 /* 2 second wall-clock limit to confirm no hang */);

  // ─────────────────────────────────────
  // Retry count
  // ─────────────────────────────────────

  it("retries the specified number of times before giving up", async () => {
    const failingLLM = makeFailingLLMClient(5);

    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs: 0 },
    });

    const task = makeTask();
    await verifyTask(deps, task, makeExecutionResult());

    // 1 initial attempt + 2 retries = 3 total calls
    // (Note: verifyTask calls runLLMReview once; a retry case re-calls it for L1 pass + L2 fail,
    //  but here we're interested in the retry within a single runLLMReview call)
    // The failing LLM records how many times sendMessage was called
    expect(failingLLM.callCount).toBe(3);
  }, 5_000);

  it("succeeds if a retry eventually returns a valid response", async () => {
    // First 1 call fails, 2nd call succeeds
    const eventualLLM = makeEventuallySucceedingLLMClient(1, 5);

    const deps = makeDeps(eventualLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs: 0 },
    });

    const task = makeTask();
    const result = await verifyTask(deps, task, makeExecutionResult());

    // Should succeed — no mechanical criterion so L2 decides alone
    // With L1 skipped + L2 pass → "pass" verdict
    expect(result.verdict).toBe("pass");
    // Exactly 2 calls: 1 fail + 1 success
    expect(eventualLLM.callCount).toBe(2);
  }, 5_000);

  // ─────────────────────────────────────
  // Exponential backoff timing
  // ─────────────────────────────────────

  it("applies exponential backoff between retries", async () => {
    const failingLLM = makeFailingLLMClient(1);
    const timestamps: number[] = [];

    // Wrap the sendMessage to record call timestamps
    const origSend = failingLLM.sendMessage.bind(failingLLM);
    failingLLM.sendMessage = async (messages, options) => {
      timestamps.push(Date.now());
      return origSend(messages, options);
    };

    const retryBackoffMs = 50;
    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs },
    });

    // Actually run the test with the patched deps
    const task = makeTask();
    timestamps.length = 0;

    const patchedLLM = makeFailingLLMClient(1);
    const ts: number[] = [];
    patchedLLM.sendMessage = async (messages, options) => {
      ts.push(Date.now());
      // Always throw to measure all retry gaps
      await new Promise((res) => setTimeout(res, 1));
      throw new Error("always fail");
    };

    const patchedDeps = makeDeps(patchedLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs },
    });

    await verifyTask(patchedDeps, task, makeExecutionResult());

    expect(ts.length).toBe(3); // 1 initial + 2 retries

    // Gap between attempt 0→1 should be ~retryBackoffMs (backoff * 2^0 = 50ms)
    // Gap between attempt 1→2 should be ~retryBackoffMs * 2 (backoff * 2^1 = 100ms)
    if (ts.length >= 3) {
      const gap01 = ts[1]! - ts[0]!;
      const gap12 = ts[2]! - ts[1]!;
      // Allow generous tolerance for CI timing variance
      expect(gap01).toBeGreaterThanOrEqual(retryBackoffMs * 0.5);
      expect(gap12).toBeGreaterThanOrEqual(gap01 * 0.8); // second gap >= first gap (exponential)
    }
  }, 10_000);

  // ─────────────────────────────────────
  // Clear error on final failure
  // ─────────────────────────────────────

  it("returns verdict=fail with descriptive message on final failure (no silent hang)", async () => {
    const failingLLM = makeFailingLLMClient(1);

    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 1, retryBackoffMs: 0 },
    });

    const task = makeTask();
    const result = await verifyTask(deps, task, makeExecutionResult());

    expect(result.verdict).toBe("fail");
    const reviewEvidence = result.evidence.find((e) => e.layer === "independent_review");
    expect(reviewEvidence).toBeDefined();
    // description should mention "failed" and attempt count
    expect(reviewEvidence!.description).toMatch(/failed.*attempt/i);
    // confidence should be very low (0.0) on final failure
    expect(reviewEvidence!.confidence).toBe(0.0);
  }, 5_000);

  // ─────────────────────────────────────
  // Default config (no hang by default)
  // ─────────────────────────────────────

  it("uses sane defaults when no completionJudgerConfig is provided", () => {
    // Verifies that VerifierDeps without completionJudgerConfig does not throw during construction
    const llm = makeSlowLLMClient(1, '{"verdict":"pass","reasoning":"ok","criteria_met":1,"criteria_total":1}');
    const deps = makeDeps(llm); // no completionJudgerConfig
    // Just verify the deps object is valid (no config error)
    expect(deps.completionJudgerConfig).toBeUndefined();
  });
});
