import { z } from "zod";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { AdapterRegistry } from "../adapter-layer.js";
import type { Logger } from "../../../runtime/logger.js";
import type { IPromptGateway } from "../../../prompt/gateway.js";
import type { ToolExecutor } from "../../../tools/executor.js";

// ─── Re-exported types used by consumers ───

export interface ExecutorReport {
  completed: boolean;
  summary: string;
  partial_results: string[];
  blockers: string[];
  stop_reason?: string;
  completion_evidence: string[];
  verification_hints: string[];
  trace_id?: string;
  session_id?: string;
  turn_id?: string;
}

export interface VerdictResult {
  action: "completed" | "keep" | "discard" | "escalate";
  task: import("../../../base/types/task.js").Task;
}

export interface FailureResult {
  action: "keep" | "discard" | "escalate";
  task: import("../../../base/types/task.js").Task;
}

// ─── CompletionJudgerResponseSchema: Zod schema for LLM completion judgment response ───

export const CompletionJudgerResponseSchema = z.object({
  verdict: z.enum(["pass", "partial", "fail"]).default("fail"),
  reasoning: z.string().default(""),
  criteria_met: z.number().int().min(0).optional(),
  criteria_total: z.number().int().min(0).optional(),
});

// ─── CompletionJudgerConfig: timeout + retry for the LLM completion judgment step ───

export interface CompletionJudgerConfig {
  /** Timeout for each LLM call in ms (default: 30000) */
  timeoutMs?: number;
  /** Maximum number of retries after the first attempt (default: 2) */
  maxRetries?: number;
  /** Base backoff delay in ms — doubles each retry (default: 1000) */
  retryBackoffMs?: number;
}

// ─── VerifierDeps: all dependencies needed by the verification functions ───

export interface VerifierDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  /** Optional separate LLM client for review (忖度防止 — sycophancy mitigation) */
  reviewerLlmClient?: ILLMClient;
  sessionManager: SessionManager;
  trustManager: TrustManager;
  stallDetector: StallDetector;
  adapterRegistry?: AdapterRegistry;
  /** Prefer this adapter for mechanical verification when available. */
  preferredAdapterType?: string;
  logger?: Logger;
  onTaskComplete?: (strategyId: string) => void;
  durationToMs: (duration: { value: number; unit: string }) => number;
  completionJudgerConfig?: CompletionJudgerConfig;
  /** Optional knowledge manager for enriching LLM review prompts */
  knowledgeManager?: {
    getRelevantKnowledge?(goalId: string): Promise<Array<{ question: string; answer: string; confidence: number }>>;
  };
  /** Optional PromptGateway — when provided, LLM review calls are routed through it */
  gateway?: IPromptGateway;
  /** Enable post-verification impact analysis (default: false). Disabled by default to avoid
   *  consuming extra LLM calls in contexts that only care about verification. */
  enableImpactAnalysis?: boolean;
  /** Optional ToolExecutor for internal shell operations (e.g. git restore in attemptRevert).
   *  When provided, used instead of raw child_process. */
  toolExecutor?: ToolExecutor;
  /** Optional explicit workspace root for raw git-based revert operations. */
  revertCwd?: string;
  /**
   * Optional mutable token counter. When provided, verifier LLM calls accumulate
   * input+output tokens into this object so callers can read the total after verification.
   */
  _tokenAccumulator?: { tokensUsed: number };
}
