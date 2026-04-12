# PulSeed Improvement Plan — Inspired by Claude Code Architecture

> Date: 2026-04-01
> Source: Claude Code source analysis (KAIROS, orchestration, autonomous features, tool/plugin system)
> Goal: "常駐AIエージェントはPulSeedだけと対話すれば十分"

> Current implementation note: this document is an improvement backlog, not a precise description of the current runtime. PulSeed already has a dual-loop architecture (`CoreLoop` + bounded `AgentLoop`) and native tool execution paths, so references here to a single flat loop should be read as shorthand.

## Executive Summary

Claude Code's KAIROS subsystem is a proactive "assistant mode" that transforms a reactive CLI into an always-on autonomous agent — exactly what PulSeed aspires to be at a higher level. Key adoptable patterns: (1) **Proactive Tick Loop** for idle-time initiative, (2) **MCP dual-role** (client+server) for universal tool integration, (3) **Hook lifecycle events** for deep extensibility, (4) **Dream/catch-up/morning-checkin** scheduled self-reflection, and (5) **BriefTool** pattern for unsolicited user updates. PulSeed's unique strength — the goal→gap→drive→satisfice loop — has no equivalent in Claude Code and should remain the core differentiator.

---

## Part 1: What Claude Code Does That PulSeed Should Adopt

### 1.1 Proactive Tick Loop (Impact: ★★★★★)

**What CC does:**
- KAIROS injects `<tick>` XML prompts into the conversation while idle
- Agent is instructed: "do whatever seems most useful, or call Sleep"
- `SleepTool` provides explicit pacing — agent decides when to rest
- Context-blocked flag prevents runaway error loops
- `sleep_progress` is ephemeral (not sent to API) to avoid context pollution

**What PulSeed should do:**
<<<<<<< HEAD
- PulSeed already has a structured `CoreLoop` plus a bounded `AgentLoop` for tool-using execution
=======
- PulSeed already has a long-lived CoreLoop with observation, scoring, task lifecycle, and bounded agentic phases
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
- **Add idle-tick injection** between CoreLoop cycles: when no active tasks exist, inject a `<tick>` to the LLM asking "given current goals and state, what should I proactively work on?"
- This bridges the gap between PulSeed's structured loop and CC's freeform initiative
- Implement `SleepScheduler` — adaptive sleep duration based on:
  - Time of day (night = longer sleep)
  - Goal urgency (high-gap goals = shorter sleep)
  - Recent activity (many completions = check for new work)
  - Token budget (low budget = longer sleep)

**Complexity:** Medium — hooks into existing CoreLoop idle path

---

### 1.2 MCP Dual-Role Integration (Impact: ★★★★★)

**What CC does:**
- Acts as MCP **client** — connects to external MCP servers (Slack, Gmail, Calendar, memory, etc.)
- Acts as MCP **server** — exposes itself as an MCP server for other tools to consume
- `ToolSearchTool` provides deferred/lazy tool discovery
- Tool naming: `mcp__<server>__<tool>`

**What PulSeed should do:**
- **PulSeed as MCP client**: Connect to MCP servers for:
  - Slack/Gmail/Calendar (notifications, context gathering)
  - GitHub (issue tracking, PR status)
  - Custom data sources (replaces current DataSourceAdapter)
- **PulSeed as MCP server**: Expose PulSeed's capabilities as MCP tools:
  - `pulseed_goal_status` — query goal progress
  - `pulseed_create_goal` — create new goals
  - `pulseed_observe` — trigger observation
  - `pulseed_knowledge_query` — semantic knowledge search
- This makes PulSeed **the hub** — any MCP-compatible agent can consume PulSeed's orchestration
- Replace current `DataSourceAdapter` with MCP client protocol (backwards-compatible adapter wrapper)

**Complexity:** Large — new protocol layer, but MCP SDK exists

---

### 1.3 Scheduled Self-Reflection (Impact: ★★★★☆)

**What CC does:**
- KAIROS installs 3 permanent cron tasks:
  - `catch-up` — review what happened since last check
  - `morning-checkin` — daily planning/prioritization
  - `dream` — background memory consolidation
- Cron scheduler: 1s polling, chokidar file-watch, per-project lock
- Jitter: 10% period variance (load-shedding)
- 7-day auto-expiry (except `permanent: true`)

**What PulSeed should do:**
- **Morning Planning**: Daily goal review → re-prioritize → suggest new goals
  - "Your test coverage goal is at 82% (target 90%). 3 uncovered files identified."
  - "Issue #247 has been open 5 days. Should I investigate?"
- **Evening Catch-up**: Summarize day's progress, flag stalls, update knowledge
- **Dream (Memory Consolidation)**: Run KnowledgeManager consolidation, update VectorIndex, prune stale knowledge, generate hypotheses
- **Weekly Review**: Cross-goal portfolio analysis, strategy effectiveness scoring
- PulSeed already has `MemoryLifecycleManager` — wire it to cron-scheduled dream cycles
- Add `CronScheduler` module (simple: node-cron or custom, with jitter)

**Complexity:** Medium — infrastructure exists, needs scheduling + prompt design

---

### 1.4 Hook Lifecycle System (Impact: ★★★★☆)

**What CC does:**
- 27 lifecycle hook events (PreToolUse, PostToolUse, SessionStart, SessionEnd, etc.)
- 4 hook types: command (shell), prompt (LLM), http, agent (mini-verifier)
- Hooks can approve/deny/modify tool input, inject context, mutate output
- Conditional execution via `if` field with permission rule syntax
- Agent-scoped hooks via frontmatter

**What PulSeed should do:**
- Current plugin system (`PluginLoader`, `NotifierRegistry`) is output-only (notifications)
- **Expand to lifecycle hooks:**
  - `PreObserve` / `PostObserve` — modify observation before/after LLM call
  - `PreTaskCreate` / `PostTaskCreate` — validate/enrich task creation
  - `PreExecute` / `PostExecute` — approve/log adapter invocations
  - `PreGapCalculation` / `PostGapCalculation` — inject custom gap modifiers
  - `GoalStateChange` — react to goal completion/stall/failure
  - `LoopCycleStart` / `LoopCycleEnd` — per-cycle instrumentation
- Hook types: shell command, HTTP webhook, TypeScript function
- This enables: CI/CD integration, external monitoring, custom approval flows, Slack notifications on goal completion

**Complexity:** Medium — extend existing plugin architecture

---

### 1.5 BriefTool / Proactive Notification (Impact: ★★★☆☆)

**What CC does:**
- `SendUserMessage` / `BriefTool` — surfaces unsolicited updates to users
- `status: 'proactive'` distinguishes unsolicited vs. reply messages
- In brief view, normal output is hidden — only BriefTool messages shown

**What PulSeed should do:**
- Current `NotificationDispatcher` sends notifications but is fire-and-forget
- **Add proactive update channel:**
  - Priority levels: `info` (progress), `warning` (stall detected), `action_required` (needs approval)
  - Delivery targets: TUI toast, Web UI push, Slack DM, email digest
  - Smart batching: don't spam — aggregate low-priority updates into periodic digests
  - User preference: configurable notification frequency per goal/priority
- Wire into scheduled self-reflection outputs

**Complexity:** Small-Medium — extends existing NotificationDispatcher

---

### 1.6 Remote Trigger API (Impact: ★★★☆☆)

**What CC does:**
- `RemoteTriggerTool` — external systems can wake/trigger the agent
- Bridge system enables `remote-control` via WebSocket
- `control_request` messages from IDE/Web trigger actions

**What PulSeed should do:**
- **HTTP trigger endpoint**: `POST /api/trigger` with payload:
  - `{ event: "github_push", repo: "...", data: {...} }`
  - `{ event: "slack_mention", channel: "...", message: "..." }`
  - `{ event: "schedule", task: "morning_checkin" }`
- PulSeed daemon receives trigger → maps to goal/task → executes
- This makes PulSeed reactive to external events (GitHub webhooks, Slack bot, CI failures)
- Integrate with existing `EventServer` module

**Complexity:** Medium — extends DaemonRunner + EventServer

---

### 1.7 Agent Definition via Markdown Frontmatter (Impact: ★★☆☆☆)

**What CC does:**
- `.claude/agents/*.md` files define custom agents
- Frontmatter specifies: tools, model, permissions, MCP servers, hooks, memory scope
- Priority: builtin → plugin → user → project → flag → policy

**What PulSeed should do:**
- Current adapter configuration is in `~/.pulseed/provider.json` (flat config)
- **Add `.pulseed/agents/*.md` for custom agent profiles:**
  - Define agent capabilities, preferred tools, cost budget, specialization
  - Example: `research-agent.md` with `model: gpt-5.4-mini`, `tools: [web_search, file_read]`
  - Example: `code-agent.md` with `model: claude-opus`, `tools: [shell, file_edit]`, `budget: 50000_tokens`
- Lower barrier for users to define domain-specific agents

**Complexity:** Small — config parsing + adapter selection

---

## Part 2: What PulSeed Already Does (Validation)

| Capability | Claude Code | PulSeed | Comparison |
|-----------|-------------|---------|------------|
<<<<<<< HEAD
| Core loop | Reactive (user→response) + KAIROS tick | CoreLoop + AgentLoop + bounded core phases | **PulSeed stronger** — structured, goal-driven |
=======
| Core runtime | Reactive (user→response) + KAIROS tick | CoreLoop + AgentLoop + bounded core phases | **PulSeed stronger** — structured, goal-driven |
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
| Multi-agent | Coordinator/Swarm/Fork patterns | AdapterLayer + multi-strategy portfolio | **Comparable** — different abstraction level |
| Session persistence | `~/.claude/sessions/` | `~/.pulseed/` state files | **Comparable** |
| Knowledge/Memory | Auto-memory + MEMORY.md + dream | KnowledgeManager + VectorIndex + hierarchical memory | **PulSeed stronger** — semantic, hierarchical |
| Trust/Safety | Permission modes + EthicsGate-like hooks | TrustManager + EthicsGate + approval flows | **PulSeed stronger** — quantified trust balance |
| Goal management | None (user-driven) | GoalTree + negotiation + decomposition | **PulSeed unique** |
| Gap detection | None | GapCalculator + 5 threshold types | **PulSeed unique** |
| Drive/Motivation | None | DriveSystem + DriveScorer | **PulSeed unique** |
| Satisficing | None | SatisficingJudge | **PulSeed unique** |
| Stall detection | None | StallDetector + strategy rotation | **PulSeed unique** |
| Plugin system | Rich (tools, agents, skills, hooks, MCP) | PluginLoader + NotifierRegistry | **CC stronger** |
| Tool extensibility | 27 lifecycle hooks, MCP dual-role | DataSourceAdapter, limited hooks | **CC much stronger** |

---

## Part 3: PulSeed's Unique Strengths (Preserve & Amplify)

1. **Goal→Gap→Drive loop** — No equivalent in CC. This IS PulSeed's moat.
2. **Quantified trust** — CC has binary permission modes; PulSeed has [-100,+100] asymmetric scoring.
3. **Satisficing** — CC optimizes endlessly; PulSeed knows when to stop.
4. **Strategy rotation** — CC has no concept of trying alternative approaches on stall.
5. **Portfolio management** — CC manages one task at a time; PulSeed orchestrates parallel goal pursuit.
6. **Knowledge graph + embeddings** — CC has flat memory; PulSeed has hierarchical semantic memory.

---

## Architecture: PulSeed as "The Single Interface"

```
┌─────────────────────────────────────────────────────────┐
│                    USER INTERFACE                         │
│  TUI (Ink)  │  Web UI (Next.js)  │  Slack Bot  │  API   │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  PULSEED CORE                            │
│                                                          │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐              │
│  │ CronSch │  │ CoreLoop │  │ TriggerAPI│              │
│  │ eduler  │──│ observe  │──│ (HTTP/WS) │              │
│  │         │  │ →gap→    │  │           │              │
│  │ morning │  │ score→   │  │ GitHub WH │              │
│  │ catchup │  │ task→    │  │ Slack evt │              │
│  │ dream   │  │ execute→ │  │ CI/CD     │              │
│  │ weekly  │  │ verify   │  │           │              │
│  └─────────┘  └──────────┘  └───────────┘              │
│       │            │              │                      │
│  ┌────▼────────────▼──────────────▼─────┐               │
│  │         HOOK LIFECYCLE               │               │
│  │  Pre/PostObserve, Pre/PostExecute,   │               │
│  │  GoalStateChange, LoopCycle*         │               │
│  └──────────────────────────────────────┘               │
│                    │                                     │
│  ┌─────────────────▼────────────────────┐               │
│  │          MCP CLIENT LAYER            │               │
│  │  Slack │ Gmail │ Calendar │ GitHub   │               │
│  │  Custom DataSources (via MCP)        │               │
│  └──────────────────────────────────────┘               │
│                    │                                     │
│  ┌─────────────────▼────────────────────┐               │
│  │         ADAPTER LAYER                │               │
│  │  Claude Code │ Claude API │ Codex    │               │
│  │  Custom Agents (.pulseed/agents/)    │               │
│  └──────────────────────────────────────┘               │
│                                                          │
│  ┌──────────────────────────────────────┐               │
│  │        MCP SERVER LAYER              │               │
│  │  Expose: goal_status, create_goal,   │               │
│  │  observe, knowledge_query, trigger   │               │
│  │  → Any MCP client can consume        │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase A: Foundation (2-3 weeks)
| # | Item | Complexity | Dependencies |
|---|------|-----------|--------------|
| A1 | CronScheduler module | Small | None |
| A2 | Scheduled self-reflection prompts (morning/evening/dream) | Medium | A1 |
| A3 | Proactive tick injection in CoreLoop idle path | Medium | None |
| A4 | SleepScheduler (adaptive sleep duration) | Small | A3 |

### Phase B: Integration Hub (3-4 weeks)
| # | Item | Complexity | Dependencies |
|---|------|-----------|--------------|
| B1 | MCP client layer (replace DataSourceAdapter) | Large | None |
| B2 | MCP server layer (expose PulSeed as MCP server) | Medium | None |
| B3 | Hook lifecycle system (Pre/Post events) | Medium | None |
| B4 | Remote trigger API (HTTP endpoint) | Medium | None |

### Phase C: Intelligence (2-3 weeks)
| # | Item | Complexity | Dependencies |
|---|------|-----------|--------------|
| C1 | Proactive notification channel (smart batching) | Medium | A2, B3 |
| C2 | Agent definition via Markdown frontmatter | Small | None |
| C3 | Weekly review automation | Small | A1, A2 |
| C4 | External event → goal/task mapping | Medium | B4 |

### Phase D: Polish (1-2 weeks)
| # | Item | Complexity | Dependencies |
|---|------|-----------|--------------|
| D1 | Slack bot integration (via MCP) | Medium | B1 |
| D2 | Notification preferences UI (Web UI) | Small | C1 |
| D3 | Agent profile marketplace concept | Small | C2 |

---

## Key Design Decisions to Make

1. **CronScheduler implementation**: node-cron vs custom (CC uses custom 1s poll + chokidar)
2. **MCP SDK choice**: `@modelcontextprotocol/sdk` (same as CC) — standard, well-maintained
3. **Hook execution model**: sync (block loop) vs async (fire-and-forget) vs hybrid (configurable)
4. **Trigger authentication**: API key vs JWT vs mTLS for remote trigger endpoint
5. **Notification aggregation window**: how long to batch before sending digest?

---

## Summary: The "Single Interface" Vision

After these improvements, PulSeed becomes:

1. **Proactive** — doesn't wait for commands; plans mornings, catches up evenings, dreams at night
2. **Connected** — consumes any MCP server (Slack, Gmail, GitHub, custom tools)
3. **Consumable** — exposes itself as MCP server; any agent can use PulSeed's orchestration
4. **Extensible** — 10+ lifecycle hooks for custom integrations
5. **Reactive** — HTTP/WS triggers let external events wake PulSeed
6. **Self-aware** — scheduled reflection keeps knowledge fresh and goals prioritized

The user interacts with PulSeed. PulSeed orchestrates everything else.
