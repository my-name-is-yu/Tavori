# Roadmap

## Current Status

Stage 1-14 + Milestone 1-18 + Phase 3 complete (4061 tests, 179 test files).
OSS optimization #112-#146: all 35 items complete.

---

## Next Milestone

### Milestone 14: Hypothesis Verification Mechanism (PIVOT/REFINE + Learning Loop)

**Theme**: Introduce AutoResearchClaw's hypothesis verification pattern into PulSeed to strengthen autonomous decision-making when strategies stall. Design: `docs/design/hypothesis-verification.md`

### 14.1: Structured PIVOT/REFINE Decision (StallDetector + StrategyManager Integration)
- Add `analyzeStallCause()` to StallDetector — infer cause from gap transition patterns
  - oscillating → REFINE (re-execute with adjusted parameters)
  - flat → PIVOT (change strategy, keep goal)
  - diverging → ESCALATE (renegotiate goal)
- Define rollback targets for each strategy in StrategyManager
- Expand CoreLoop stall branch to 3 directions
- Maximum pivot count: 2
- Impact: stall-detector.ts, strategy-manager.ts, core-loop.ts, types/
- Scale: Medium (2-3 days)

### 14.2: Decision History Learning Loop (KnowledgeManager Extension)
- DecisionRecord schema — record context at PIVOT/REFINE decision time (gap value, strategy type, stall count, trust)
- Add decision record/search API to KnowledgeManager
- Reference past decision history in StrategyManager.selectStrategy() (avoid failed strategies, prefer successful ones)
- 30-day time-decay
- Integrate with M13 semantic knowledge sharing
- Impact: knowledge-manager.ts, strategy-manager.ts, types/
- Scale: Medium-Large (3-5 days)

**Success criteria**:
- [ ] Upon stall detection, PIVOT/REFINE/ESCALATE is automatically selected based on cause
- [x] Strategies that were previously PIVOTed are automatically deprioritized for similar goals
- [ ] Dogfooding: confirm autonomous recovery for goals where 2+ stalls occur

**Status**: done (2026-03-19) — 14.1 verified against existing implementation; 14.2 activated via goalType argument fix + outcome update implementation

---

## Future Roadmap (Post-M18)

### Milestone 15: Multi-Agent Delegation

**Theme**: PulSeed itself uses sub-agents in parallel to decompose, delegate, and integrate large-scale tasks. Design: `docs/design/multi-agent-delegation.md`

- Implement PipelineExecutor (3-stage: implementor → reviewer → verifier)
- PipelineState persistence (stage continuation across restarts)
- Idempotency keys (task_id + stage_index + attempt) to prevent duplicate stage execution
- Dynamic adapter selection in coordination with CapabilityDetector (migrate from static `adapter_type` to `capability_requirement`)
- Prerequisite: M14 complete

**Status**: done (2026-03-19)

---

### Milestone 16: Advanced Long-Term Memory and Knowledge Sharing

**Theme**: Bring cross-goal knowledge transfer to a practical level and continuously improve decision quality

#### 16.1: TransferCandidate Schema Extension + DecisionRecord Structuring
- Add state, domain_tag_match, adapted_content, effectiveness_score, etc. to TransferCandidateSchema
- Add what_worked, what_failed, suggested_next to DecisionRecordSchema
- Scale: Small
- Impact: src/types/cross-portfolio.ts, src/types/knowledge.ts

#### 16.2: Transfer Trust Score Learning
- TransferTrustManager: record and learn success rates per domain pair
- transfer_score = similarity_score × confidence × trust_score
- Auto-disable after 3 consecutive failures
- Scale: Medium
- Impact: src/knowledge/transfer-trust.ts (new), src/knowledge/knowledge-transfer.ts

#### 16.3: KnowledgeTransfer Phase 2 — Auto-Application + Real-Time Detection
- Auto-apply when confidence >= 0.85 and trust_score >= 0.7
- Real-time transfer candidate scan immediately before task generation
- Automatic extraction of what_worked/what_failed from DecisionRecord
- Scale: Medium-Large
- Impact: src/knowledge/knowledge-transfer.ts, src/execution/task-lifecycle.ts, src/knowledge/knowledge-manager.ts

#### 16.4: Dynamic Budget-Based Context Selection
- Progressive disclosure 3-stage retrieval (metadata → selection → full text)
- Budget allocation: goal definition 20%, observation 30%, knowledge 30%, transfer 15%, meta 5%
- Scale: Medium-Large
- Impact: src/execution/context-budget.ts (new), src/execution/session-manager.ts, src/knowledge/vector-index.ts, src/knowledge/knowledge-search.ts

#### 16.5: Checkpoint-Style Cross-Session Handoff
- Context handoff from agent A → B
- CheckpointManager: save, load, LLM adaptation, GC
- PipelineExecutor integration
- Scale: Large
- Impact: src/types/checkpoint.ts (new), src/execution/checkpoint-manager.ts (new), src/execution/session-manager.ts, src/execution/task-lifecycle.ts, src/state-manager.ts

#### 16.6: Meta-Pattern Incremental Updates + Transfer Effect Visualization
- Migrate buildCrossGoalKnowledgeBase() from batch to incremental updates
- LearningPipeline → KnowledgeTransfer auto-trigger
- Add transfer effect report section to ReportingEngine
- Scale: Medium
- Impact: src/knowledge/knowledge-transfer.ts, src/knowledge/learning-pipeline.ts, src/reporting-engine.ts

#### 16.7: Integration Tests + Documentation Updates
- Integration tests for all of M16
- Documentation updates

**Status**: done (2026-03-19)

---

### M17: External Integration Plugin Expansion

**Theme**: Increase the variety of data sources and notifications, enabling databases and APIs to be used directly as observation sources.

- DatabaseDataSourceAdapter (PostgreSQL / MySQL / SQLite)
- WebSocket / SSE real-time DataSource
- Community plugin foundation (npm scope: `@pulseed-plugins/`, Jira DataSource, PagerDuty Notifier)
- Plugin development guide (`docs/design/plugin-development-guide.md`)
- Prerequisite: M12 (plugin architecture) complete

**Status**: done (2026-03-20) — jira-datasource, pagerduty-notifier reference implementations added + plugin development guide created

### M18: Web UI

**Theme**: A Web UI complementing the TUI for managing goals, sessions, knowledge, and settings in one place.

- Web UI (Next.js, operable in parallel with TUI)
- Goals / Sessions / Knowledge / Settings pages
- API routes (goals, sessions, strategies, knowledge, reports, events, settings)

**Status**: done (2026-03-20) — Next.js-based Web UI implemented in the `web/` directory

### Future Considerations

- Multi-user support (goal/state isolation, authentication) — to be tackled when user base grows
- DimensionMapping semantic auto-suggestion (auto-generate Zod schema from observation dimension names)
- Plugin marketplace / registry
- Circuit breaker (automatic disconnection when adapter fails repeatedly)
- Backpressure control (maximum parallel agent count management)

---

## Completed Milestones

| M | Theme | Completed |
|---|-------|-----------|
| 1 | LLM-powered observation (3-stage fallback) | 2026-03-15 |
| 2 | Mid-scale dogfooding validation (D1-D3) | 2026-03-15 |
| 3 | npm publish quality (contextProvider addition) | 2026-03-15 |
| 8 | Safety hardening + npm publish (EthicsGate L1) | 2026-03-16 |
| 9 | Observation accuracy improvement (ShellDataSource + cross-validation) | 2026-03-16 |
| 10 | Automatic goal generation (suggestGoals, pulseed improve) | 2026-03-16 |
| 11 | Autonomous strategy selection + execution quality (healthCheck, undershoot) | 2026-03-16 |
| 12 | Plugin architecture (+115 tests) | 2026-03-17 |
| 13 | Autonomous plugin selection + semantic knowledge sharing | 2026-03-17 |
| 14 | Hypothesis verification mechanism (PIVOT/REFINE + learning loop) | 2026-03-19 |
| 15 | Multi-agent delegation | 2026-03-19 |
| 16 | Advanced long-term memory and knowledge sharing | 2026-03-19 |
| 17 | External integration plugin expansion (Jira, PagerDuty, development guide) | 2026-03-20 |

See `docs/status.md` for details.

---

## Design Principles

1. **Always perform dogfooding validation at the end of each Milestone** — real goal execution always uncovers unexpected integration bugs
2. **Sanitize LLM responses before Zod parsing** — design with the assumption that out-of-enum values will arrive
3. **Never swallow errors in catch blocks** — always log them
4. **Use gpt-5.3-codex as the recommended model** — significantly superior in observation accuracy and convergence speed
5. **Implement one sub-stage at a time** — split large stages into smaller pieces
6. **Keep the core thin; extend via plugins** — isolate specific service dependencies (Slack, email, GitHub, etc.) into plugins to minimize core dependencies
7. **Plugin decision criteria**: (1) required for the loop → core, (2) zero dependencies → can be bundled with core, (3) specific service dependency → plugin
8. **PulSeed masters plugins** — autonomously selects and uses plugins via capability metadata and matching
9. **Observation accuracy is the foundation of everything** — don't blindly trust LLM observations. Cross-checking with mechanical verification is mandatory
10. **Autonomous capability follows core → extension order** — see correctly (M9) → think independently (M10) → decide independently (M11) → extend (M12+)
