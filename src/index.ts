export * from "./types/index.js";
export { LLMError, AdapterError, ValidationError, StateError } from "./utils/errors.js";
export { StateManager } from "./state/state-manager.js";
export {
  computeRawGap,
  normalizeGap,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  aggregateGaps,
  dimensionProgress,
} from "./drive/gap-calculator.js";
export type { DimensionGapInput } from "./drive/gap-calculator.js";
export { TrustManager } from "./traits/trust-manager.js";
export { DriveSystem } from "./drive/drive-system.js";
export {
  scoreDissatisfaction,
  scoreDeadline,
  scoreOpportunity,
  computeOpportunityValue,
  combineDriveScores,
  scoreAllDimensions,
  rankDimensions,
} from "./drive/drive-scorer.js";
export { ObservationEngine } from "./observation/observation-engine.js";
export { StallDetector } from "./drive/stall-detector.js";
export { SatisficingJudge, aggregateValues } from "./drive/satisficing-judge.js";
export type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, ModelTier } from "./llm/llm-client.js";
export { LLMClient, MockLLMClient, extractJSON } from "./llm/llm-client.js";
export { BaseLLMClient, DEFAULT_MAX_TOKENS } from "./llm/base-llm-client.js";
export { OllamaLLMClient } from "./llm/ollama-client.js";
export type { OllamaClientConfig } from "./llm/ollama-client.js";
export { OpenAILLMClient } from "./llm/openai-client.js";
export type { OpenAIClientConfig } from "./llm/openai-client.js";
export { EthicsGate } from "./traits/ethics-gate.js";
export * from "./types/guardrail.js";
export { GuardrailRunner } from "./traits/guardrail-runner.js";
export { generateReflection, saveReflectionAsKnowledge, getReflectionsForGoal, formatReflectionsForPrompt } from "./execution/reflection-generator.js";
export * from "./types/reflection.js";
export { SessionManager } from "./execution/session-manager.js";
export { StrategyManager } from "./strategy/strategy-manager.js";
export { GoalNegotiator, EthicsRejectedError } from "./goal/goal-negotiator.js";
export { AdapterRegistry } from "./execution/adapter-layer.js";
export type { IAdapter, AgentTask, AgentResult } from "./execution/adapter-layer.js";
export { ClaudeCodeCLIAdapter } from "./adapters/agents/claude-code-cli.js";
export { ClaudeAPIAdapter } from "./adapters/agents/claude-api.js";
export { OpenAICodexCLIAdapter } from "./adapters/agents/openai-codex.js";
export type { OpenAICodexCLIAdapterConfig } from "./adapters/agents/openai-codex.js";
export { GitHubIssueAdapter } from "./adapters/github-issue.js";
export type { GitHubIssueAdapterConfig } from "./adapters/github-issue.js";
export { GitHubIssueDataSourceAdapter } from "./adapters/datasources/github-issue-datasource.js";
export { buildLLMClient, buildAdapterRegistry } from "./llm/provider-factory.js";
export { CodexLLMClient } from "./llm/codex-llm-client.js";
export type { CodexLLMClientConfig } from "./llm/codex-llm-client.js";
export { loadProviderConfig, saveProviderConfig, DEFAULT_PROVIDER_CONFIG, migrateProviderConfig, validateProviderConfig, MODEL_REGISTRY } from "./llm/provider-config.js";
export type { ProviderConfig, ValidationResult } from "./llm/provider-config.js";
export { TaskLifecycle } from "./execution/task/task-lifecycle.js";
export { ReportingEngine } from "./reporting/reporting-engine.js";
export { KnowledgeManager } from "./knowledge/knowledge-manager.js";
export { CapabilityDetector } from "./observation/capability-detector.js";
export { PortfolioManager } from "./strategy/portfolio-manager.js";
export { CoreLoop } from "./loop/core-loop.js";
export type { CoreLoopDeps, LoopConfig, LoopResult } from "./loop/core-loop.js";
export { CLIRunner } from "./cli/cli-runner.js";
export { IntentRecognizer } from "./tui/intent-recognizer.js";
export type { IntentType, RecognizedIntent } from "./tui/intent-recognizer.js";
export { ActionHandler } from "./tui/actions.js";
export type { ActionDeps, ActionResult } from "./tui/actions.js";
export { LoopController } from "./tui/use-loop.js";
export type { LoopState, DimensionProgress } from "./tui/use-loop.js";
export { startTUI } from "./tui/entry.js";
export { DaemonRunner } from "./runtime/daemon-runner.js";
export type { DaemonDeps } from "./runtime/daemon-runner.js";
export { PIDManager } from "./runtime/pid-manager.js";
export { Logger } from "./runtime/logger.js";
export type { LogLevel, LoggerConfig } from "./runtime/logger.js";
export { EventServer } from "./runtime/event-server.js";
export type { EventServerConfig } from "./runtime/event-server.js";
export { NotificationDispatcher } from "./runtime/notification-dispatcher.js";
export type { INotificationDispatcher } from "./runtime/notification-dispatcher.js";
export { MemoryLifecycleManager } from "./knowledge/memory/memory-lifecycle.js";
export { CharacterConfigManager } from "./traits/character-config.js";
export { CharacterConfigSchema, DEFAULT_CHARACTER_CONFIG } from "./types/character.js";
export type { CharacterConfig } from "./types/character.js";
export { CuriosityEngine } from "./traits/curiosity-engine.js";
export { GoalDependencyGraph } from "./goal/goal-dependency-graph.js";
export { KnowledgeGraph } from "./knowledge/knowledge-graph.js";
export type { CuriosityEngineDeps } from "./traits/curiosity-engine.js";
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
export { type IEmbeddingClient, MockEmbeddingClient, OllamaEmbeddingClient, OpenAIEmbeddingClient, cosineSimilarity } from "./knowledge/embedding-client.js";
export { VectorIndex } from "./knowledge/vector-index.js";
export type { EmbeddingConfig, EmbeddingEntry, VectorSearchResult } from "./types/embedding.js";

// --- Data source ---
export { DataSourceRegistry, FileDataSourceAdapter, HttpApiDataSourceAdapter, getNestedValue } from "./observation/data-source-adapter.js";
export type { IDataSourceAdapter } from "./observation/data-source-adapter.js";

// --- Stage 14 modules ---
export { GoalTreeManager } from "./goal/goal-tree-manager.js";
export { StateAggregator, type AggregatedState } from "./goal/state-aggregator.js";
export { TreeLoopOrchestrator } from "./goal/tree-loop-orchestrator.js";
export { CrossGoalPortfolio } from "./strategy/cross-goal-portfolio.js";
export { StrategyTemplateRegistry } from "./strategy/strategy-template-registry.js";
export { LearningPipeline } from "./knowledge/learning/learning-pipeline.js";
export { KnowledgeTransfer } from "./knowledge/transfer/knowledge-transfer.js";

// --- A2A Protocol adapter ---
export { A2AAdapter } from "./adapters/agents/a2a-adapter.js";
export type { A2AAdapterConfig } from "./adapters/agents/a2a-adapter.js";
export { A2AClient } from "./adapters/agents/a2a-client.js";
export type { A2AClientConfig } from "./adapters/agents/a2a-client.js";
export {
  A2AAgentCardSchema,
  A2ATaskSchema,
  A2AMessageSchema,
  A2ATaskStateSchema,
  A2ATaskStatusSchema,
  A2AArtifactSchema,
  A2ASkillSchema,
  A2APartSchema,
  A2AJsonRpcResponseSchema,
  A2A_TERMINAL_STATES,
} from "./types/a2a.js";
export type {
  A2AAgentCard,
  A2ATask,
  A2AMessage,
  A2ATaskState,
  A2ATaskStatus,
  A2AArtifact,
  A2ASkill,
  A2APart,
  A2AJsonRpcResponse,
} from "./types/a2a.js";

// --- Plugin architecture (M12) ---
export { NotifierRegistry } from "./runtime/notifier-registry.js";
export { PluginLoader } from "./runtime/plugin-loader.js";

// --- Iteration budget ---
export { IterationBudget } from "./loop/iteration-budget.js";
export type { IterationBudgetData } from "./loop/iteration-budget.js";
