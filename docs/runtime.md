# PulSeed --- Runtime Infrastructure

> The foundational design for "running" the task discovery engine (mechanism.md).
> While mechanism.md defines "what PulSeed thinks about," this document defines "how PulSeed runs."

---

## 1. Orchestration --- How to Execute Discovered Tasks

The output of the task discovery engine is "what should be done next." Executing those tasks, collecting results, and passing them to the next loop — this is the responsibility of the orchestration layer.

The task discovery engine decides WHAT. The orchestration layer handles HOW. This separation is intentional. Mixing "what should be done" with "how to control execution" leaves both incomplete.

### Session Management

A session is the smallest unit of execution. One task, one session. Sessions are stateless: they receive the information they need at startup and return results at completion. That's it.

PulSeed has full control over the session lifecycle.

- **Launch**: Start the session by passing the task's scope, success criteria, and constraints. The session doesn't need to know the overall goal. It only needs to know its own task.
- **Monitoring**: Track the session's progress. Detect timeouts, abnormal terminations, and resource exhaustion.
- **Termination**: Success criteria met, timeout reached, or stall detected. Terminate the session under whichever condition applies.

When a session ends, PulSeed's state is not lost. All state is written to persistent files. Sessions are disposable workspaces; PulSeed's memory lives outside sessions.

Execution means are abstracted through adapters. Various AI agents (Claude Code CLI, Claude API, OpenAI Codex CLI, etc.), API calls, human requests. The most suitable execution means is chosen based on the nature of the task. The orchestration layer does not depend on the type of adapter.

### Result Verification

PulSeed does not trust an executor's self-report. This is not suspicion — it is a structural design decision.

Performing execution and verification in the same session makes self-evaluation bias unavoidable. The structure of "evaluating your own work" tends toward optimism in humans and AI alike. That's why execution and verification are structurally separated.

Verification is performed in three layers.

**Mechanical verification**: Test results, file existence, build success, API response status codes. Evidence that cannot lie. This is the most trustworthy.

**Independent review session**: A separate session (different context) from execution evaluates the deliverable. Precisely because it doesn't share the execution context, it can render an unbiased judgment. Task-level verification checks whether the deliverable meets the task's success criteria; goal-level verification looks for oversights and inconsistencies from the perspective of the overall goal.

**Executor self-report**: A report of what was done, what could be done, and what couldn't. Treated as reference information only. Completion is never judged solely on self-report.

By combining these three layers of verification, each observation is assigned a confidence level. Confidence is fed directly into gap recognition in mechanism.md. "Completion" based on low-confidence observations generates additional verification tasks.

### Failure Handling

Tasks fail. Verification can result in rejection. The problem is not failure itself, but how to deal with it.

**keep**: When partial results are moving in the direction of the goal. Retain the results and generate the remaining portion as a new task. For example, if 7 out of 10 are complete, retain those 7 and make the remaining 3 the next task.

**discard**: When the direction itself is wrong. Discard the results and regenerate the task with a different approach. To avoid hitting the same wall repeatedly, information about the failed approach is passed to the next task generation.

**escalate**: When the same kind of failure repeats. Determined to be a problem that cannot be resolved through PulSeed's autonomous handling, and human intervention is requested. "No matter how many times we try, it doesn't work" suggests either a capability limit or a flawed premise.

The judgment criteria are simple: if results are heading in the goal direction, keep. If the direction is wrong, discard. If failure repeats, escalate.

### Scope Control

Each session receives a strictly scoped task. "Do everything" is never passed.

There are three reasons to narrow scope.

First, to prevent context pollution. Packing multiple tasks into one session causes interference between tasks, degrading the quality of both.

Second, verification becomes easier. The clearer the question "was this task completed?", the more accurate the verification. Vague scope only allows for vague verification.

Third, the blast radius of failure is limited. If one session fails, other tasks are unaffected. Keep the blast radius small.

Note that tasks of category `knowledge_acquisition` are scoped even more strictly than regular tasks. They are read-only execution units that only gather information, and are not permitted to modify state, write to files, or perform operations with side effects on external services.

### Portfolio Orchestration

When tracking multiple goals simultaneously, `PortfolioManager` sits between task discovery and task execution.

`DriveScorer` calculates drive scores (dissatisfaction, deadline, opportunity) per dimension for each goal, and those scores are received by `PortfolioManager`. `PortfolioManager` determines resource allocation and prioritization across goals and passes the combination of goals and strategies to execute to `TaskLifecycle`. This allows parallel management of multiple goals while passing through the same core loop code path as a single-goal loop.

`PortfolioManager` also handles automatic rebalancing across goals. If a goal's drive score spikes sharply (e.g., a deadline is imminent, an obstacle has occurred), it dynamically adjusts resource allocation to other goals.

---

## 2. Process Model --- How to Start and Keep Running

PulSeed's orchestration loop itself is a pure function. A single processing unit that cycles through "observe → gap → scoring → task discovery → execute → verify." The question of the process model is "who calls this function and when."

The startup method changes by phase, but the core loop does not. CLI, daemon, and cron are all merely thin wrappers that call this core loop.

```
CLI wrapper   ─┐
TUI wrapper   ─┤→  Core loop (observe→gap→score→task→execute→verify)
Daemon        ─┤
cron wrapper  ─┘
```

### MVP (Phase 1): CLI Mode

**`pulseed run`** executes one core loop, reports the results, and exits.

- User runs manually (or external cron runs periodically)
- Start → 1 loop completes → display results in terminal → exit
- State is written to persistent files, so the next `pulseed run` can continue
- No infrastructure needed. Only dependency is the core loop

```
$ pulseed run
Observing... [dog health management]
Gap detected: meal log not updated for 3 days
Task executed: please update the log
Done. Recommended next check: 1 day from now
```

In MVP, "scheduling" is the user's (or system cron's) responsibility. PulSeed doesn't manage schedules. It runs when called. That's it.

### Phase 1b: TUI Mode

**`pulseed tui`** launches an Ink-based terminal UI, allowing interactive control of the core loop while viewing a dashboard.

- Entry point is `src/tui/entry.ts` (`startTUI()`)
- Dependencies chain: `entry.ts` → `App` (`app.tsx`) → `useLoop` hook (`use-loop.ts`) → `CoreLoop`
- Loop startup, stop, and configuration changes are all managed internally by the `useLoop` hook, tied to the React component lifecycle
- The core loop itself requires no changes. TUI uses the same `CoreLoop` instance as the CLI
- Users approve/reject tasks via the approval overlay (`ApprovalOverlay`) on screen. Approval decisions are returned to `TaskLifecycle`'s `approvalFn` via a Promise (same interface as the CLI version's readline reading)

```
src/tui/
├── entry.ts              — DI wiring + Ink render (startTUI() entry point)
├── app.tsx               — Root component, view switching
├── use-loop.ts           — LoopState management, CoreLoop start/stop (custom hook)
├── dashboard.tsx         — Goal and dimension progress display
├── chat.tsx              — Chat interface
├── approval-overlay.tsx  — Task approval UI (via CoreLoop→TaskLifecycle→approvalFn)
├── help-overlay.tsx      — Help display
├── report-view.tsx       — Report display
├── actions.ts            — TUI action definitions (command parsing and execution)
├── intent-recognizer.ts  — User input intent recognition
├── markdown-renderer.ts  — Markdown rendering
└── types/                — TUI-specific type definitions
```

```
pulseed tui
  ↓
entry.ts (DI wiring + Ink render)
  ↓
App (app.tsx)
  ├── useLoop (use-loop.ts): LoopState management, CoreLoop start/stop
  ├── Dashboard (dashboard.tsx): Goal and dimension progress display
  ├── Chat (chat.tsx): Chat interface (via IntentRecognizer)
  ├── ApprovalOverlay (approval-overlay.tsx): Task approval UI
  ├── HelpOverlay (help-overlay.tsx): Help display
  └── ReportView (report-view.tsx): Report display
```

TUI is not a replacement for CLI mode but a complement to it. The loop execution unit is identical; only "how to view and operate" differs.

### Phase 2a: Built-in Scheduler (Daemon Mode)

**`pulseed start`** launches a daemon that automatically executes the core loop at configured intervals. **`pulseed stop`** stops it.

- The daemon is internally just a wrapper that repeatedly calls the core loop
- The core loop itself requires no changes. The cost of daemonization is small
- Execution interval can be configured per goal (see drive-system.md scheduling design)
- Process management (PID file, logs) is handled by the daemon layer

### Phase 2b: cron Entry Generation

**`pulseed cron`** outputs a crontab entry the user can add to their shell.

```
$ pulseed cron
# crontab entry for running PulSeed hourly:
0 * * * * /usr/local/bin/pulseed run >> ~/.pulseed/logs/cron.log 2>&1
```

Phase 2b is an alternative to Phase 2a, an option for users who "don't want to keep a daemon running." Whichever is used, the same core loop is executed.

### Design Principles

- The core loop is implemented as a pure function. No dependency on global state
- CLI is implemented first. Daemon/cron are thin wrappers added afterward
- Whether the decision of "when to run" stays with the user (MVP) or is delegated to PulSeed (Phase 2) is the user's choice

---

## 3. Drive Method --- When and at What Timing to Run

When should the task discovery loop be executed? Running it continuously is wasteful, and running it only on a fixed schedule is insufficient.

### Drive Decision

The core of PulSeed's drive method boils down to one question: **"Is there a goal that needs attention right now?"**

At each potential activation timing, PulSeed answers this question. If the answer is yes, it runs the task discovery loop. If no, it does nothing. This judgment itself must be lightweight. Check the state of each goal and see only whether attention is needed. Deep analysis happens inside the loop.

"Do nothing" is a normal state. When all goals are progressing well, or when intentionally waiting, PulSeed stays quiet. Not running unnecessary loops is itself a smart use of resources.

### Goal-Driven Scheduling

Execution timing follows the nature of the goal. Not a fixed heartbeat.

**Emergency-response goals**: Event-driven is primary, periodic checking is supplementary. Run the loop immediately upon detecting a state change. Periodic checking runs at low frequency as a safety net to prevent "misses."

**Deadline-bound goals**: The distance to the deadline determines execution frequency. While the deadline is far, low-frequency periodic checking is sufficient. As the deadline approaches, the check frequency increases. This is tied to the deadline-driven score in mechanism.md. Goals with higher scores receive attention more frequently.

**Continuous goals**: Low-frequency periodic checks are the baseline. Frequency is raised only when an anomaly is detected. Quietly monitoring normally, reacting immediately when a problem occurs.

When a single PulSeed instance has multiple goals, each goal has its own drive rhythm. The most frequently driven goal determines how often PulSeed activates, but not every goal is checked at every activation. Only goals that need attention have the loop run for them.

### Active and Waiting

PulSeed is not always active. It recognizes situations where "waiting" is the correct judgment.

Immediately after launching an initiative. It takes time for effects to appear. Measuring immediately is meaningless. Decide to "measure N days later" and in the meantime attend to other goals or wait quietly.

When there are external dependencies. Waiting for others' approval, waiting for external service responses, waiting for market reactions. There are timings that PulSeed cannot control. Being able to wait when it's time to wait is equivalent to not taking unnecessary actions.

However, "waiting" is not "forgetting." Goals that are waiting also have their state confirmed periodically. Because the situation may have changed while waiting.

### Types of Activation Triggers

There are 4 types of triggers that activate PulSeed.

**Scheduled activation**: Periodic checks based on the nature of the goal. The most fundamental drive method.

**Event activation**: Change notifications from outside. A data source value exceeded a threshold, a message came from the user, a notification came from an external service. There's no reason to wait when a change occurs.

**Completion activation**: A task completed. Collect the result, update state, discover the next task. Task completion is a natural starting point for the loop.

**Deadline activation**: A deadline is approaching. Separately from periodic checks, the approach of a deadline itself becomes a trigger. When less than one week remains until a deadline, an additional check runs separately from the regular periodic check.

These triggers are not exclusive. Multiple triggers can fire simultaneously. PulSeed records "why it was activated" and processes the most urgent goal first.

---

## 4. Context Management --- Handling Long-Term Goals with a Finite Context

An LLM's context window is finite. The goals PulSeed pursues span months to years. How is this contradiction resolved?

The answer is simple. **Most information lives outside the context window.**

### Controlling Session Boundaries

PulSeed controls the start and end of sessions. This is the key to solving the context problem.

The node boundaries of the goal tree become natural session boundaries. One sub-goal, one task corresponds to one session. When a session ends, the results are collected and the context is reset. The next session starts from a blank slate.

The concept of "continuing from the previous session" doesn't exist. Each session is an independent execution unit. The information needed is explicitly passed at session start. It doesn't depend on memory from the previous session.

### Context Assembly

> For the specific algorithm for context selection (priority-based inclusion rules, exclusion rules per session type, MVP's fixed top-4 method), see `design/session-and-context.md` §4. This section describes only the overview.

When launching a session, PulSeed assembles and passes only the information that session needs.

What is passed to task execution sessions:
- Task definition and success criteria
- Relevant constraints
- Previous attempt results (in case of retry)
- Minimum context needed for the task

What is not passed:
- The entire goal history
- Information about unrelated goals
- Everything PulSeed knows

What is passed to verification sessions:
- The task's success criteria
- Means to access the deliverable
- Reference criteria needed for verification

What is not passed:
- The execution session's context (to avoid bias)
- The executor's self-report (to ensure independent judgment)

What is passed to observation sessions:
- Goal definition and success criteria
- Information sources to observe
- Previous observation results (for change detection)

This "minimum necessary context assembly" is how long-term goals are handled with a finite context window. There's no need to remember everything. Only what's needed in this moment needs to be known.

### State Handoff Between Sessions

Sessions are stateless. Then how is consistency maintained across sessions?

Persistent files. All state is written to persistent files.

When a session ends, PulSeed extracts the results and updates the state file. When the next session begins, PulSeed reads the relevant information from the state file and assembles the context for the new session.

When session A's results affect session B, that effect is conveyed through the state file. Session A never directly passes anything to session B. All information flows through persistent files as the relay point.

This design has the side benefit of transparency. State files are human-readable. They can be managed with git. What PulSeed knows and what it bases its decisions on can be confirmed at any time.

### Context Isolation for Multiple Goals

When PulSeed is pursuing multiple goals simultaneously, the context for each goal is completely isolated.

Session A's execution session contains no information about goal B. Session A's failure doesn't affect goal B's judgment either (because they are isolated at the state file level).

This is not mere housekeeping. It's prevention of context pollution. It structurally prevents information obtained in one goal's context from biasing judgments about an unrelated goal.

However, when there are dependencies between goals, exceptions apply. When goal A's results are a prerequisite for goal B, that dependency is explicitly managed by PulSeed, and only the necessary information is included in goal B's context.

### Memory Hierarchy

PulSeed's information is divided into three layers.

**Working Memory**: The context window of the current session. Capacity is limited but processing speed is fast. Only information needed for the task at this moment is here.

**Goal State**: The goal tree, state vectors, and progress records saved in persistent files. Maintains consistency across sessions. Loaded into the session's working memory as needed. This is PulSeed's "medium-term memory."

**Experience Log**: Records of state → action → result. The data that serves as the foundation for learning. Recent raw logs are kept as Short-term Memory in `~/.pulseed/memory/short-term/`, and when they exceed the retention period, they are compressed into patterns and lessons in Long-term Memory (`~/.pulseed/memory/long-term/`) via LLM summarization. Long-term lessons can be referenced across goals and are selectively injected into Working Memory as priority 6 in `session-and-context.md` §4. Therefore, "not referenced in individual sessions" applies only to raw logs (Short-term raw JSON); compressed lessons do enter session context. See `design/memory-lifecycle.md` for details.

The key point of this hierarchy is that most information lives outside the context window. The context window is a window that holds only "what's needed right now" — it is not the place to store all of PulSeed's knowledge.

### Memory Lifecycle

`design/memory-lifecycle.md` defines the specific implementation of the 3-layer memory model.

```
~/.pulseed/memory/
├── short-term/
│   └── goals/<goal_id>/
│       ├── experience-log.json   # Experience log (raw JSON)
│       ├── observations.json     # Observation history
│       ├── strategies.json       # Strategy history
│       └── tasks.json            # Task history
├── long-term/
│   ├── lessons/
│   │   ├── by-goal/<goal_id>.json       # Per-goal lessons
│   │   ├── by-dimension/<name>.json     # Per-dimension lessons
│   │   └── global.json                  # Cross-goal lessons
│   └── statistics/<goal_id>.json        # Per-goal statistics
└── archive/<goal_id>/            # Archive for completed/cancelled goals
```

Short-term raw data is compressed into Long-term lesson entries via LLM summarization when it exceeds a configurable retention loop count (default: 50–200 loops depending on goal type). Long-term lessons are retained indefinitely after goal completion and are used to improve the quality of future strategy selection and task generation. Retention of failure patterns takes priority over success patterns, so as not to repeat the same mistakes.

---

## Overview

The four areas are not independent — they work together.

```
Process Model (CLI / TUI / Daemon / cron)
  Core loop startup wrapper
    │
    │ Launch
    ↓
Drive Method
  "Is there a goal that needs attention right now?"
    │
    │ Yes
    ↓
Task Discovery Engine (mechanism.md)
  Observe → Gap recognition → Strategy selection → Task concretization
    │
    │ Task determined
    ↓
Orchestration
  Session launch → Execute → Verify → Collect results
    │
    │ Results obtained
    ↓
Context Management
  Write results to state file → Assemble context for next session
    │
    │ State updated
    ↓
Return to Drive Method
```

The process model defines "how it's started," the drive method decides "when it runs," the task discovery engine decides "what to do," orchestration controls "how to execute," and context management organizes "what to remember."

This infrastructure is built by PulSeed itself. Precisely because existing tools are insufficient, PulSeed itself needs this foundation. So that the task discovery engine — its brain — can operate stably over the long term, for multiple goals.
