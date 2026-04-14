# `/tend` — Chat-to-CoreLoop Handoff Command

> Current implementation note: chat/TUI are now built on a stronger native AgentLoop path, and daemon/runtime ownership has evolved since this document was written. Treat `/tend` here as a handoff pattern from bounded chat execution into long-lived goal control, not as a precise wire-level description of the current UI/runtime code.

## 1. Overview

`/tend` is a slash command within PulSeed's chat/TUI mode that transitions a conversational context into autonomous CoreLoop execution via the daemon.

**Metaphor**: "Tend to this goal" — let PulSeed autonomously nurture a goal, like a gardener tending seedlings.

**Flow**:
```
User chats in TUI
  → types "/tend"
  → PulSeed summarizes chat history via LLM
  → Auto-generates a Goal from the summary
  → "テストカバレッジ90%達成 で開始します。いいですか？"
  → User approves
  → Daemon starts CoreLoop for the goal (background)
  → Chat remains interactive — not blocked
  → Progress notifications flow into chat:
      🌱 [tend] goal-abc: Iteration 3/10 — gap 0.72→0.45
      ✅ [tend] goal-abc: Complete! Gap: 0.03
```

## 2. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Execution model | Daemon (background) | Chat must not block; user continues interacting |
| Goal creation | Auto-generate from chat | No goal-id required; `/tend` works from conversation context |
| Progress display | Notification messages in chat | Lightweight; no TUI refactoring; natural UX |
| Interruption | `/stop` or daemon stop | No Ctrl+C ambiguity with TUI exit |
| Context transfer | Chat summary → Goal description | LLM summarizes chat → feeds into GoalNegotiator |

## 3. Command Syntax

```
/tend                     Auto-generate goal from chat context, start daemon
/tend <goal-id>           Tend an existing goal (skip generation)
/tend --max <N>           Limit to N iterations
```

## 4. Detailed Flow

### Step 1: Chat Summary
When user types `/tend`, extract recent chat history and summarize via LLM:
```
Input: last N messages from ChatHistory
LLM prompt: "Summarize what the user wants to achieve. Extract concrete, measurable objectives."
Output: { summary: string, objectives: string[] }
```

### Step 2: Goal Generation
Pass the summary to GoalNegotiator (or GoalRefiner) to create a structured goal:
```typescript
const goal = await goalNegotiator.negotiate({
  description: summary,
  context: { source: "tend", chatSessionId }
});
```

### Step 3: Confirmation
Display the generated goal to the user:
```
🌱 Tend to this goal?

  Title: Achieve 90% test coverage
  Dimensions:
    - test_coverage: min 0.90
    - failing_tests: max 0
  
  Estimated iterations: ~5-10

  [Y/n]
```

If user declines, return to chat. User can refine via conversation and retry `/tend`.

### Step 4: Daemon Launch
Start CoreLoop for the goal as a daemon process:
```typescript
// Reuse existing daemon infrastructure
await daemonClient.start({ goalId: goal.id, maxIterations });
```

This is equivalent to `pulseed start --goal <id>` but triggered from within chat.

### Step 5: Progress Notifications
The TUI subscribes to the daemon's EventServer (SSE stream) and renders progress events as system messages in the chat:

```
🌱 [tend] goal-abc: Started — "Achieve 90% test coverage"
🌱 [tend] goal-abc: [1/10] Observing... gap: 0.72
🌱 [tend] goal-abc: [1/10] Executing: "Run test suite"
🌱 [tend] goal-abc: [2/10] gap: 0.72 → 0.55
⚠️ [tend] goal-abc: Stalled — "no coverage improvement after 3 attempts"
✅ [tend] goal-abc: Complete! gap: 0.03, 4 iterations
```

**Notification granularity** (configurable):
- `verbose`: every phase of every iteration
- `normal` (default): iteration summary + stall/complete
- `quiet`: only stall/complete

### Step 6: Return to Chat
After daemon completes (or stalls/stops), a final summary message appears in chat.
The summary is added to ChatHistory so subsequent LLM calls have context:

```
── tend complete ──────────────────
Goal: Achieve 90% test coverage
Status: completed
Iterations: 4/10
Gap: 0.72 → 0.03
Tasks executed:
  1. Run test suite and check coverage
  2. Add missing unit tests for auth module
  3. Fix failing edge case in token refresh
  4. Re-run tests — all passing
───────────────────────────────────
```

## 5. Relationship to Existing Commands

| Command | Purpose | Execution |
|---------|---------|-----------|
| `pulseed run --goal <id>` | CLI one-shot CoreLoop | Foreground, blocking |
| `pulseed start --goal <id>` | Start daemon | Background, no chat |
| `/tend` | Chat→daemon handoff | Background, with chat notifications |
| `pulseed improve` | Analyze + suggest + optionally run | Foreground, blocking |

`/tend` is essentially a chat-integrated wrapper around `pulseed start` with:
1. Goal auto-generation from chat context
2. Progress notifications piped back into chat
3. Context continuity (summary in chat history)

## 6. Architecture

```
┌─────────────────────────────────────────┐
│  TUI / Chat Mode                        │
│  ┌───────────────────────────────────┐  │
│  │  ChatRunner                       │  │
│  │  - handleCommand("/tend")         │  │
│  │  - calls TendCommand.execute()    │  │
│  └──────────┬────────────────────────┘  │
│             │                           │
│  ┌──────────▼────────────────────────┐  │
│  │  TendCommand                      │  │
│  │  1. summarizeChat(history)        │  │
│  │  2. generateGoal(summary)         │  │
│  │  3. confirmWithUser()             │  │
│  │  4. daemonClient.start(goalId)    │  │
│  │  5. subscribe to EventServer      │  │
│  └──────────┬────────────────────────┘  │
│             │                           │
│  ┌──────────▼────────────────────────┐  │
│  │  EventSubscriber                  │  │
│  │  - SSE from daemon EventServer    │  │
│  │  - renders notifications in chat  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
          │ daemon start
          ▼
┌─────────────────────────────────────────┐
│  Daemon Process                         │
│  ┌───────────────────────────────────┐  │
│  │  CoreLoop.run(goalId)             │  │
│  │  observe→gap→score→task→execute   │  │
│  └──────────┬────────────────────────┘  │
│             │ emits                     │
│  ┌──────────▼────────────────────────┐  │
│  │  EventServer (SSE)                │  │
│  │  - ProgressEvent stream           │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## 7. Implementation Plan

### Phase 1: Core `/tend` command

| File | Action | Lines |
|------|--------|-------|
| `src/interface/chat/tend-command.ts` | **New** — TendCommand class (summarize, generate goal, confirm, start daemon, subscribe) | ~150 |
| `src/interface/chat/__tests__/tend-command.test.ts` | **New** — unit tests | ~200 |
| `src/interface/chat/chat-runner.ts` | **Modify** — add `/tend` to handleCommand(), add TendCommand to deps | ~15 |
| TUI chat entry wiring | **Modify** — wire TendCommand deps | ~10 |
| `src/interface/chat/event-subscriber.ts` | **New** — SSE client that subscribes to daemon EventServer, emits typed events | ~80 |
| `src/interface/chat/__tests__/event-subscriber.test.ts` | **New** — unit tests | ~100 |

**Total**: 4 new files, 2 modified files (~555 lines)

### Phase 2: TUI integration (future)

- Live progress panel in TUI sidebar
- `/tend status` subcommand
- Notification granularity config (`/tend --quiet`)
- Multi-goal tending (`/tend goal-a goal-b`)

## 8. Dependencies

- **Existing**: ChatRunner, DaemonClient, EventServer, GoalNegotiator, StateManager, LLMClient
- **New npm**: none (SSE client uses native `fetch` with ReadableStream)

## 9. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Daemon already running for goal | Show status, ask if user wants to restart |
| Daemon not installed/available | Fall back to in-process CoreLoop (blocking, with warning) |
| No chat history (empty `/tend`) | Ask user to describe what they want first |
| Goal generation fails (LLM error) | Show error, suggest manual goal creation |
| EventServer unreachable | Degrade gracefully — no notifications, suggest `pulseed status` |
| User types `/tend` then `/tend` again | Second tend creates a new goal + daemon (parallel tending) |
