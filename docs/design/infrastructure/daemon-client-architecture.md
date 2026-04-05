# Daemon-Client Architecture

**Status:** Design
**Author:** Auto-generated
**Date:** 2026-04-05

## Overview

PulSeed's TUI currently creates its own CoreLoop inline — closing the TUI kills the loop. This design makes the daemon the single owner of CoreLoop execution, with TUI (and future Web UI, Telegram) as disposable clients that connect via SSE + REST.

## Architecture

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   TUI (Ink)  │   │  Web UI     │   │  Telegram   │
│   client     │   │  client     │   │  client     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────── SSE + REST ─────────────────┘
                          │
              ┌───────────▼───────────┐
              │   Daemon Process       │
              │   ┌─────────────────┐ │
              │   │ EventServer     │ │
              │   │ :41700          │ │
              │   ├─────────────────┤ │
              │   │ CoreLoop(s)     │ │
              │   │ per-goal        │ │
              │   ├─────────────────┤ │
              │   │ ApprovalQueue   │ │
              │   │ pending→client  │ │
              │   └─────────────────┘ │
              │   ~/.pulseed/ (state) │
              └───────────────────────┘
```

## Protocol: SSE for push, REST for commands

**Why SSE over WebSocket:**
- Daemon→client is one-directional push (state changes, approval requests, log lines)
- Client→daemon commands are request/response (start goal, approve, chat) — REST is natural
- SSE reconnects automatically (built into EventSource API and trivial to implement server-side)
- No additional dependencies — Node.js `http` module suffices

## Event Types (SSE)

| Event | Data | When |
|-------|------|------|
| `iteration_complete` | `{ goalId, iteration, gapScore, driveScore }` | After each CoreLoop iteration |
| `goal_updated` | `{ goalId, status, progress }` | Goal state changes |
| `approval_required` | `{ requestId, goalId, task, description }` | Daemon needs human approval |
| `approval_resolved` | `{ requestId, approved }` | Approval answered |
| `chat_response` | `{ goalId, message }` | Response to chat command |
| `daemon_status` | `{ status, activeGoals[], uptime }` | Periodic heartbeat (every 30s) |
| `error` | `{ goalId?, message, code }` | Errors during execution |

## REST API Endpoints (EventServer extension)

### Existing (unchanged)
- `GET /health` — daemon health check
- `POST /events` — external event injection
- `POST /triggers` — trigger evaluation
- `GET /goals` — list all goals
- `GET /goals/:id` — get single goal

### New: Streaming
- `GET /stream` — SSE event stream. Supports `Last-Event-ID` for reconnection. Each event has an incrementing ID.

### New: Control
- `POST /goals/:id/start` — start running a goal
- `POST /goals/:id/stop` — stop running a goal
- `POST /goals/:id/approve` — `{ requestId, approved: boolean }` — respond to approval request
- `POST /goals/:id/chat` — `{ message: string }` — send chat message for goal context
- `GET /daemon/status` — daemon state (active goals, uptime, PID)

## Approval Bridge

Current state: `approvalFn` is a closure wired in `entry.ts` that creates a Promise and renders `<ApprovalOverlay>`. This only works in-process.

Daemon approval flow:
1. DaemonRunner encounters an action requiring approval
2. Daemon writes approval request to an in-memory queue + emits `approval_required` SSE event
3. CoreLoop blocks (awaits) on the approval promise
4. TUI receives SSE event → shows ApprovalOverlay → user responds
5. TUI sends `POST /goals/:id/approve { requestId, approved }`
6. Daemon resolves the approval promise → CoreLoop continues
7. Daemon emits `approval_resolved` SSE event

**Timeout:** If no client responds within 5 minutes, auto-deny (safe default per PulSeed design — irreversible actions always require human approval).

## Key Components

### EventServer Changes (~150 lines added)
- Add SSE client tracking (Set of response objects)
- Add `GET /stream` handler with keep-alive
- Add `broadcast(event, data)` method
- Add REST control endpoints
- Add approval queue (Map<requestId, {resolve, timeout}>)

### DaemonRunner Changes (~80 lines added)
- EventServer always-on (remove optional gate)
- After each `coreLoop.run()`: `eventServer.broadcast('iteration_complete', {...})`
- After state save: `eventServer.broadcast('goal_updated', {...})`
- Wire `approvalFn` to use EventServer approval queue
- Heartbeat timer for `daemon_status` events

### New: daemon-client.ts (~200 lines)
Client library for TUI/Web to connect to daemon:
- `DaemonClient.connect(port)` — establish SSE connection
- `DaemonClient.on(event, handler)` — event subscription
- `DaemonClient.startGoal(goalId)` — REST wrapper
- `DaemonClient.stopGoal(goalId)` — REST wrapper
- `DaemonClient.approve(goalId, requestId, approved)` — REST wrapper
- `DaemonClient.chat(goalId, message)` — REST wrapper
- `DaemonClient.getStatus()` — REST wrapper
- Auto-reconnect with exponential backoff

### TUI entry.ts Changes (rewrite ~200 lines)
Startup flow:
1. `ensureProviderConfig()`
2. Check `daemon-state.json` + probe PID → daemon running?
3. If NO: spawn daemon (`daemon start --detach`) → wait for `/health` ready
4. Create `DaemonClient` → connect to daemon
5. Render `<App>` with `daemonClient` instead of `coreLoop`

### TUI use-loop.ts Changes (rewrite ~200 lines)
- Subscribe to DaemonClient SSE events instead of polling
- `LoopController.start()` → `daemonClient.startGoal()` instead of `coreLoop.run()`
- Approval: listen for `approval_required` → trigger overlay → `daemonClient.approve()`
- Chat: `daemonClient.chat()` instead of direct `chatRunner.execute()`

## Migration Strategy

**Backward compatibility:** Keep `pulseed run --goal <id>` as standalone CoreLoop execution (no daemon). Only `pulseed` (TUI) uses daemon mode.

**Standalone fallback:** If daemon can't start (port conflict, etc.), TUI falls back to current standalone mode with a warning.

## Implementation Order

1. EventServer SSE + REST endpoints (no daemon changes yet — testable standalone)
2. DaemonRunner always-on EventServer + event emission
3. daemon-client.ts (testable against running daemon)
4. TUI entry.ts daemon detection + auto-start
5. TUI use-loop.ts SSE-driven
6. Integration test: full flow
