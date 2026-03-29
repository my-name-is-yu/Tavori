# Module Boundary Map

> This document is a guide for Claude Code to immediately determine "which files to touch."
> Use it to quickly identify target files based on the type of change needed.

## Quick Reference: Change Type → Target Files

| What to change | Primary file | Test file |
|---|---|---|
| Goal negotiation and decomposition logic | src/goal/goal-negotiator.ts | tests/goal-negotiator.test.ts |
| Goal auto-suggestion and filtering | src/goal/goal-suggest.ts | tests/goal-negotiator-suggest.test.ts, tests/goal-negotiator-suggest-filter.test.ts |
| Goal validation and dimension conversion | src/goal/goal-validation.ts | tests/goal-tree-quality.test.ts |
| Goal tree operations and quality evaluation | src/goal/goal-tree-manager.ts | tests/goal-tree-manager.test.ts, tests/goal-tree-quality.test.ts, tests/goal-tree-concreteness.test.ts |
| Goal tree pruning and cancellation | src/goal/goal-tree-pruner.ts | tests/goal-tree-manager.test.ts |
| Goal tree quality evaluation and concreteness score | src/goal/goal-tree-quality.ts | tests/goal-tree-quality.test.ts, tests/goal-tree-concreteness.test.ts |
| Goal decomposition and sub-goal generation | src/goal/goal-decomposer.ts | tests/goal-tree-manager.test.ts |
| Goal dependency graph | src/goal/goal-dependency-graph.ts | tests/goal-dependency-graph.test.ts, tests/capability-dependency.test.ts |
| Cross-goal state aggregation | src/goal/state-aggregator.ts | tests/state-aggregator.test.ts |
| Goal tree loop execution | src/goal/tree-loop-orchestrator.ts | tests/tree-loop-orchestrator.test.ts |
| Gap calculation (5 threshold types) | src/drive/gap-calculator.ts | tests/gap-calculator.test.ts |
| Drive scoring | src/drive/drive-scorer.ts | tests/drive-scorer.test.ts |
| Drive system | src/drive/drive-system.ts | tests/drive-system.test.ts |
| Stall detection | src/drive/stall-detector.ts | tests/stall-detector.test.ts |
| Satisficing judgment | src/drive/satisficing-judge.ts | tests/satisficing-judge.test.ts, tests/satisficing-judge-undershoot.test.ts |
| Checkpoint save and restore | src/execution/checkpoint-manager.ts | tests/checkpoint-manager.test.ts |
| Context budget | src/execution/context-budget.ts | tests/context-budget.test.ts |
| Task execution lifecycle | src/execution/task-lifecycle.ts | tests/task-lifecycle.test.ts, tests/task-lifecycle-healthcheck.test.ts |
| Task verification, judgment, and failure handling | src/execution/task-verifier.ts | tests/task-lifecycle.test.ts |
| Task prompt generation | src/execution/task-prompt-builder.ts | tests/task-lifecycle.test.ts |
| Task health check | src/execution/task-health-check.ts | tests/task-lifecycle-healthcheck.test.ts |
| Adapter abstraction layer and registry | src/execution/adapter-layer.ts | tests/adapter-layer.test.ts |
| Session and context management | src/execution/session-manager.ts | tests/session-manager.test.ts, tests/session-manager-phase2.test.ts |
| Observation engine | src/observation/observation-engine.ts | tests/observation-engine.test.ts, tests/observation-engine-llm.test.ts, tests/observation-engine-context.test.ts, tests/observation-engine-dedup.test.ts, tests/observation-engine-crossvalidation.test.ts, tests/observation-engine-prompt.test.ts |
| Data source adapter foundation | src/observation/data-source-adapter.ts | tests/data-source-adapter.test.ts, tests/data-source-hotplug.test.ts |
| Capability detection and acquisition | src/observation/capability-detector.ts | tests/capability-detector.test.ts, tests/cli-capability.test.ts |
| Capability registry management and escalation | src/observation/capability-registry.ts | tests/capability-detector.test.ts |
| Capability dependency graph and acquisition order resolution | src/observation/capability-dependencies.ts | tests/capability-dependency.test.ts |
| Context provider | src/observation/context-provider.ts | tests/context-provider.test.ts |
| Workspace context | src/observation/workspace-context.ts | tests/workspace-context.test.ts |
| LLM client abstraction layer | src/llm/llm-client.ts | tests/llm-client.test.ts |
| Anthropic Claude client | src/llm/llm-client.ts (LLMClient) | tests/llm-client.test.ts |
| OpenAI client | src/llm/openai-client.ts | tests/openai-client.test.ts |
| Ollama client | src/llm/ollama-client.ts | tests/ollama-client.test.ts |
| Codex CLI client | src/llm/codex-llm-client.ts | tests/codex-llm-client.test.ts |
| Provider configuration and switching | src/llm/provider-config.ts, src/llm/provider-factory.ts | tests/provider-factory.test.ts |
| Strategy selection and management | src/strategy/strategy-manager.ts | tests/strategy-manager.test.ts |
| Strategy template registration | src/strategy/strategy-template-registry.ts | tests/strategy-template-registry.test.ts, tests/strategy-template-embedding.test.ts |
| Cross-goal portfolio | src/strategy/cross-goal-portfolio.ts | tests/cross-goal-portfolio.test.ts, tests/cross-goal-portfolio-phase2.test.ts |
| Portfolio dependency scheduling and critical path | src/strategy/portfolio-scheduling.ts | tests/cross-goal-portfolio.test.ts, tests/cross-goal-portfolio-phase2.test.ts |
| Portfolio resource allocation and stall rebalancing | src/strategy/portfolio-allocation.ts | tests/cross-goal-portfolio.test.ts, tests/cross-goal-portfolio-phase2.test.ts |
| Portfolio momentum calculation | src/strategy/portfolio-momentum.ts | tests/cross-goal-portfolio.test.ts |
| Portfolio manager | src/portfolio-manager.ts | tests/portfolio-manager.test.ts |
| Memory lifecycle | src/knowledge/memory-lifecycle.ts | tests/memory-lifecycle.test.ts, tests/memory-lifecycle-phase2.test.ts |
| Memory persistence utilities | src/knowledge/memory-persistence.ts | (via memory-lifecycle.test.ts) |
| Memory phase backward-compatible barrel (re-export) | src/knowledge/memory-phases.ts | (via memory-lifecycle.test.ts) |
| Memory index operations and lesson storage | src/knowledge/memory-index.ts | (via memory-lifecycle.test.ts) |
| Memory statistics calculation | src/knowledge/memory-stats.ts | (via memory-lifecycle.test.ts) |
| Memory query and lesson search | src/knowledge/memory-query.ts | (via memory-lifecycle.test.ts) |
| LLM pattern extraction and distillation | src/knowledge/memory-distill.ts | (via memory-lifecycle.test.ts) |
| Memory compression, long-term storage, and GC | src/knowledge/memory-compression.ts | tests/memory-lifecycle.test.ts, tests/memory-lifecycle-phase2.test.ts |
| Memory selection, relevance scoring, and semantic search | src/knowledge/memory-selection.ts | tests/memory-lifecycle.test.ts, tests/memory-lifecycle-phase2.test.ts |
| DriveScore adapter | src/knowledge/drive-score-adapter.ts | tests/drive-score-adapter.test.ts |
| Knowledge management | src/knowledge/knowledge-manager.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge search and domain knowledge loading | src/knowledge/knowledge-search.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge revalidation and staleness task generation | src/knowledge/knowledge-revalidation.ts | tests/knowledge-manager.test.ts, tests/knowledge-manager-phase2.test.ts |
| Knowledge graph | src/knowledge/knowledge-graph.ts | tests/knowledge-graph.test.ts |
| Transfer trust score | src/knowledge/transfer-trust.ts | tests/transfer-trust.test.ts |
| Knowledge transfer | src/knowledge/knowledge-transfer.ts | tests/knowledge-transfer.test.ts |
| Learning pipeline | src/knowledge/learning-pipeline.ts | tests/learning-pipeline.test.ts, tests/learning-pipeline-phase2.test.ts, tests/learning-cross-goal.test.ts |
| Learning feedback and auto-tuning | src/knowledge/learning-feedback.ts | tests/learning-pipeline.test.ts, tests/learning-pipeline-phase2.test.ts |
| Cross-goal learning and pattern sharing | src/knowledge/learning-cross-goal.ts | tests/learning-cross-goal.test.ts |
| Embedding client | src/knowledge/embedding-client.ts | tests/embedding-client.test.ts |
| Vector index | src/knowledge/vector-index.ts | tests/vector-index.test.ts |
| Ethics gate | src/traits/ethics-gate.ts | tests/ethics-gate.test.ts |
| Trust manager | src/traits/trust-manager.ts | tests/trust-manager.test.ts |
| Character configuration | src/traits/character-config.ts | tests/character-config.test.ts, tests/character-separation.test.ts |
| Curiosity engine | src/traits/curiosity-engine.ts | tests/curiosity-engine.test.ts |
| Curiosity proposal generation, hashing, and cooldown | src/traits/curiosity-proposals.ts | tests/curiosity-engine.test.ts |
| Curiosity semantic transfer detection | src/traits/curiosity-transfer.ts | tests/curiosity-engine.test.ts |
| Daemon execution management | src/runtime/daemon-runner.ts | tests/daemon-runner.test.ts |
| Process ID management | src/runtime/pid-manager.ts | tests/pid-manager.test.ts |
| Logger | src/runtime/logger.ts | tests/logger.test.ts |
| Event server | src/runtime/event-server.ts | tests/event-server.test.ts |
| Notification dispatcher | src/runtime/notification-dispatcher.ts | tests/notification-dispatcher.test.ts, tests/notification-dispatcher-plugin.test.ts |
| Plugin loader | src/runtime/plugin-loader.ts | tests/plugin-loader.test.ts |
| Notifier plugin registry | src/runtime/notifier-registry.ts | tests/notifier-registry.test.ts |
| Claude adapter (CLI) | src/adapters/claude-code-cli.ts | tests/claude-code-cli-adapter.test.ts |
| Claude adapter (API) | src/adapters/claude-api.ts | (via adapter-layer.test.ts) |
| OpenAI Codex CLI adapter | src/adapters/openai-codex.ts | tests/openai-codex-adapter.test.ts |
| GitHub Issue adapter | src/adapters/github-issue.ts | tests/github-issue-adapter.test.ts |
| GitHub Issue data source | src/adapters/github-issue-datasource.ts | tests/github-issue-datasource.test.ts |
| File existence data source | src/adapters/file-existence-datasource.ts | tests/file-existence-datasource.test.ts |
| Shell data source | src/adapters/shell-datasource.ts | tests/adapters/shell-datasource.test.ts |
| Plugin type definitions and INotifier | src/types/plugin.ts | tests/plugin-loader.test.ts, tests/notifier-registry.test.ts |
| Plugin dynamic loading | src/runtime/plugin-loader.ts | tests/plugin-loader.test.ts |
| Notifier plugin management | src/runtime/notifier-registry.ts | tests/notifier-registry.test.ts |
| Core loop | src/core-loop.ts | tests/core-loop.test.ts, tests/core-loop-integration.test.ts, tests/core-loop-capability.test.ts, tests/r1-core-loop-completion.test.ts |
| Core loop type definitions and DI | src/loop/core-loop-types.ts | tests/core-loop.test.ts |
| Tree loop execution helper | src/loop/tree-loop-runner.ts | tests/tree-loop-orchestrator.test.ts |
| Reporting | src/reporting-engine.ts | tests/reporting-engine.test.ts |
| State management (persistence) | src/state-manager.ts | tests/state-manager.test.ts |
| CLI entry point | src/cli-runner.ts | tests/cli-runner.test.ts, tests/cli-runner-integration.test.ts, tests/cli-runner-datasource-auto.test.ts |
| CLI commands (goal) | src/cli/commands/goal.ts | tests/cli-runner.test.ts |
| CLI commands (suggest and improve) | src/cli/commands/suggest.ts | tests/cli-improve.test.ts, tests/suggest-output-schema.test.ts |
| CLI commands (config) | src/cli/commands/config.ts | tests/cli-runner.test.ts |
| CLI setup and DI | src/cli/setup.ts | tests/cli-runner.test.ts |
| TUI app body | src/tui/app.tsx | tests/tui/ |
| TUI loop hook | src/tui/use-loop.ts | tests/tui/use-loop.test.ts |
| TUI intent recognition | src/tui/intent-recognizer.ts | tests/tui/intent-recognizer.test.ts |

---

## Per-Directory Module Details

### src/goal/ — Goal Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| goal-negotiator.ts | Goal negotiation, coherence checks, capability checks | `GoalNegotiator`, `EthicsRejectedError` | llm/llm-client, traits/ethics-gate, observation/observation-engine, observation/capability-detector, goal/goal-suggest, goal/goal-validation, state-manager, types/goal |
| goal-suggest.ts | Goal auto-suggestion prompts and schemas | `GoalSuggestion`, `buildSuggestGoalsPrompt`, `buildCapabilityCheckPrompt`, `CapabilityCheckResultSchema` | types/suggest |
| goal-validation.ts | Dimension conversion, threshold construction, dedup, matching | `decompositionToDimension`, `buildThreshold`, `deduplicateDimensionKeys`, `findBestDimensionMatch` | types/goal |
| goal-tree-manager.ts | Integrated entry point for goal tree operations (delegates decomposition, pruning, and quality) | `GoalTreeManager`, `GoalTreeManagerOptions` | state-manager, llm/llm-client, traits/ethics-gate, goal/goal-dependency-graph, goal/goal-negotiator, goal/goal-tree-pruner, goal/goal-tree-quality, goal/goal-decomposer, types/goal, types/goal-tree |
| goal-tree-pruner.ts | Goal tree pruning, cancellation, and history management | `GoalTreePrunerDeps`, `cancelGoalAndDescendants`, `pruneGoal`, `pruneSubgoal`, `getPruneHistory` | state-manager, types/goal, types/goal-tree |
| goal-tree-quality.ts | Goal tree concreteness score and decomposition quality evaluation | `GoalTreeQualityDeps`, `scoreConcreteness`, `evaluateDecompositionQuality` | llm/llm-client, types/goal, types/goal-tree |
| goal-decomposer.ts | Goal-to-sub-goal decomposition and LLM prompt generation | `GoalDecomposerDeps`, `decompose`, `decomposeIntoSubgoals` | llm/llm-client, types/goal, types/goal-tree |
| goal-dependency-graph.ts | Inter-goal dependency graph management | `GoalDependencyGraph` | types/dependency |
| state-aggregator.ts | State aggregation across the entire goal tree | `StateAggregator`, `AggregatedState` | state-manager, types/goal, types/goal-tree |
| tree-loop-orchestrator.ts | Loop execution across the entire goal tree | `TreeLoopOrchestrator` | state-manager, goal/goal-tree-manager, goal/state-aggregator, execution/task-lifecycle, drive/satisficing-judge, types/goal-tree |

### src/drive/ — Drive Calculation

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| gap-calculator.ts | 5-threshold-type gap calculation, normalization, and aggregation | `computeRawGap`, `normalizeGap`, `applyConfidenceWeight`, `calculateDimensionGap`, `calculateGapVector`, `aggregateGaps`, `DimensionGapInput` | types/gap, types/core |
| drive-scorer.ts | Dissatisfaction, deadline, and opportunity score calculation | `scoreDissatisfaction`, `scoreDeadline`, `scoreOpportunity`, `computeOpportunityValue`, `combineDriveScores`, `scoreAllDimensions`, `rankDimensions` | types/drive, types/gap |
| drive-system.ts | Integrated drive score management | `DriveSystem` | drive/gap-calculator, drive/drive-scorer, types/drive, types/core |
| stall-detector.ts | Progress stall detection | `StallDetector` | types/stall, types/state |
| satisficing-judge.ts | Satisficing judgment and resource undershoot | `SatisficingJudge`, `aggregateValues` | types/satisficing, types/goal, types/goal-tree |

### src/execution/ — Task Execution

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| adapter-layer.ts | Adapter abstract interface and registry | `AgentTask`, `AgentResult`, `IAdapter`, `AdapterRegistry` | types/task |
| session-manager.ts | Context budget management and session construction | `SessionManager`, `ContextBudget`, `DEFAULT_CONTEXT_BUDGET` | state-manager, knowledge/knowledge-manager, types/session |
| task-lifecycle.ts | Full task lifecycle (integrated orchestration of generation → execution → verification) | `TaskLifecycle`, `TaskCycleResult` | state-manager, llm/llm-client, execution/session-manager, execution/task-verifier, traits/trust-manager, strategy/strategy-manager, drive/stall-detector, drive/drive-scorer, execution/task-prompt-builder, execution/task-health-check, traits/ethics-gate, observation/capability-detector, types/task |
| task-verifier.ts | Task verification, judgment, and failure handling | `ExecutorReport`, `VerdictResult`, `FailureResult`, `VerifierDeps`, `verifyTask`, `handleVerdict`, `handleFailure` | state-manager, llm/llm-client, traits/trust-manager, types/task |
| task-prompt-builder.ts | Task generation prompt construction | `buildTaskGenerationPrompt` | types/task, types/drive, types/gap |
| task-health-check.ts | Post-task execution health check | `runShellCommand` (internal use) | (Node.js child_process) |
| checkpoint-manager.ts | Cross-session checkpoint management | `CheckpointManager` | state-manager, types/checkpoint |
| context-budget.ts | Context budget allocation and selection | `allocateBudget`, `selectWithinBudget`, `trimToBudget` | (none) |

### src/observation/ — Observation

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| observation-engine.ts | State observation, LLM review, and cross-validation | `ObservationEngine`, `ObservationEngineOptions`, `CrossValidationResult` | state-manager, llm/llm-client, observation/data-source-adapter, types/state, types/core, types/knowledge |
| data-source-adapter.ts | Data source abstraction layer, file/HTTP adapters, and registry | `IDataSourceAdapter`, `FileDataSourceAdapter`, `HttpApiDataSourceAdapter`, `DataSourceRegistry`, `getNestedValue` | types/data-source |
| capability-detector.ts | Integrated entry point for capability detection, autonomous acquisition planning, and verification | `CapabilityDetector` | state-manager, llm/llm-client, observation/capability-registry, observation/capability-dependencies, types/capability |
| capability-registry.ts | Capability registry CRUD, status management, and escalation | `RegistryDeps`, `EscalateDeps`, `loadRegistry`, `saveRegistry`, `registerCapability`, `removeCapability`, `findCapabilityByName`, `getAcquisitionHistory`, `setCapabilityStatus`, `escalateToUser` | state-manager, types/capability |
| capability-dependencies.ts | Capability dependency graph management, acquisition order resolution, and cycle detection | `DependencyDeps`, `loadDependencies`, `saveDependencies`, `addDependency`, `getDependencies`, `resolveDependencies`, `detectCircularDependency`, `getAcquisitionOrder` | state-manager, types/capability |
| context-provider.ts | Workspace context collection | `dimensionNameToSearchTerms` (+ internal `buildWorkspaceContext`) | (Node.js fs, child_process) |
| workspace-context.ts | Workspace context provider factory | `WorkspaceContextOptions`, `createWorkspaceContextProvider` | (Node.js fs, child_process) |

### src/llm/ — LLM Clients

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| llm-client.ts | LLM interface definition, Anthropic implementation, and Mock | `ILLMClient`, `LLMClient`, `MockLLMClient`, `LLMMessage`, `LLMRequestOptions`, `LLMResponse`, `extractJSON` | @anthropic-ai/sdk |
| openai-client.ts | OpenAI API implementation | `OpenAILLMClient`, `OpenAIClientConfig` | openai SDK |
| ollama-client.ts | Ollama local LLM implementation | `OllamaLLMClient`, `OllamaClientConfig` | node:http |
| codex-llm-client.ts | OpenAI Codex CLI-based LLM implementation | `CodexLLMClient`, `CodexLLMClientConfig` | node:child_process |
| provider-config.ts | Provider configuration file read/write | `ProviderConfig`, `loadProviderConfig`, `saveProviderConfig` | node:fs |
| provider-factory.ts | DI factory for LLM client and adapter registry | `buildLLMClient`, `buildAdapterRegistry` | llm/provider-config, llm/llm-client, llm/openai-client, llm/ollama-client, llm/codex-llm-client, adapters/* |

### src/strategy/ — Strategy Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| strategy-manager.ts | Strategy selection, activation, and updating | `StrategyManager` | state-manager, llm/llm-client, types/strategy, types/knowledge |
| strategy-template-registry.ts | Strategy template registration and embedding-based search | `StrategyTemplateRegistry` | knowledge/embedding-client, knowledge/vector-index, types/strategy |
| cross-goal-portfolio.ts | Cross-goal portfolio integrated entry point (delegates allocation, scheduling, and momentum) | `CrossGoalPortfolio` | state-manager, strategy/portfolio-scheduling, strategy/portfolio-allocation, strategy/portfolio-momentum, types/cross-portfolio, types/goal |
| portfolio-scheduling.ts | Dependency schedule construction and critical path calculation | `buildDependencySchedule`, `computeCriticalPath` | types/cross-portfolio, types/goal |
| portfolio-allocation.ts | Resource allocation and stall rebalancing | `AllocationConfig`, `allocateResources`, `rebalanceOnStall` | types/cross-portfolio, types/drive |
| portfolio-momentum.ts | Goal momentum calculation | `calculateMomentum` | types/cross-portfolio |

### src/knowledge/ — Knowledge and Memory Management

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| memory-lifecycle.ts | Integrated memory lifecycle management (integrated entry point for short/long-term/compression) | `MemoryLifecycleManager`, `IDriveScorer` (re-export) | llm/llm-client, knowledge/embedding-client, knowledge/vector-index, knowledge/drive-score-adapter, knowledge/memory-compression, knowledge/memory-selection, knowledge/memory-index, knowledge/memory-stats, knowledge/memory-query, knowledge/memory-distill, knowledge/memory-persistence |
| memory-phases.ts | Backward-compatible barrel — re-exports memory-index/stats/query/distill | (transparently re-exports each function) | knowledge/memory-index, knowledge/memory-stats, knowledge/memory-query, knowledge/memory-distill |
| memory-index.ts | Memory index CRUD and lesson long-term storage | `initializeIndex`, `loadIndex`, `saveIndex`, `updateIndex`, `removeFromIndex`, `removeGoalFromIndex`, `touchIndexEntry`, `archiveOldestLongTermEntries`, `storeLessonsLongTerm` | types/memory-lifecycle, knowledge/memory-persistence |
| memory-stats.ts | Memory statistics calculation, task/dimension merge, and trend | `updateStatistics`, `mergeTaskStats`, `mergeDimStats`, `computeTrend`, `computePeriod` | types/memory-lifecycle |
| memory-query.ts | Lesson search and cross-goal queries | `queryLessons`, `queryCrossGoalLessons` | types/memory-lifecycle |
| memory-distill.ts | LLM pattern extraction, lesson distillation, and compression quality validation | `extractPatterns`, `distillLessons`, `validateCompressionQuality` | llm/llm-client, types/memory-lifecycle |
| memory-compression.ts | Short-term to long-term compression, retention policy, and GC | `MemoryCompressionDeps`, `compressionDelay`, `compressToLongTerm`, `compressAllRemainingToLongTerm`, `applyRetentionPolicy`, `runGarbageCollection` | llm/llm-client, knowledge/memory-index, knowledge/memory-distill, knowledge/memory-persistence, types/memory-lifecycle |
| memory-selection.ts | Relevance scoring, working memory selection, and semantic search | `MemorySelectionDeps`, `relevanceScore`, `selectForWorkingMemory`, `searchCrossGoalLessons`, `selectForWorkingMemorySemantic`, `getCompressionDelay`, `getDeadlineBonus` | knowledge/embedding-client, knowledge/vector-index, types/memory-lifecycle |
| memory-persistence.ts | File I/O, atomic write, and ID generator | `atomicWrite`, `readJsonFile`, `getDataFile`, `generateId`, `getDirectorySize`, `getRetentionLimit` | node:fs |
| drive-score-adapter.ts | Adapter connecting DriveScore to MemoryLifecycle | `IDriveScorer`, `DriveScoreAdapter` | drive/drive-scorer, types/drive |
| knowledge-manager.ts | Integrated entry point for knowledge management (delegates save, search, and revalidation) | `KnowledgeManager` | state-manager, llm/llm-client, knowledge/vector-index, knowledge/embedding-client, knowledge/knowledge-search, knowledge/knowledge-revalidation, types/knowledge, types/task |
| knowledge-search.ts | Knowledge search, domain knowledge loading, and embedding search | `SearchDeps`, `loadSharedEntries`, `loadDomainKnowledge`, `searchKnowledge`, `searchAcrossGoals`, `querySharedKnowledge`, `searchByEmbedding` | state-manager, knowledge/embedding-client, knowledge/vector-index, types/knowledge |
| knowledge-revalidation.ts | Knowledge revalidation, staleness detection, and revalidation task generation | `RevalidationDeps`, `classifyDomainStability`, `getStaleEntries`, `generateRevalidationTasks`, `computeRevalidationDue` | state-manager, llm/llm-client, types/knowledge |
| knowledge-graph.ts | Graph structure management between goals, tasks, and knowledge | `KnowledgeGraph` | types/knowledge |
| transfer-trust.ts | Transfer trust score learning and invalidation judgment | `TransferTrustManager` | state-manager, types/cross-portfolio |
| knowledge-transfer.ts | Cross-goal knowledge transfer and similar goal search | `KnowledgeTransfer` | knowledge/embedding-client, knowledge/vector-index, types/knowledge, types/learning |
| learning-pipeline.ts | Integrated entry point for extracting lessons from execution results | `LearningPipeline` | llm/llm-client, knowledge/memory-lifecycle, knowledge/knowledge-transfer, knowledge/learning-feedback, knowledge/learning-cross-goal, types/learning |
| learning-feedback.ts | Structural feedback recording, aggregation, and automatic parameter tuning | `FeedbackDeps`, `getStructuralFeedback`, `recordStructuralFeedback`, `aggregateFeedback`, `autoTuneParameters` | types/learning |
| learning-cross-goal.ts | Cross-goal pattern extraction and pattern sharing | `CrossGoalDeps`, `extractCrossGoalPatterns`, `sharePatternsAcrossGoals` | knowledge/knowledge-transfer, types/learning |
| embedding-client.ts | Embedding vector generation interface | `IEmbeddingClient`, `MockEmbeddingClient`, `OllamaEmbeddingClient`, `OpenAIEmbeddingClient`, `cosineSimilarity` | openai SDK, node:http |
| vector-index.ts | Vector nearest-neighbor search by cosine similarity | `VectorIndex` | knowledge/embedding-client |

### src/traits/ — Character, Ethics, and Trust

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| ethics-gate.ts | Task ethics review and block judgment (destructive/credential/integrity/privacy) | `EthicsGate` | llm/llm-client, types/ethics, types/task |
| trust-manager.ts | Agent trust score management ([-100,+100]) | `TrustManager` | state-manager, types/trust |
| character-config.ts | Agent character configuration read/write | `CharacterConfigManager` | state-manager, types/character |
| curiosity-engine.ts | Curiosity engine integrated entry point (delegates proposal generation and transfer detection) | `CuriosityEngine`, `CuriosityEngineDeps` | llm/llm-client, observation/observation-engine, traits/curiosity-proposals, traits/curiosity-transfer, types/curiosity |
| curiosity-proposals.ts | Proposal prompt generation, hashing, cooldown, and LLM calls | `ProposalGenerationDeps`, `buildProposalPrompt`, `computeProposalHash`, `isInRejectionCooldown`, `generateProposals` | llm/llm-client, types/curiosity |
| curiosity-transfer.ts | Semantic transfer opportunity detection | `TransferDetectionDeps`, `detectSemanticTransfer`, `detectKnowledgeTransferOpportunities` | knowledge/embedding-client, types/curiosity |

### src/runtime/ — Process Management and I/O

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| logger.ts | Structured log output (debug/info/warn/error) | `Logger`, `LogLevel`, `LoggerConfig` | node:fs |
| pid-manager.ts | Daemon PID file management | `PIDManager` | node:fs |
| daemon-runner.ts | Daemon start, stop, and restart management, graceful shutdown, and crash recovery | `DaemonRunner`, `DaemonDeps` | runtime/pid-manager, runtime/logger, runtime/event-server, types/daemon |
| event-server.ts | File-queue-based event reception and real-time file watcher (fs.watch) | `EventServer`, `EventServerConfig` | node:fs |
| notification-dispatcher.ts | Notification delivery (stdout/file/webhook) + routing to INotifier plugins | `NotificationDispatcher`, `INotificationDispatcher` | runtime/logger, runtime/notifier-registry, types/notification |
| plugin-loader.ts | Dynamic plugin loading from `~/.pulseed/plugins/`, manifest validation, and auto-registration to registry | `PluginLoader`, `PluginLoaderOptions` | runtime/notifier-registry, execution/adapter-layer, observation/data-source-adapter, types/plugin |
| notifier-registry.ts | INotifier plugin CRUD management and eventType-based routing | `NotifierRegistry` | types/plugin |

### src/adapters/ — Agent Adapter Implementations

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| claude-code-cli.ts | Task execution via Claude Code CLI | `ClaudeCodeCLIAdapter` (IAdapter) | execution/adapter-layer, types/task |
| claude-api.ts | Task execution via Anthropic API | `ClaudeAPIAdapter` (IAdapter) | execution/adapter-layer, llm/llm-client |
| openai-codex.ts | Task execution via OpenAI Codex CLI | `OpenAICodexCLIAdapter`, `OpenAICodexCLIAdapterConfig` | execution/adapter-layer |
| github-issue.ts | GitHub Issue creation and management adapter | `GitHubIssueAdapter`, `GitHubIssueAdapterConfig`, `ParsedIssue` | execution/adapter-layer |
| github-issue-datasource.ts | GitHub Issue state observation data source | `GitHubIssueDataSourceAdapter` (IDataSourceAdapter) | observation/data-source-adapter, types/data-source |
| file-existence-datasource.ts | Data source observing file existence | `FileExistenceDataSourceAdapter` (IDataSourceAdapter) | observation/data-source-adapter, types/data-source |
| shell-datasource.ts | Data source observing shell command output | `ShellDataSourceAdapter`, `ShellCommandSpec` | observation/data-source-adapter, types/data-source |
| openclaw-acp.ts | OpenClaw ACP (Agent Communication Protocol) adapter. Drives `openclaw acp` CLI as a stdio child process | `OpenClawACPAdapter`, `OpenClawACPConfig` | (none — child_process.spawn only) |
| openclaw-datasource.ts | OpenClaw session log observation data source. Reads JSONL from `~/.openclaw/sessions/` for progress metrics | `OpenClawDataSourceAdapter`, `OpenClawDataSourceConfig` | (none — fs/promises only) |

### plugins/ — Sample Plugins (Outside Core)

| Directory | Overview | Test File |
|---|---|---|
| plugins/slack-notifier/ | Slack Webhook notification plugin (INotifier implementation sample). plugin.yaml (manifest) + src/index.ts (implementation). Core-independent, standalone npm package. | tests/plugin-slack-notifier.test.ts |

### src/ — Root Modules (Integration Layer)

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| core-loop.ts | Main orchestration loop (delegates type definitions, DI, and tree execution) | `CoreLoop` | loop/core-loop-types, loop/tree-loop-runner, all modules (DI injection) |
| state-manager.ts | File-based JSON persistence for goals, state, and logs | `StateManager` | node:fs, types/goal, types/state |
| reporting-engine.ts | Execution summary and notification generation | `ReportingEngine` | runtime/notification-dispatcher, types/report |
| portfolio-manager.ts | Parallel portfolio strategy management | `PortfolioManager` | state-manager, drive/drive-scorer, execution/task-lifecycle, strategy/cross-goal-portfolio, types/portfolio |
| index.ts | Library public API (for npm publish) | (all major classes re-exported) | all modules |
| cli-runner.ts | CLI entry point and command routing | (no default export, main function) | cli/setup, cli/commands/*, state-manager |

### src/loop/ — Core Loop Auxiliary Modules

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| core-loop-types.ts | Core loop type definitions, interfaces, DI dependency types, and `buildDriveContext` | `GapCalculatorModule`, `DriveScorerModule`, `LoopConfig`, `LoopIterationResult`, `LoopResult`, `CoreLoopDeps`, `ProgressEvent`, `buildDriveContext` | types/goal, types/drive, types/core |
| tree-loop-runner.ts | Iteration execution helper for multi-goal/tree loops | `runTreeIteration`, `runMultiGoalIteration` | state-manager, goal/goal-tree-manager, goal/state-aggregator, execution/task-lifecycle, drive/satisficing-judge, types/goal-tree |
| core-loop-learning.ts | Learning pipeline, knowledge transfer, and capability acquisition failure tracking | `CoreLoopLearning` | core-loop-types (CoreLoopDeps), runtime/logger |

### src/cli/ — CLI Command Implementations

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| setup.ts | DI assembly for all dependencies | `buildDeps` | all modules (DI assembly) |
| utils.ts | CLI helpers and usage display | `formatOperationError`, `printUsage`, `printCharacterConfig` | (none) |
| commands/run.ts | `pulseed run` command implementation | `buildApprovalFn` | core-loop, state-manager |
| commands/goal.ts | `pulseed goal *` command group | `cmdGoalList`, `cmdStatus`, `cmdGoalShow`, `cmdGoalReset`, `cmdLog`, `cmdCleanup`, `autoRegisterFileExistenceDataSources` | state-manager, observation/data-source-adapter, adapters/file-existence-datasource |
| commands/report.ts | `pulseed report` command | `cmdReport` | state-manager, reporting-engine |
| commands/suggest.ts | `pulseed suggest` / `pulseed improve` commands | `normalizeSuggestPayload` | goal/goal-negotiator, observation/capability-detector, state-manager |
| commands/config.ts | `pulseed provider` / `pulseed character` / `pulseed datasource` | `maskSecrets`, `cmdProvider`, `cmdConfigCharacter`, `cmdDatasourceList`, `cmdDatasourceRemove` | llm/provider-config, traits/character-config, state-manager |
| commands/daemon.ts | `pulseed daemon start/stop/status` commands | (internal implementation) | runtime/daemon-runner, runtime/pid-manager |

### src/tui/ — TUI Dashboard (Ink/React)

| File | Responsibility | Key Exports | Dependencies |
|---|---|---|---|
| entry.ts | TUI startup entry point | (main function) | tui/app, core-loop |
| app.tsx | TUI app body and state management | `App`, `ApprovalRequest` | tui/dashboard, tui/chat, tui/use-loop, tui/actions, tui/approval-overlay |
| use-loop.ts | React integration hook with core loop | `useLoop`, `LoopController`, `LoopState`, `DimensionProgress`, `calcDimensionProgress`, `UseLoopResult` | core-loop |
| intent-recognizer.ts | Chat input intent classification | `IntentRecognizer`, `IntentType`, `RecognizedIntent` | (none) |
| actions.ts | TUI action handlers | `ActionHandler`, `ActionDeps`, `ActionResult` | core-loop, goal/goal-negotiator |
| dashboard.tsx | State dashboard display component | `Dashboard` | tui/use-loop |
| chat.tsx | Chat UI component | `Chat`, `ChatMessage` | (Ink/React) |
| approval-overlay.tsx | Task approval overlay | `ApprovalOverlay` | (Ink/React) |
| help-overlay.tsx | Help overlay | `HelpOverlay` | (Ink/React) |
| report-view.tsx | Report display component | `ReportView`, `ReportViewProps` | tui/markdown-renderer |
| markdown-renderer.ts | Markdown text rendering | `renderMarkdownLines`, `renderMarkdown`, `MarkdownLine` | (none) |

### src/types/ — Type Definitions (Zod Schemas)

| File | Key Types |
|---|---|
| types/core.ts | ObservationLayer, ConfidenceTier, StrategyState, etc. |
| types/goal.ts | Goal, Dimension, Threshold, GoalSchema |
| types/goal-tree.ts | GoalTreeNode, ConcretenessScore, DecompositionQualityMetrics |
| types/gap.ts | GapVector, DimensionGap |
| types/drive.ts | DriveContext, DriveScore |
| types/task.ts | Task, VerificationResult |
| types/strategy.ts | Strategy, Portfolio, WaitStrategy |
| types/state.ts | ObservationLog, ObservationLogEntry |
| types/session.ts | SessionContext |
| types/trust.ts | TrustScore |
| types/satisficing.ts | SatisficingResult |
| types/stall.ts | StallSignal |
| types/ethics.ts | EthicsVerdict |
| types/knowledge.ts | KnowledgeGapSignal, KnowledgeEntry |
| types/memory-lifecycle.ts | ShortTermEntry, LongTermEntry, MemoryIndex, RetentionConfig |
| types/learning.ts | LessonRecord, LearningResult |
| types/cross-portfolio.ts | TransferCandidate |
| types/capability.ts | CapabilityInfo, CapabilityAcquisitionTask |
| types/data-source.ts | DataSourceConfig, DataSourceQuery |
| types/dependency.ts | GoalDependency |
| types/embedding.ts | EmbeddingVector |
| types/character.ts | CharacterConfig |
| types/curiosity.ts | CuriosityProposal |
| types/notification.ts | NotificationPayload |
| types/daemon.ts | DaemonConfig |
| types/report.ts | ReportEntry |
| types/portfolio.ts | PortfolioState |
| types/negotiation.ts | NegotiationResult |
| types/suggest.ts | SuggestOutput |
| types/plugin.ts | PluginManifest, INotifier, NotificationEvent, NotificationEventType |
| types/checkpoint.ts | CheckpointSchema, CheckpointIndexSchema |
| types/index.ts | Re-export of all types |

---

## Architectural Notes

- **CoreLoop receives all modules via DI** — Changing `CoreLoopDeps` has broad impact
- **IAdapter / IDataSourceAdapter are independent abstraction layers** — Adding a new adapter only requires implementing the interfaces in `execution/adapter-layer.ts` / `observation/data-source-adapter.ts`
- **ILLMClient is also an abstraction layer** — Adding/switching LLM providers requires only changing `llm/provider-factory.ts`
- **types/ has zero dependencies** — Does not import other src modules. Type changes have the widest impact
- **memory-phases.ts is a backward-compatible barrel** — For compatibility maintenance only. New code should import directly from memory-index/stats/query/distill
- **Phase 3 splitting pattern** — Large files are split into "integrated entry point (original filename) + responsibility-based submodules." The original file handles only orchestration; implementations live in delegated modules
- **loop/ is an auxiliary module for core-loop.ts** — The CoreLoop class body is in src/core-loop.ts, type definitions and DI types are in loop/core-loop-types.ts, tree execution helpers are in loop/tree-loop-runner.ts, and learning/transfer responsibilities are in loop/core-loop-learning.ts
