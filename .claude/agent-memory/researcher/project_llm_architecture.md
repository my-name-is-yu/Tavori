---
name: Motiva LLM & Prompt Architecture
description: All LLM call sites, prompt builder locations, context provider pattern, and memory-to-prompt integration in the Motiva codebase
type: project
---

## Key locations

- LLM clients: `src/llm/` (llm-client.ts, openai-client.ts, codex-llm-client.ts, ollama-client.ts, provider-factory.ts)
- All callers use `ILLMClient` interface (`sendMessage` + `parseJSON`)
- Prompt builders: `src/goal/negotiator-prompts.ts`, `src/execution/task-prompt-builder.ts`, `src/goal/goal-suggest.ts`
- Context provider: `src/observation/workspace-context.ts` → `createWorkspaceContextProvider()`
- Memory selection: `src/knowledge/memory-selection.ts` → `selectForWorkingMemory()`
- CoreLoop integration: `src/loop/core-loop-phases-b.ts` (Phase 6/7 assembles knowledgeContext + workspaceContext)

## LLM call sites summary (42 migrate-eligible, 23 files)

Full inventory: `/tmp/prompt-gateway-migration-context.md`

Key: Phase B only moved prompts/schemas to `src/prompt/purposes/` — call sites STILL use `llmClient.sendMessage` directly. No file actually calls `PromptGateway.execute()` yet.

Exclude from migration (9 sites, 5 files): `claude-api.ts`, `a2a-client.ts`, `a2a-adapter.ts` (adapter boundaries); `intent-recognizer.ts` (TUI, no goalId); `task-verifier.ts:860` (revert, one-off).

Files needing migration grouped by layer:
- Execution (5 files): task-generation, task-verifier, observation-llm, reflection-generator, impact-analyzer
- Goal (5 files): negotiator-steps, goal-suggest, goal-decomposer, goal-tree-manager, result-reconciler
- Goal quality + Strategy (4 files): goal-tree-quality, goal-dependency-graph, strategy-manager-base, strategy-template-registry
- Knowledge part1 (5 files): knowledge-manager, knowledge-decisions, knowledge-revalidation, memory-distill, knowledge-transfer
- Knowledge + Traits (4 files): learning-pipeline, ethics-gate, curiosity-proposals, (intent-recognizer — skip)

Existing ContextPurpose values (5): observation, task_generation, verification, strategy_generation, goal_decomposition
New purposes needed (~17): goal_quality, knowledge_transfer, learning_extraction, memory_distillation, capability_check, ethics_evaluation, reflection, impact_analysis, reconciliation, goal_suggestion, feasibility, knowledge_gap, knowledge_acquisition, knowledge_consistency, knowledge_enrichment, knowledge_stability, strategy_generalization, dependency_detection, curiosity_proposals, learning_extraction

Gateway gotcha: `goalId` is required — some sites (ethics-gate, capability-detector) have no goalId. Needs API change to `goalId?: string` or sentinel `"__none__"`.

## Context provider architecture

- Priority order: always-include (README/package.json) → explicit path mentions in goal → filename keyword match → content keyword match
- Max 5 keyword-matched files (configurable), unlimited for path-explicit matches
- Output: Markdown sections with fenced file contents
- Fallback if no contextProvider: git diff (3000 chars)

## Memory → prompt integration

- `KnowledgeManager.getRelevantKnowledge()` calls `selectForWorkingMemory()` (3-tier: core/recall/archival)
- Formatted as plain Q&A pairs: "Q: ...\nA: ..."
- Injected into `buildTaskGenerationPrompt()` as "Relevant domain knowledge" section
- GAP: LessonEntry (long-term memory) is NOT injected into the observation prompt

## Full research doc

`memory/archive/research-prompt-context-architecture.md`

**Why:** Research for prompt-context architecture design (2026-03-22)
**How to apply:** Use as starting point for any work touching LLM prompts, context injection, or memory-to-prompt pipeline.

## PromptGateway implementation research (2026-03-22)

Full interface reference written to `memory/prompt-gateway-research.md`.

Key facts for future sessions:
- `relevanceScore()` in `memory-selection.ts` — design doc erroneously calls it `computeRelevanceScore()`
- `llmClassifyTier()` uses `generateStructured` not `ILLMClient` — do NOT pass ILLMClient directly
- `context-provider.ts` (newer, tier-aware) supersedes `workspace-context.ts` (older) for workspace context
- `StrategyTemplate` type is in `src/types/cross-portfolio.ts`, not `src/types/strategy.ts`
- `LessonEntry` and `ShortTermEntry` are in `src/types/memory-lifecycle.ts`
- `ReflectionNote` is in `src/types/reflection.ts`; `formatReflectionsForPrompt()` is in `src/execution/reflection-generator.ts`
- `allocateBudget()` in `src/execution/context-budget.ts` is currently NOT wired to any LLM call
