export * from "./types/index.js";
export { StateManager } from "./state-manager.js";
export {
  computeRawGap,
  normalizeGap,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  aggregateGaps,
} from "./gap-calculator.js";
export type { DimensionGapInput } from "./gap-calculator.js";
export { TrustManager } from "./trust-manager.js";
export { DriveSystem } from "./drive-system.js";
export {
  scoreDissatisfaction,
  scoreDeadline,
  scoreOpportunity,
  computeOpportunityValue,
  combineDriveScores,
  scoreAllDimensions,
  rankDimensions,
} from "./drive-scorer.js";
export { ObservationEngine } from "./observation-engine.js";
export { StallDetector } from "./stall-detector.js";
export { SatisficingJudge } from "./satisficing-judge.js";
export type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "./llm-client.js";
export { LLMClient, MockLLMClient } from "./llm-client.js";
export { EthicsGate } from "./ethics-gate.js";
export { SessionManager } from "./session-manager.js";
export { StrategyManager } from "./strategy-manager.js";
export { GoalNegotiator, EthicsRejectedError } from "./goal-negotiator.js";
export { AdapterRegistry } from "./adapter-layer.js";
export type { IAdapter, AgentTask, AgentResult } from "./adapter-layer.js";
export { ClaudeCodeCLIAdapter } from "./adapters/claude-code-cli.js";
export { ClaudeAPIAdapter } from "./adapters/claude-api.js";
export { TaskLifecycle } from "./task-lifecycle.js";
export { ReportingEngine } from "./reporting-engine.js";
export { KnowledgeManager } from "./knowledge-manager.js";
export { CapabilityDetector } from "./capability-detector.js";
export { CoreLoop } from "./core-loop.js";
export type { CoreLoopDeps, LoopConfig, LoopResult } from "./core-loop.js";
export { CLIRunner } from "./cli-runner.js";
export { IntentRecognizer } from "./tui/intent-recognizer.js";
export type { IntentType, RecognizedIntent } from "./tui/intent-recognizer.js";
export { ActionHandler } from "./tui/actions.js";
export type { ActionDeps, ActionResult } from "./tui/actions.js";
export { LoopController } from "./tui/use-loop.js";
export type { LoopState, DimensionProgress } from "./tui/use-loop.js";
export { startTUI } from "./tui/entry.js";
