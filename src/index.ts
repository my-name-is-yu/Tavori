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
export { SatisficingJudge, aggregateValues } from "./satisficing-judge.js";
export type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "./llm-client.js";
export { LLMClient, MockLLMClient, extractJSON } from "./llm-client.js";
export { OllamaLLMClient } from "./ollama-client.js";
export type { OllamaClientConfig } from "./ollama-client.js";
export { OpenAILLMClient } from "./openai-client.js";
export type { OpenAIClientConfig } from "./openai-client.js";
export { EthicsGate } from "./ethics-gate.js";
export { SessionManager } from "./session-manager.js";
export { StrategyManager } from "./strategy-manager.js";
export { GoalNegotiator, EthicsRejectedError } from "./goal-negotiator.js";
export { AdapterRegistry } from "./adapter-layer.js";
export type { IAdapter, AgentTask, AgentResult } from "./adapter-layer.js";
export { ClaudeCodeCLIAdapter } from "./adapters/claude-code-cli.js";
export { ClaudeAPIAdapter } from "./adapters/claude-api.js";
export { OpenAICodexCLIAdapter } from "./adapters/openai-codex.js";
export type { OpenAICodexCLIAdapterConfig } from "./adapters/openai-codex.js";
export { buildLLMClient, buildAdapterRegistry } from "./provider-factory.js";
export { TaskLifecycle } from "./task-lifecycle.js";
export { ReportingEngine } from "./reporting-engine.js";
export { KnowledgeManager } from "./knowledge-manager.js";
export { CapabilityDetector } from "./capability-detector.js";
export { PortfolioManager } from "./portfolio-manager.js";
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
export { DaemonRunner } from "./daemon-runner.js";
export type { DaemonDeps } from "./daemon-runner.js";
export { PIDManager } from "./pid-manager.js";
export { Logger } from "./logger.js";
export type { LogLevel, LoggerConfig } from "./logger.js";
export { EventServer } from "./event-server.js";
export type { EventServerConfig } from "./event-server.js";
export { NotificationDispatcher } from "./notification-dispatcher.js";
export type { INotificationDispatcher } from "./notification-dispatcher.js";
export { MemoryLifecycleManager } from "./memory-lifecycle.js";
export { CharacterConfigManager } from "./character-config.js";
export { CharacterConfigSchema, DEFAULT_CHARACTER_CONFIG } from "./types/character.js";
export type { CharacterConfig } from "./types/character.js";
export { SatisficingAggregationEnum } from "./types/goal.js";
export type { SatisficingAggregation } from "./types/goal.js";
export { CuriosityEngine } from "./curiosity-engine.js";
export { GoalDependencyGraph } from "./goal-dependency-graph.js";
export { KnowledgeGraph } from "./knowledge-graph.js";
export type { CuriosityEngineDeps } from "./curiosity-engine.js";
export {
  CuriosityTriggerTypeEnum,
  CuriosityTriggerSchema,
  CuriosityProposalStatusEnum,
  CuriosityProposalSchema,
  CuriosityConfigSchema,
  LearningRecordSchema,
  CuriosityStateSchema,
} from "./types/curiosity.js";
export type {
  CuriosityTriggerType,
  CuriosityTrigger,
  CuriosityProposalStatus,
  CuriosityProposal,
  CuriosityConfig,
  LearningRecord,
  CuriosityState,
} from "./types/curiosity.js";

// --- Embedding ---
export { type IEmbeddingClient, MockEmbeddingClient, OllamaEmbeddingClient, OpenAIEmbeddingClient, cosineSimilarity } from "./embedding-client.js";
export { VectorIndex } from "./vector-index.js";
export type { EmbeddingConfig, EmbeddingEntry, VectorSearchResult } from "./types/embedding.js";

// --- Data source ---
export { DataSourceRegistry, FileDataSourceAdapter, HttpApiDataSourceAdapter, getNestedValue } from "./data-source-adapter.js";
export type { IDataSourceAdapter } from "./data-source-adapter.js";

// --- Stage 14 types ---
export * from "./types/goal-tree.js";
export * from "./types/cross-portfolio.js";
export * from "./types/learning.js";

// --- Stage 14 modules ---
export { GoalTreeManager } from "./goal-tree-manager.js";
export { StateAggregator, type AggregatedState } from "./state-aggregator.js";
export { TreeLoopOrchestrator } from "./tree-loop-orchestrator.js";
export { CrossGoalPortfolio } from "./cross-goal-portfolio.js";
export { StrategyTemplateRegistry } from "./strategy-template-registry.js";
export { LearningPipeline } from "./learning-pipeline.js";
export { KnowledgeTransfer } from "./knowledge-transfer.js";
