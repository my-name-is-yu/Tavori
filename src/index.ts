export * from "./base/types/index.js";
export { LLMError, AdapterError, ValidationError, StateError } from "./base/utils/errors.js";
export { StateManager } from "./base/state/state-manager.js";
export {
  computeRawGap,
  normalizeGap,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  aggregateGaps,
  dimensionProgress,
} from "./platform/drive/gap-calculator.js";
export type { DimensionGapInput } from "./platform/drive/gap-calculator.js";
export { TrustManager } from "./platform/traits/trust-manager.js";
export { DriveSystem } from "./platform/drive/drive-system.js";
export {
  scoreDissatisfaction,
  scoreDeadline,
  scoreOpportunity,
  computeOpportunityValue,
  combineDriveScores,
  scoreAllDimensions,
  rankDimensions,
} from "./platform/drive/drive-scorer.js";
export { ObservationEngine } from "./platform/observation/observation-engine.js";
export { StallDetector } from "./platform/drive/stall-detector.js";
export { SatisficingJudge, aggregateValues } from "./platform/drive/satisficing-judge.js";
export type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, ModelTier } from "./base/llm/llm-client.js";
export { LLMClient, MockLLMClient, extractJSON } from "./base/llm/llm-client.js";
export { BaseLLMClient, DEFAULT_MAX_TOKENS } from "./base/llm/base-llm-client.js";
export { OllamaLLMClient } from "./base/llm/ollama-client.js";
export type { OllamaClientConfig } from "./base/llm/ollama-client.js";
export { OpenAILLMClient } from "./base/llm/openai-client.js";
export type { OpenAIClientConfig } from "./base/llm/openai-client.js";
export { EthicsGate } from "./platform/traits/ethics-gate.js";
export * from "./base/types/guardrail.js";
export { GuardrailRunner } from "./platform/traits/guardrail-runner.js";
export { generateReflection, saveReflectionAsKnowledge, getReflectionsForGoal, formatReflectionsForPrompt } from "./orchestrator/execution/reflection-generator.js";
export * from "./base/types/reflection.js";
export { SessionManager } from "./orchestrator/execution/session-manager.js";
export { StrategyManager } from "./orchestrator/strategy/strategy-manager.js";
export { GoalNegotiator, EthicsRejectedError } from "./orchestrator/goal/goal-negotiator.js";
export { AdapterRegistry } from "./orchestrator/execution/adapter-layer.js";
export type { IAdapter, AgentTask, AgentResult } from "./orchestrator/execution/adapter-layer.js";
export { ClaudeCodeCLIAdapter } from "./adapters/agents/claude-code-cli.js";
export { ClaudeAPIAdapter } from "./adapters/agents/claude-api.js";
export { OpenAICodexCLIAdapter } from "./adapters/agents/openai-codex.js";
export type { OpenAICodexCLIAdapterConfig } from "./adapters/agents/openai-codex.js";
export { GitHubIssueAdapter } from "./adapters/github-issue.js";
export type { GitHubIssueAdapterConfig } from "./adapters/github-issue.js";
export { GitHubIssueDataSourceAdapter } from "./adapters/datasources/github-issue-datasource.js";
export { buildLLMClient, buildAdapterRegistry } from "./base/llm/provider-factory.js";
export { CodexLLMClient } from "./base/llm/codex-llm-client.js";
export type { CodexLLMClientConfig } from "./base/llm/codex-llm-client.js";
export { loadProviderConfig, saveProviderConfig, DEFAULT_PROVIDER_CONFIG, migrateProviderConfig, validateProviderConfig, MODEL_REGISTRY } from "./base/llm/provider-config.js";
export type { ProviderConfig, ValidationResult } from "./base/llm/provider-config.js";
export { TaskLifecycle } from "./orchestrator/execution/task/task-lifecycle.js";
export { ReportingEngine } from "./reporting/reporting-engine.js";
export { KnowledgeManager } from "./platform/knowledge/knowledge-manager.js";
export { CapabilityDetector } from "./platform/observation/capability-detector.js";
export { PortfolioManager } from "./orchestrator/strategy/portfolio-manager.js";
export { CoreLoop } from "./orchestrator/loop/core-loop.js";
export type { CoreLoopDeps, LoopConfig, LoopResult } from "./orchestrator/loop/core-loop.js";
export { CLIRunner } from "./interface/cli/cli-runner.js";
export { ChatRunner } from "./interface/chat/chat-runner.js";
export type { ChatRunnerDeps, ChatRunResult } from "./interface/chat/chat-runner.js";
export type {
  ChatEvent,
  ChatEventHandler,
  ChatEventBase,
  ChatEventContext,
  LifecycleStartEvent,
  AssistantDeltaEvent,
  AssistantFinalEvent,
  ToolStartEvent,
  ToolUpdateEvent,
  ToolEndEvent,
  LifecycleEndEvent,
  LifecycleErrorEvent,
} from "./interface/chat/chat-events.js";
export { IntentRecognizer } from "./interface/tui/intent-recognizer.js";
export type { IntentType, RecognizedIntent } from "./interface/tui/intent-recognizer.js";
export { ActionHandler } from "./interface/tui/actions.js";
export type { ActionDeps, ActionResult } from "./interface/tui/actions.js";
export { LoopController } from "./interface/tui/use-loop.js";
export type { LoopState, DimensionProgress } from "./interface/tui/use-loop.js";
export { startTUI } from "./interface/tui/entry.js";
export { DaemonRunner } from "./runtime/daemon-runner.js";
export type { DaemonDeps } from "./runtime/daemon-runner.js";
export { PIDManager } from "./runtime/pid-manager.js";
export { Logger } from "./runtime/logger.js";
export type { LogLevel, LoggerConfig } from "./runtime/logger.js";
export { EventServer } from "./runtime/event-server.js";
export type { EventServerConfig } from "./runtime/event-server.js";
export { NotificationDispatcher } from "./runtime/notification-dispatcher.js";
export type { INotificationDispatcher } from "./runtime/notification-dispatcher.js";
export { MemoryLifecycleManager } from "./platform/knowledge/memory/memory-lifecycle.js";
export { CharacterConfigManager } from "./platform/traits/character-config.js";
export { CharacterConfigSchema, DEFAULT_CHARACTER_CONFIG } from "./base/types/character.js";
export type { CharacterConfig } from "./base/types/character.js";
export { CuriosityEngine } from "./platform/traits/curiosity-engine.js";
export { GoalDependencyGraph } from "./orchestrator/goal/goal-dependency-graph.js";
export { KnowledgeGraph } from "./platform/knowledge/knowledge-graph.js";
export type { CuriosityEngineDeps } from "./platform/traits/curiosity-engine.js";
export {
  CuriosityTriggerTypeEnum,
  CuriosityTriggerSchema,
  CuriosityProposalStatusEnum,
  CuriosityProposalSchema,
  CuriosityConfigSchema,
  LearningRecordSchema,
  CuriosityStateSchema,
} from "./base/types/curiosity.js";
export type {
  CuriosityTriggerType,
  CuriosityTrigger,
  CuriosityProposalStatus,
  CuriosityProposal,
  CuriosityConfig,
  LearningRecord,
  CuriosityState,
} from "./base/types/curiosity.js";

// --- Embedding ---
export { type IEmbeddingClient, MockEmbeddingClient, OllamaEmbeddingClient, OpenAIEmbeddingClient, cosineSimilarity } from "./platform/knowledge/embedding-client.js";
export { VectorIndex } from "./platform/knowledge/vector-index.js";
export type { EmbeddingConfig, EmbeddingEntry, VectorSearchResult } from "./base/types/embedding.js";

// --- Data source ---
export { DataSourceRegistry, FileDataSourceAdapter, HttpApiDataSourceAdapter, getNestedValue } from "./platform/observation/data-source-adapter.js";
export type { IDataSourceAdapter } from "./platform/observation/data-source-adapter.js";

// --- Stage 14 modules ---
export { GoalTreeManager } from "./orchestrator/goal/goal-tree-manager.js";
export { StateAggregator, type AggregatedState } from "./orchestrator/goal/state-aggregator.js";
export { TreeLoopOrchestrator } from "./orchestrator/goal/tree-loop-orchestrator.js";
export { CrossGoalPortfolio } from "./orchestrator/strategy/cross-goal-portfolio.js";
export { StrategyTemplateRegistry } from "./orchestrator/strategy/strategy-template-registry.js";
export { LearningPipeline } from "./platform/knowledge/learning/learning-pipeline.js";
export { KnowledgeTransfer } from "./platform/knowledge/transfer/knowledge-transfer.js";

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
} from "./base/types/a2a.js";
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
} from "./base/types/a2a.js";

// --- Plugin architecture (M12) ---
export { NotifierRegistry } from "./runtime/notifier-registry.js";
export { PluginLoader } from "./runtime/plugin-loader.js";

// --- Iteration budget ---
export { IterationBudget } from "./orchestrator/loop/iteration-budget.js";
export type { IterationBudgetData } from "./orchestrator/loop/iteration-budget.js";

// Tools
export {
  ToolRegistry,
  ToolExecutor,
  ToolPermissionManager,
  ConcurrencyController,
  createBuiltinTools,
} from "./tools/index.js";
export type {
  ITool,
  ToolResult,
  ToolCallContext,
  ContextFilter,
  AssembledPool,
  ToolExecutorDeps,
  PermissionRule,
} from "./tools/index.js";

// --- Builtin tool classes ---
export { GitLogTool } from "./tools/system/GitLogTool/GitLogTool.js";
export { GitDiffTool } from "./tools/system/GitDiffTool/GitDiffTool.js";
export { EnvTool } from "./tools/system/EnvTool/EnvTool.js";
export { SleepTool } from "./tools/system/SleepTool/SleepTool.js";
export { ProcessStatusTool } from "./tools/system/ProcessStatusTool/ProcessStatusTool.js";
export { TestRunnerTool } from "./tools/system/TestRunnerTool/TestRunnerTool.js";
export { ListDirTool } from "./tools/fs/ListDirTool/ListDirTool.js";
export { FileWriteTool } from "./tools/fs/FileWriteTool/FileWriteTool.js";
export { FileEditTool } from "./tools/fs/FileEditTool/FileEditTool.js";
export { validateFilePath } from "./tools/fs/FileValidationTool/FileValidationTool.js";
export { GoalStateTool } from "./tools/query/GoalStateTool/GoalStateTool.js";
export { TrustStateTool } from "./tools/query/TrustStateTool/TrustStateTool.js";
export { SessionHistoryTool } from "./tools/query/SessionHistoryTool/SessionHistoryTool.js";
export { KnowledgeQueryTool } from "./tools/query/KnowledgeQueryTool/KnowledgeQueryTool.js";
export { ProgressHistoryTool } from "./tools/query/ProgressHistoryTool/ProgressHistoryTool.js";
export { WebSearchTool, createWebSearchClient } from "./tools/network/WebSearchTool/WebSearchTool.js";
export type { ISearchClient, SearchResult } from "./tools/network/WebSearchTool/WebSearchTool.js";
export { ToolSearchTool } from "./tools/query/ToolSearchTool/ToolSearchTool.js";
export type { BuiltinToolDeps } from "./tools/builtin/index.js";
