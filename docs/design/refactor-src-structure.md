# src/ Folder Restructure Proposal

## Motivation

With 230+ files and a 500-line-per-file limit, the `src/` directory has accumulated:
- 8 loose files at top level that belong in subfolders
- Large folders (knowledge/ 31 files, execution/ 23 files) mixing distinct concerns
- `adapters/` mixing agent adapters and data sources — friction for tool expansion
- 8 files exceeding the 500-line limit

Future work (stability improvements, tool expansion) will add more files, making organization critical now.

## Proposed Folder Structure

```
src/
├── index.ts                          # Library exports (stays)
│
├── adapters/                         # Agent adapters (tool expansion hub)
│   ├── agents/                       # NEW — agent runtime adapters
│   │   ├── claude-code-cli.ts
│   │   ├── claude-api.ts
│   │   ├── openai-codex.ts
│   │   ├── openclaw-acp.ts
│   │   ├── a2a-adapter.ts
│   │   ├── a2a-client.ts
│   │   └── agent-profile-loader.ts
│   ├── datasources/                  # NEW — observation data sources
│   │   ├── file-existence-datasource.ts
│   │   ├── github-issue-datasource.ts
│   │   ├── shell-datasource.ts
│   │   ├── openclaw-datasource.ts
│   │   └── mcp-datasource.ts
│   ├── github-issue.ts               # GitHub issue integration
│   ├── mcp-client-manager.ts         # MCP client management
│   └── spawn-helper.ts               # Shared subprocess helper
│
├── chat/                             # Chat (unchanged)
├── cli/                              # CLI commands (unchanged structure)
│   └── cli-runner.ts                 # MOVED from src/ top level
│
├── drive/                            # Drive system (unchanged)
│
├── execution/                        # Task execution
│   ├── task/                         # NEW — task-specific logic
│   │   ├── task-approval.ts
│   │   ├── task-approval-check.ts
│   │   ├── task-execution-types.ts
│   │   ├── task-executor.ts
│   │   ├── task-generation.ts
│   │   ├── task-health-check.ts
│   │   ├── task-lifecycle.ts
│   │   ├── task-pipeline-cycle.ts
│   │   ├── task-prompt-builder.ts
│   │   ├── task-verifier.ts          # SPLIT (see §4)
│   │   ├── task-verifier-rules.ts    # NEW — extracted verification rules
│   │   └── task-verifier-llm.ts      # NEW — extracted LLM verification
│   ├── context/                      # NEW — execution context
│   │   ├── context-budget.ts
│   │   ├── context-builder.ts
│   │   ├── dimension-selector.ts
│   │   └── issue-context-fetcher.ts
│   ├── adapter-layer.ts
│   ├── checkpoint-manager.ts
│   ├── impact-analyzer.ts
│   ├── parallel-executor.ts
│   ├── pipeline-executor.ts
│   ├── reflection-generator.ts
│   ├── result-reconciler.ts
│   ├── session-manager.ts
│   └── toolset-lock.ts
│
├── goal/                             # Goal management (unchanged)
│
├── knowledge/
│   ├── memory/                       # NEW — hierarchical memory subsystem
│   │   ├── memory-compression.ts
│   │   ├── memory-distill.ts
│   │   ├── memory-exports.ts
│   │   ├── memory-index.ts
│   │   ├── memory-lifecycle.ts
│   │   ├── memory-persistence.ts
│   │   ├── memory-query.ts
│   │   ├── memory-selection.ts
│   │   ├── memory-stats.ts
│   │   └── memory-tier.ts
│   ├── transfer/                     # NEW — knowledge transfer subsystem
│   │   ├── knowledge-transfer.ts
│   │   ├── knowledge-transfer-apply.ts
│   │   ├── knowledge-transfer-detect.ts
│   │   ├── knowledge-transfer-evaluate.ts
│   │   ├── knowledge-transfer-meta.ts
│   │   ├── knowledge-transfer-prompts.ts
│   │   ├── knowledge-transfer-types.ts
│   │   └── transfer-trust.ts
│   ├── learning/                     # NEW — learning pipeline
│   │   ├── learning-pipeline.ts
│   │   ├── learning-pipeline-prompts.ts
│   │   ├── learning-cross-goal.ts
│   │   ├── learning-feedback.ts
│   │   └── learning-exports.ts
│   ├── knowledge-manager.ts          # SPLIT (see §4)
│   ├── knowledge-manager-query.ts    # NEW — extracted query methods
│   ├── knowledge-decisions.ts
│   ├── knowledge-graph.ts
│   ├── knowledge-revalidation.ts
│   ├── knowledge-search.ts
│   ├── drive-score-adapter.ts
│   ├── embedding-client.ts
│   └── vector-index.ts
│
├── llm/                              # LLM clients (unchanged)
│
├── loop/                             # Core loop (absorbs top-level files)
│   ├── core-loop.ts                  # MOVED from src/ top level
│   └── (existing 12 files)
│
├── mcp-server/                       # MCP server (unchanged)
│
├── observation/                      # Observation (unchanged)
│
├── orchestrator/                     # Orchestration layer
│   └── goal-loop.ts
│
├── prompt/                           # Prompt construction (unchanged)
│
├── reflection/                       # Reflection (unchanged)
│
├── reporting/                        # RENAMED from reporting-engine.ts
│   ├── reporting-engine.ts           # MOVED + SPLIT (see §4)
│   └── report-formatters.ts          # NEW — extracted formatting logic
│
├── runtime/                          # Runtime infrastructure (unchanged)
│
├── state/                            # NEW — state management
│   ├── state-manager.ts              # MOVED from src/ top level + SPLIT
│   └── state-persistence.ts          # NEW — extracted persistence logic
│
├── strategy/                         # Strategy (absorbs portfolio files)
│   ├── portfolio-manager.ts          # MOVED from src/ top level
│   ├── portfolio-rebalance.ts        # MOVED from src/ top level
│   └── (existing 8 files)
│
├── traits/                           # Character traits
│   └── guardrail-runner.ts           # MOVED from src/ top level
│
├── tui/                              # Terminal UI (unchanged)
├── types/                            # Type definitions (unchanged)
└── utils/                            # Utilities (unchanged)
```

## 1. Top-Level File Moves

| File | Destination | Rationale |
|------|-------------|-----------|
| `index.ts` | stays | Library entry point |
| `cli-runner.ts` | `cli/cli-runner.ts` | CLI entry point belongs with CLI commands |
| `core-loop.ts` | `loop/core-loop.ts` | `loop/` already has 12 core-loop helper files |
| `guardrail-runner.ts` | `traits/guardrail-runner.ts` | Safety guardrails relate to ethics/trust |
| `portfolio-manager.ts` | `strategy/portfolio-manager.ts` | Portfolio is a strategy concern |
| `portfolio-rebalance.ts` | `strategy/portfolio-rebalance.ts` | Same |
| `reporting-engine.ts` | `reporting/reporting-engine.ts` | New folder for split files |
| `state-manager.ts` | `state/state-manager.ts` | New folder for split files |

## 2. Large Folder Subdivisions

### knowledge/ → 3 subfolders

| Subfolder | Files | Cohesion |
|-----------|-------|----------|
| `memory/` | 10 files (`memory-*.ts`) | Hierarchical memory tier system |
| `transfer/` | 8 files (`knowledge-transfer-*.ts` + `transfer-trust.ts`) | Cross-goal knowledge transfer |
| `learning/` | 5 files (`learning-*.ts`) | Learning pipeline and feedback |

Remaining 8 files stay at `knowledge/` level (manager, graph, search, embeddings, vectors).

### execution/ → 2 subfolders

| Subfolder | Files | Cohesion |
|-----------|-------|----------|
| `task/` | 12 files (`task-*.ts`) | Task lifecycle, verification, generation |
| `context/` | 4 files (context-budget, context-builder, dimension-selector, issue-context-fetcher) | Execution context assembly |

Remaining 7 files stay at `execution/` level.

### adapters/ → 2 subfolders

| Subfolder | Files | Cohesion |
|-----------|-------|----------|
| `agents/` | 8 files (all agent runtime adapters) | Adding a new agent = drop file here |
| `datasources/` | 5 files (`*-datasource.ts`) | Adding a new data source = drop file here |

This makes tool expansion a "drop a file in the right folder" workflow.

## 3. Folder Renames & Merges

- `orchestrator/` (1 file) — keep as-is; will grow with stability work
- New `reporting/` folder — replaces lone `reporting-engine.ts`
- New `state/` folder — replaces lone `state-manager.ts`

## 4. 500+ Line File Splits

| File | Lines | Split Plan |
|------|-------|------------|
| `task-verifier.ts` | 1129 | Extract rule-based checks → `task-verifier-rules.ts`, LLM verification → `task-verifier-llm.ts` |
| `daemon-runner.ts` | 901 | Extract signal handling → `daemon-signals.ts`, health check → `daemon-health.ts` |
| `knowledge-manager.ts` | 742 | Extract query/search methods → `knowledge-manager-query.ts` |
| `reporting-engine.ts` | 725 | Extract formatters → `report-formatters.ts` |
| `cli-runner.ts` | 619 | Extract command registration → `cli-command-registry.ts` (in `cli/`) |
| `core-loop.ts` | 571 | Already has `loop/` helpers; move remaining phases to `core-loop-phases-c.ts` |
| `state-manager.ts` | 589 | Extract file I/O → `state-persistence.ts` |
| `portfolio-manager.ts` | 549 | Extract allocation logic → `portfolio-allocation.ts` (already exists in strategy/) |

## 5. Implementation Order

Ordered by safety (least import disruption first):

| Phase | Change | Risk | Notes |
|-------|--------|------|-------|
| **1** | Create new subfolders (empty) | None | mkdir only |
| **2** | Move `adapters/` files into `agents/` and `datasources/` | Low | Internal imports only |
| **3** | Move `knowledge/` files into `memory/`, `transfer/`, `learning/` | Low | Internal imports only |
| **4** | Move `execution/` files into `task/`, `context/` | Low | Internal imports only |
| **5** | Move top-level files + create `reporting/`, `state/` | Medium | Many external imports |
| **6** | Split 500+ line files | Medium | New files, updated imports |
| **7** | Update `index.ts` re-exports | Low | Final step |

## 6. Migration Strategy

1. **One phase per PR** — each phase is independently reviewable
2. **Update imports with `sed`/script** — after each move, batch-update all `.ts` files
3. **Run full test suite after each phase** — `npx vitest run` must pass
4. **Update `docs/module-map.md`** after all phases complete
5. **Re-export from old paths** is NOT recommended — clean break per phase

## 7. Test File Strategy

Test files (`__tests__/`) follow their source files. When `knowledge/memory-tier.ts` moves to `knowledge/memory/memory-tier.ts`, its test moves to `knowledge/memory/__tests__/memory-tier.test.ts`.
