# Chat Mode Design

> Defines Tier 1: an interactive, 1-shot execution mode where users give tasks directly and optionally escalate to Tier 2 via `/track`.

> Current implementation note: chat mode is no longer just a thin `adapter.execute()` wrapper. The current runtime can route chat through the native AgentLoop with tool use, bounded turns, approvals, and context compaction. Read older sections in this document as design intent; the runtime truth lives in `src/interface/chat/` and `src/orchestrator/execution/agent-loop/`.

---

## 1. Problem Statement

PulSeed's existing Tier 2 mode (goal pursuit with observation loop) requires upfront goal definition. This is the right model for long-running, multi-session objectives — but it is too heavy for exploratory or immediate tasks.

A user who wants to "add a docstring to this function" or "check why CI is failing" should not need to define dimensions, thresholds, and acceptance criteria. They need to type a task and get a result.

Without a Tier 1 entry point, PulSeed forces users into one of two bad options:
- Define a formal goal for every small task (high overhead, wrong abstraction)
- Use an agent directly, bypassing PulSeed entirely (PulSeed adds no value)

Chat mode solves this by making PulSeed the default entry point for interactive agent work, with escalation paths into long-lived goal execution when the work grows.

---

## 2. Design Goals

| Goal | Rationale |
|------|-----------|
| Zero-friction entry | Any task, typed directly, executes immediately |
| Unified input model | All tiers start from Tier 1 — no mode-switching before starting |
| Manual escalation in Phase 1 | User decides when to promote to Tier 2; no magic auto-promotion yet |
| No new adapter surface | Reuse `IAdapter.execute()` exactly as-is |
| Session scoping to workspace | Context is always relevant to what the user is working on |
| Forward-compatible | Phase 2 persistence, Phase 3 auto-escalation can be added without redesign |

---

## 3. Tier Model

```
Tier 1 — Chat Mode
    bounded interactive execution
    User drives: type task -> AgentLoop/tool execution -> result returned
    Escalation: /track or /tend style handoff into long-lived control paths

Tier 2 — Goal Pursuit
    goal-driven CoreLoop with optional tree decomposition and multi-goal scheduling
    PulSeed drives long-lived control, while bounded AgentLoop runs tasks and selected core phases
    Entry: `pulseed run`, daemon scheduling, TUI control, or chat handoff
```

All input starts at Tier 1. Tier 2 is an opt-in promotion, not a separate mode that users must select before typing.

---

## 4. Architecture

```
pulseed chat ["task"]
    │
    ▼
ChatRunner  (`src/interface/chat/chat-runner.ts`)
    │
    ├── Session scoping
    │       git root detection → session ID
    │       ChatSession created or resumed
    │
    ├── Turn construction
    │       prompt = task description + conversation history + system rules
    │       cwd    = current working directory
    │       tools  = built from ToolRegistry
    │
    ├── Native AgentLoop execution when available
    │       bounded turns / tool policy / compaction / approvals
    │
    ├── Fallback adapter execution when native AgentLoop is not selected
    │
    ├── AgentResult
    │       output rendered to terminal
    │       appended to ChatHistory
    │
    ├── ChatHistory  (`src/interface/chat/chat-history.ts`)
    │       ChatMessage[] in-memory
    │       Persisted to StateManager.writeRaw("chat/sessions/<id>.json")
    │       Compaction: summarize old turns when token budget exceeded
    │
    └── Escalation command handler  (src/chat/escalation.ts)
            /track → Tier 2 promotion (CoreLoop, tree decomposition auto-determined)
            /help, /clear, /exit  built-in commands
```

### Interactive vs. Non-interactive

```
pulseed chat "fix the failing test"
    └── non-interactive: single execute → print result → exit

pulseed chat
    └── interactive REPL:
            show prompt
            read line
            if /command → handle command
            else        → ChatRunner.execute(line)
            loop
```

---

## 5. Component Descriptions

### 5.1 ChatRunner (`src/chat/chat-runner.ts`)

The central coordinator. Owns the request/response cycle for a single turn.

Responsibilities:
- Resolve the active session (create if first turn, load if resuming)
- Call `buildChatContext()` to assemble the prompt context
- Construct `AgentTask` (same type used by TaskLifecycle — no new type needed)
- Call `adapter.execute(task)` directly — **TaskLifecycle is bypassed**
- Write `AgentResult` output to terminal
- Append both the user message and the agent response to `ChatHistory`
- Detect `/commands` before dispatching to the adapter

Why avoid TaskLifecycle for normal chat turns? TaskLifecycle is goal-centric. It expects target dimensions, drive scores, scope boundaries, and task verification semantics. Free-form chat work does not naturally provide those. The current runtime therefore uses a bounded AgentLoop for chat, while leaving goal-driven execution to CoreLoop and TaskLifecycle.

**Command interception pattern (from Claude Code):** Before dispatching to the adapter, ChatRunner checks if the input starts with `/`. Slash commands (`/track`, `/help`, `/clear`, `/exit`) are handled locally without an API call. Plain text is forwarded to `adapter.execute()`. This mirrors CC's `processUserInput()` pattern — intercept before dispatch, not after.

### 5.2 ChatHistory (`src/chat/chat-history.ts`)

Manages the conversation record for a session.

```typescript
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;        // ISO 8601
  turnIndex: number;
}

interface ChatSession {
  id: string;               // uuid
  cwd: string;              // git root at session start
  createdAt: string;
  messages: ChatMessage[];
  compactionSummary?: string;  // filled when old turns are compacted
}
```

Persistence: `StateManager.writeRaw("chat/sessions/<id>.json")`. No new storage mechanism — StateManager already handles arbitrary JSON.

**Persist-before-execute principle (from Claude Code):** The user message is written to disk *before* calling `adapter.execute()`. If the process is killed mid-execution, the session can be resumed from the last user message. Assistant responses are persisted after completion. This ordering guarantee ensures crash-safe session recovery.

```python-like pseudocode:
await history.appendUserMessage(msg)   # persist FIRST
result = await adapter.execute(task)    # then execute
history.appendAssistantMessage(result)  # persist result (fire-and-forget ok)
```

**Compaction with boundary marker (from Claude Code):** When `messages.length * avg_tokens > token_budget * 0.8`, the oldest half of messages is summarized via a single LLM call. The summary is stored in `compactionSummary` and acts as a **compact boundary** — on subsequent turns, only the summary plus post-boundary messages are sent to the adapter. This mirrors CC's `compact_boundary` marker pattern: messages before the boundary are discarded from the prompt, replaced by the summary prefix. Recent turns (last N messages) are always kept verbatim. Compaction is transparent to the user and logged at debug level.

### 5.3 Escalation Handler (`src/chat/escalation.ts`)

Handles `/track`, which promotes the session to Tier 2.

**`/track` → Tier 2**

```
1. Pass full ChatHistory to LLM → auto-generate Goal definition
2. GoalNegotiator.negotiate(goal) → feasibility + threshold refinement
3. StateManager.saveGoal(goal)
4. CoreLoop.start(goalId) — GoalRefiner determines tree decomposition automatically
5. Print confirmation: "Tracking goal: <title>"
```

The command passes conversation history to the LLM as the primary source for goal generation. The user's own words become the goal description — no separate re-statement required.

### 5.4 CLI Entry Point (`src/cli/commands/chat.ts`)

Parses `pulseed chat [task]` and delegates to ChatRunner.

- If `task` argument is present: non-interactive, single turn
<<<<<<< HEAD
- If `task` is absent: open interactive REPL backed by TUI chat component (`src/interface/tui/chat.tsx` — no changes needed)
=======
- If `task` is absent: open interactive REPL backed by the TUI chat component (`src/interface/tui/chat.tsx`)
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
- Flags: `--adapter <name>`, `--resume [id]` (Phase 2), `--timeout <ms>`

### 5.5 Context Provider Extension (`src/observation/context-provider.ts`)

A thin `buildChatContext()` addition (~10 lines):

```typescript
function buildChatContext(taskDescription: string, cwd: string): ContextSnapshot {
  return {
    workingDirectory: cwd,
    gitRoot: resolveGitRoot(cwd),
    taskDescription,
    sessionType: "chat_execution",
  };
}
```

No changes to existing `buildContext()` or other context assembly paths.

### 5.6 SessionManager Extension (`src/types/session.ts`)

Add `"chat_execution"` to `SessionTypeEnum`. This is a 1-line change. Chat sessions are tracked in StateManager alongside existing session types, with no behavioral difference at the SessionManager level.

---

## 6. Escalation Mechanism

### Design Principle

Escalation is a one-way promotion. Tier 2/3 state created by escalation is fully independent from the chat session — it does not depend on the session remaining active. The user can close the terminal after `/track` and the observation loop continues in the background.

### Goal Generation from Conversation History

When `/track` is issued, the LLM receives:

```
System: You are generating a PulSeed goal from a conversation.
        Extract: goal title, description, success dimensions, acceptance thresholds.

User conversation:
<ChatHistory.messages serialized>

Latest task context: <last user message>
```

The LLM returns a structured Goal object. GoalNegotiator then runs its standard feasibility and threshold-refinement pipeline on this object. The result is saved to StateManager.

This reuses the entire existing GoalNegotiator flow without modification. Chat mode provides a new input source (conversation history) rather than a new negotiation path.

### Single Escalation Command

There is only one escalation command: `/track`. Tree decomposition depth is determined automatically by GoalRefiner — simple goals run as a shallow observation loop, complex goals get full tree decomposition. The user does not need to choose.

---

## 7. Session Scoping

Chat sessions are scoped to the git root of the current working directory.

- `resolveGitRoot(cwd)` walks up from `cwd` until it finds `.git/`
- If no git root found, falls back to `cwd` itself
- When the user switches to a directory with a different git root, a new session begins automatically (in interactive mode, a notice is shown)

This ensures that workspace context (file structure, recent git activity) is always relevant to the session. Conversations about one project do not bleed into another.

Session IDs are deterministic within a session start event. Resuming requires `--resume [id]` (Phase 2). In Phase 1, each `pulseed chat` invocation starts fresh.

---

## 8. Reference System Patterns

### Patterns from Claude Code

Four patterns from the Claude Code (CC) source inform this design:

| Pattern | CC Source | Application in PulSeed |
|---------|-----------|----------------------|
| Slash command interception before API dispatch | `processUserInput.ts` | `/track`, `/help`, `/clear` handled in ChatRunner before `adapter.execute()` |
| Persist user message before execution | `QueryEngine.ts` | `await history.append()` before `adapter.execute()` — crash-safe recovery |
| Compact boundary marker | `query.ts` | `compactionSummary` field + slice from boundary |
| Permission as DI async function | `permissions.ts` | Already matched by existing `approvalFn` pattern — no change needed |

Patterns intentionally not adopted:
- **JSONL append log** — adds complexity; single JSON file per session is sufficient for Phase 1
- **Microcompact** (trim oversized tool results without LLM) — optimization deferred until needed

### Context Compaction (from Codex CLI)

When conversation history grows large, older turns are summarized rather than truncated. Truncation loses information; summarization preserves it in compressed form.

Compaction trigger: total estimated token count of `messages` exceeds 80% of the configured `chat_context_budget` (default: 32K tokens).

Compaction process:
1. Split `messages` at the midpoint
2. Summarize the older half via a single LLM call
3. Store the summary in `compactionSummary`
4. Replace the older half with a single synthetic `assistant` message containing the summary
5. Keep the recent half verbatim

The compaction is invisible to the user during normal flow. It is logged at debug level.

### Session Persistence and Resume (from OpenClaw + Codex CLI)

Chat sessions are written to disk after every turn. If the process crashes or the user closes the terminal, the session can be resumed.

Storage path: `~/.pulseed/chat/sessions/<id>.json`

Resume: `pulseed chat --resume` loads the most recent session for the current git root. `pulseed chat --resume <id>` loads a specific session.

Auto-expiry: sessions not accessed in 7 days (configurable via `chat_session_ttl_days`) are deleted on the next `pulseed chat` invocation. This is a simple mtime check on the session file.

### Timeout and Output Caps (from Codex CLI)

Agent execution in chat mode has configurable limits to prevent runaway tasks:

| Parameter | Default | Config key |
|-----------|---------|------------|
| Execution timeout | 120s | `chat_timeout_ms` |
| Output size cap | 32KB | `chat_output_cap_bytes` |

When the timeout is exceeded, the adapter call is cancelled and the user sees a timeout message. The partial output (if any) is shown and appended to history. The session remains active for the next turn.

### Directory Scoping (from OpenClaw)

Switching directories mid-session produces a new session context. In interactive mode, if the user's `cwd` changes between turns (detectable via shell integration or explicit `cd` command detection), ChatRunner emits a notice and starts a new session:

```
[chat] Working directory changed → new session started (previous: /path/to/old)
```

This prevents context confusion when a user switches between repositories.

---

## 9. Implementation Phases

### Phase 1a — Non-interactive Execution

Deliverable: `pulseed chat "task"` works end-to-end.

Files:
- `src/chat/chat-runner.ts` — ChatRunner core
- `src/chat/chat-history.ts` — ChatMessage type + in-memory history
- `src/cli/commands/chat.ts` — CLI entry point (non-interactive path only)
- `src/cli-runner.ts` — add `case "chat"` (3 lines)
- `src/types/session.ts` — add `"chat_execution"` (1 line)
- `src/observation/context-provider.ts` — add `buildChatContext()` (~10 lines)

No escalation, no persistence, no TUI. Verify: single-turn execution returns output.

### Phase 1b — Interactive REPL

Deliverable: `pulseed chat` opens an interactive loop.

Files:
- `src/interface/cli/commands/chat.ts` — add interactive path, integrate `src/interface/tui/chat.tsx`
- Built-in commands: `/help`, `/clear`, `/exit`

No escalation yet. Verify: multi-turn conversation with history accumulation.

### Phase 1c — Manual Escalation

Deliverable: `/track` promotes the session to Tier 2.

Files:
- `src/chat/escalation.ts` — Escalation handler

Verify: `/track` creates a Goal and starts CoreLoop; GoalRefiner determines tree decomposition automatically.

### Phase 2 — Session Persistence and Resume

Deliverable: sessions survive process exit; `--resume` reloads them.

Files:
- `src/chat/chat-history.ts` — add `persist()`, `load()`, auto-expiry
- `src/cli/commands/chat.ts` — add `--resume [id]` flag handling
- `src/chat/chat-runner.ts` — add compaction logic

Verify: kill process mid-session, resume, conversation history intact.

### Phase 3 — Auto-escalation Proposals

Deliverable: PulSeed proactively suggests escalation when a task pattern warrants it.

After each turn, a lightweight classifier checks:
- Has the user issued the same class of task 3+ times?
- Did the task require multi-step work that spans turns?
- Did the user express dissatisfaction with a result?

If triggered, PulSeed asks: _"This looks like something worth tracking. Should I set up a monitoring goal? (`/track` to confirm)"_

The user can ignore the suggestion. No automatic escalation.

---

## 10. File Changes Summary

| Change | File | Size |
|--------|------|------|
| NEW | `src/chat/chat-runner.ts` | ~150 lines |
| NEW | `src/chat/chat-history.ts` | ~80 lines |
| NEW | `src/chat/escalation.ts` | ~100 lines |
| NEW | `src/cli/commands/chat.ts` | ~60 lines |
| EDIT | `src/cli-runner.ts` | +3 lines |
| EDIT | `src/types/session.ts` | +1 line |
| EDIT | `src/observation/context-provider.ts` | +~10 lines |

No changes to: adapters, adapter-registry, llm-client, TUI components, GoalNegotiator, CoreLoop, StateManager.

New test files (Phase 1):
- `tests/chat/chat-runner.test.ts`
- `tests/chat/chat-history.test.ts`
- `tests/chat/escalation.test.ts`

---

## Summary of Design Principles

| Principle | Concrete decision |
|-----------|------------------|
| Unified entry | All tasks start as Tier 1; Tier 2 is a promotion, not a separate mode |
| Single escalation command | `/track` is the only escalation command; tree decomposition depth is auto-determined by GoalRefiner |
| TaskLifecycle bypass | Chat tasks call `adapter.execute()` directly — no fabricated goal state |
| Adapter unchanged | `IAdapter.execute(AgentTask)` is the right interface as-is |
| Conversation → Goal | Escalation derives the Goal from conversation history, not a separate prompt |
| Files carry memory | Chat history uses `StateManager.writeRaw()` — no new persistence mechanism |
| Progressive complexity | Phase 1 is ~400 lines. Persistence and auto-escalation are additive, not redesigns |
