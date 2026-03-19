# External Tools: Multi-Agent Orchestration Research

Researched: 2026-03-19

## Purpose

How major AI coding tools handle multi-agent delegation and orchestration — patterns relevant to Motiva (an AI orchestrator that delegates to coding agents).

---

## 1. Claude Code (Anthropic)

### Two-tier model: Subagents vs Agent Teams

**Subagents** (stable, v2.x):
- Run within the lead's session context; own context window but share process
- Only communicate back to the parent (no peer-to-peer)
- Result summarized back into parent context — low token overhead
- Best for focused, isolated tasks where only the result matters

**Agent Teams** (experimental, v2.1.32+):
- Each teammate is a fully independent Claude Code process with its own context window
- Lead's conversation history does NOT carry over to teammates — teammates get a spawn prompt only
- Communication: teammates can message each other directly (not only through lead)
- Shared task list with self-claim: teammate pulls next unblocked task when current finishes
- File-lock-based task claiming prevents race conditions
- Task dependencies managed automatically: when blocker completes, unblocked tasks become claimable
- Mailbox system for async inter-agent messaging (message/broadcast primitives)
- Teammates load the same CLAUDE.md, MCP servers, and skills as a normal session

### Role taxonomy (from the global CLAUDE.md in this project)

| Role | Model | Purpose |
|------|-------|---------|
| advisor | opus | Task decomposition, strategy |
| researcher | sonnet | Codebase + web information gathering |
| worker (complex) | sonnet/opus | Code, analysis |
| worker (simple) | haiku | Write/Edit execution |
| reviewer | sonnet | Quality check, fact-check |
| skill-discoverer | haiku | Pattern detection |

Composer→Writer pipeline: for large rewrites, composer (opus) plans then writer (haiku) executes.

### Parallel execution and file ownership

- Git worktrees are the standard isolation mechanism: each agent works on its own branch/worktree, no file-lock conflicts
- Boss never edits source code directly on Medium+ tasks (reading code is the #1 orchestration failure mode — it triggers problem-solving and forgets delegation)
- Each worker prompt must declare owned files and forbidden files
- Parallel workers launched simultaneously only when no data/file dependencies; otherwise serialized
- Before merging parallel outputs: explicit scan for contradictions

### Verification / review pipeline

- Reviewer agent runs after workers complete
- Plan approval gate: teammate works in read-only plan mode until lead approves; rejection sends back with feedback
- Hooks: `TeammateIdle` (intercept before idle) and `TaskCompleted` (intercept before marking done) — both can return code 2 to block and send feedback
- Boss tracks output files, not inline responses (agents write to files; boss reads summaries)

### Context sharing

- Subagents: no shared memory; results returned as summary text
- Agent teams: shared task list + mailbox; no shared LLM context
- CLAUDE.md loaded by all teammates automatically — project-wide instructions propagate this way
- MCP servers available to all teammates from spawn

### Error recovery

- Orphaned/stuck teammate: lead can spawn a replacement; lead steers via direct message
- Task status can lag — lead nudges teammate if stuck
- Shutdown: teammates finish current tool call before exiting (graceful, not immediate)
- Known limitation: no session resumption for in-process teammates after `/resume`

### Sources
- [Claude Code Agent Teams docs](https://code.claude.com/docs/en/agent-teams)
- [Shipyard blog: Claude Code multi-agent 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [eesel.ai: Complete 2026 guide](https://www.eesel.ai/blog/claude-code-multiple-agent-systems-complete-2026-guide)

---

## 2. Cursor

### Architecture overview (Cursor 2.0, released 2025-10-29)

Core pattern: **ReAct loop** (Reason + Act). Model decides next action → orchestrator executes tool call → collects result → rebuilds working context → feeds back to model. Repeat until done.

Three-layer separation:
1. Intelligence layer (the LLM)
2. Execution harness (tool call loop + context rebuilding)
3. Context engine (what gets injected into each prompt)

### Composer model and multi-agent interface

- Cursor 2.0 ships Composer, their first proprietary coding model
- Multi-agent interface: up to 8 simultaneous agents
- Agents exposed as objects in the editor sidebar — visible, manageable as processes, with a "plans" view showing multi-step strategies

### Background Agents (cloud-native)

- Run asynchronously on remote machines while developer continues working
- Use cases: auto-testing, dependency monitoring, long-running refactors
- Cloud-native: own isolated environment, not blocked by local machine state

### Parallel execution and isolation

- Each agent gets its own **git worktree** (shadow workspace): isolated copy sharing repo history, detached HEAD, own working directory
- Up to 8 parallel agents; each can run own unit tests, migrations without file-locking conflicts
- Tool calls execute in a **sandbox** with strict guardrails — destructive commands blocked even if agent attempts them

### Context management

- Context engine determines what goes into each prompt — selective injection, not full history
- Abstract commands ("goto", "scroll_down") + granular search tools (find_file, search_file, search_dir) with context-limited outputs prevent context window overflow

### Verification

- Agents run unit tests locally within their worktree before merging
- Recommended pattern (from ecosystem): deploy to staging environment and run E2E tests against every agent commit — agent receives test output as observation and iterates

### Sources
- [Cursor 2.0 architecture case study (Medium)](https://medium.com/@khayyam.h/designing-high-performance-agentic-systems-an-architectural-case-study-of-the-cursor-agent-ab624e4a0a64)
- [ByteByteGo: How Cursor shipped its coding agent](https://blog.bytebytego.com/p/how-cursor-shipped-its-coding-agent)
- [Cursor features page](https://cursor.com/features)

---

## 3. OpenHands (formerly OpenDevin)

### Core architecture: Event-sourced, stateless agents

All agent-environment interactions flow as **immutable typed events** through a central hub:

```
User Message → Agent → LLM → Action → Runtime (sandbox) → Observation → Agent
```

Events are appended to a log; **ConversationState** is the single mutable source of truth with a FIFO lock for thread-safety. Agents are stateless processors — they receive events and emit events, no internal mutable state.

### Multi-agent delegation

Delegation primitive: `AgentDelegateAction` — parent agent emits this action to hand off a subtask to a child agent. Child agents inherit parent's model configuration and workspace context. Sub-agents operate as independent conversations. Current implementation: **blocking** (parent waits for child to complete before continuing). Non-blocking/parallel delegation is possible via tooling extensions.

Example: generalist agent delegates web browsing to specialized BrowsingAgent.

### Security / verification layer

Two-abstraction security pipeline built in:
- **SecurityAnalyzer**: rates each tool call (LOW / MEDIUM / HIGH / UNKNOWN risk)
- **ConfirmationPolicy**: determines approval requirements based on risk rating
- When approval required: agent pauses in `WAITING_FOR_CONFIRMATION` state until explicit user approve/reject
- On rejection: agent retries with safer alternative action

### Error recovery

- **Stuck detection**: automatic detection of pathological states (infinite loops, redundant tool calls) with automatic intervention
- **Persistence + replay**: `base_state.json` + per-event JSON files; resume by loading base state then replaying events
- **Context overflow (Condenser)**: drops oldest events and replaces with summaries when context grows too large; full log preserved on disk
- **Incomplete conversation detection**: agents auto-detect they're resuming mid-task from event log

### Task decomposition (SWE-bench context)

- Agents use granular code navigation commands (`goto`, `search_file`, `find_file`) with output truncation to prevent context bloat
- "Zoom-in" strategy: fault localization before broad changes
- Post-hoc trajectory scoring by a verifier model (pass@K scheme to boost solve rate)
- Environment setup via LLM-driven README/setup.py parsing → structured JSON recipe; retry with error logs if setup fails

### Performance

- 72% SWE-Bench Verified resolution rate with Claude Sonnet 4.5 + extended thinking (2025)

### Sources
- [OpenHands SDK arxiv paper](https://arxiv.org/abs/2511.03690)
- [OpenHands arxiv paper (ICLR 2025)](https://arxiv.org/abs/2407.16741)
- [OpenHands GitHub](https://github.com/OpenHands/software-agent-sdk)

---

## 4. OpenAI Agents SDK

### Two orchestration models

**1. Agents-as-tools**: manager agent keeps control; calls specialist agents as tool calls and synthesizes results. Manager never loses control of conversation flow.

**2. Handoffs**: triage agent routes to specialist; specialist becomes the active agent. One-way transfer — suited when the specialist takes full ownership of the sub-problem.

**Code-based orchestration** (deterministic): Python asyncio for parallel non-dependent tasks; structured outputs for routing decisions; feedback loops where evaluator agent scores executor output.

### Key practices from SDK docs

- Strong prompt engineering + tool documentation is higher leverage than framework complexity
- Single-task specialists > generalists (smaller context, better focus, cheaper)
- Evaluator-in-loop pattern: separate evaluator agent scores output and feeds back
- Invest in evaluation frameworks early; agent quality is hard to verify by inspection

### Sources
- [OpenAI Agents SDK: multi-agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)

---

## 5. VS Code (GitHub Copilot / multi-agent development, Feb 2026)

Three deployment models:
- **Local agents**: interactive, real-time steering
- **Background agents**: async CLI, isolated worktrees
- **Cloud agents**: remote infrastructure, team-visible

Subagent pattern: context-isolated agents where "intermediate exploration is contained, keeping primary context clean." Main agent gets final result only.

**Handoffs** between phases: plan → implement → review transitions. Each phase can use a different model/agent.

**Agent Sessions view**: unified dashboard across all agent types — compare outputs, delegate between agents.

### Sources
- [VS Code blog: Multi-Agent Development (Feb 2026)](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)

---

## 6. Cross-Tool Patterns (Synthesis)

### Task decomposition

| Pattern | Description | Who uses it |
|---------|-------------|-------------|
| Functional decomposition | Split by technical domain (frontend/backend/DB) | Claude Code teams, SWE-agent |
| Spatial decomposition | Split by file/directory ownership | Claude Code, Cursor worktrees |
| Temporal decomposition | Sequential phases (analyze→plan→implement→verify) | Claude Code (researcher→advisor→worker→reviewer), VS Code handoffs |
| Map-reduce | Independent items processed in parallel, aggregated | General pattern |

### Parallel execution and conflict resolution

All major tools converge on **git worktrees** as the standard isolation primitive. Key variants:
- Branch-per-agent (safer: uses git's merge detection machinery)
- File-lock conventions (simpler but fragile for large codebases)
- Claude Code agent teams use task list + file locking at the task-claim level (not file level)

Common rule: each agent declares owned file set upfront; orchestrator enforces exclusivity. Conflict detection via `git merge --no-commit --no-ff` before applying.

### Verification / review pipelines

Three levels seen across tools:
1. **Pre-merge gate**: agent runs its own tests in the worktree before reporting done
2. **Plan approval gate**: separate reviewer approves plan before agent writes any code (Claude Code `TeammateIdle` hook, Cursor read-only plan mode)
3. **Post-implementation reviewer**: dedicated reviewer agent with a distinct lens (security, performance, test coverage) runs after worker finishes

Consensus pattern: multiple independent reviewers (N=3-5) each with a different focus domain, lead synthesizes. Adversarial variant: reviewers explicitly try to disprove each other's findings.

### Context sharing between agents

| Mechanism | Description |
|-----------|-------------|
| Result summarization | Subagent returns summary; parent gets only final output (Claude Code, VS Code) |
| Shared task list | All agents see task states; self-claim available work (Claude Code teams) |
| Mailbox / message bus | Async inter-agent messaging; broadcast or point-to-point (Claude Code, OpenHands event stream) |
| Shared files | Agents write structured output to known file paths; other agents read (common workaround for no shared memory) |
| CLAUDE.md / system prompts | Project-wide instructions loaded by all agents at spawn — cheapest form of context sharing |
| MCP | Tool access standardized via Model Context Protocol — all agents can use the same tools |

What is NOT shared: LLM context window. Each agent starts fresh. The spawn prompt + project files + CLAUDE.md are the only injection points.

### Error recovery and escalation

| Pattern | Description |
|---------|-------------|
| Retry with error context | Failed action retried with error log appended to prompt |
| Stuck detection | Automatic detection of loops/redundant calls → interrupt + restart |
| Fallback agent | If primary fails, spawn fallback with same task + failure context |
| Graceful degradation | One agent's failure does not abort the whole team |
| Human escalation gate | High-risk or irreversible actions paused for approval (OpenHands SecurityAnalyzer, Claude Code permissions) |
| Event replay resumption | Persist all events; resume by replaying from last good state (OpenHands) |
| Context overflow | Drop/summarize oldest events when context grows too large (OpenHands Condenser) |

### Communication protocols (emerging standards)

- **MCP (Model Context Protocol)**: Anthropic standard for tool + data access; broadly adopted 2025
- **A2A (Agent-to-Agent Protocol)**: Google; HTTP-equivalent standard for agent-to-agent calls
- Both moving toward interoperability between agent frameworks

---

## 7. Relevance to Motiva

Motiva is a task-discovery orchestrator (observe → gap → task → delegate → verify loop). Key takeaways:

**What Motiva already does well (validated by industry)**
- Temporal decomposition (phased loop)
- Human escalation gate for irreversible actions
- Trust/confidence as an explicit numeric signal

**Patterns worth considering for Motiva**
1. **Spatial file ownership** — when Motiva spawns multiple sessions for a single goal, declare file ownership per session to prevent conflicts; use git worktrees for isolation
2. **Plan approval gate** — before a coding agent executes, have Motiva review the plan (read-only pass) and approve before execution. This reduces wasted effort on wrong approaches.
3. **SecurityAnalyzer tier** — classify agent task intent by risk level (LOW/MEDIUM/HIGH) before dispatching; different trust thresholds per tier
4. **Evaluator-in-loop** — after task execution + L1/L2 verification, consider a separate evaluator agent that scores trajectory quality (not just outcome), feeding back into trust scores
5. **Stuck detection** — detect when an agent session produces redundant tool calls or loops without progress; trigger trust penalty + escalation earlier than the current stall detector
6. **Event-sourced state** — persist all observations/actions as immutable events; enable resumption after interruption by replaying from last confirmed state
7. **Shared task list** — for multi-goal scenarios (M13+), a shared task list with dependency tracking allows multiple sessions to self-coordinate without Motiva polling each one
8. **Consensus review** — for high-stakes goals, spawn 2-3 independent verification agents with different lenses rather than a single L2 verifier; majority vote reduces false positives

**What to avoid**
- Shared LLM context across agents: not done by any tool; too expensive and unreliable
- Unlimited agent spawning without file ownership declarations: guaranteed conflicts
- Boss reading agent output inline for large tasks: degrades orchestrator reasoning (see Claude Code's #1 failure mode)
