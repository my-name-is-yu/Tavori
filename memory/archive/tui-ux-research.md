# TUI UX Research — Motiva

**Generated:** 2026-03-12
**Researcher:** Agent (sonnet)
**Branch:** main
**Scope:** All 8 `src/tui/` files + 3 test files + package.json + tsconfig.tui.json

---

## 1. Current Architecture Summary

### Component Tree

```
entry.ts (startTUI)
  └── App (app.tsx)                   — root; owns all state
       ├── Dashboard (dashboard.tsx)  — top panel, loop status + progress bars
       └── [HelpOverlay | Chat]       — lower panel; mutually exclusive
            ├── HelpOverlay (help-overlay.tsx)
            └── Chat (chat.tsx)
                 └── TextInput (ink-text-input)
```

### State Management

- **LoopController** (`use-loop.ts`) — class, not a React hook despite the filename.
  Owns: `LoopState` (running, goalId, iteration, status, dimensions, trustScore, startedAt, lastResult, lastError).
  Updates React via a registered `onUpdate` callback (`setLoopState`).
  Polls state every 2,000 ms via `setInterval` while running.

- **App** owns React state: `loopState`, `messages`, `isProcessing`, `showHelp`.

- **IntentRecognizer** (`intent-recognizer.ts`) — hybrid: keyword regex first ($0), LLM fallback (Anthropic API) for free-form input.

- **ActionHandler** (`actions.ts`) — maps intent → Motiva module calls; returns `ActionResult` (messages + signals).

### Rendering Approach

- **Ink 4.4.1** (React for terminal) with `flexDirection="column"`.
- **ink-text-input 5.0.1** for the single text input.
- Colors via Ink `color` prop (named colors: magenta, blue, gray, green, cyan, red, yellow).
- Borders via Ink `borderStyle="single"` / `"round"`.
- Progress bars via Unicode block characters (`█`, `░`) hand-computed in `renderBar()`.
- No external markdown renderer. Raw text strings pass through unchanged.
- No spinner/loading library. Processing state shown as static text: `"thinking..."`.
- No syntax highlighter.

### Dependency Inventory — TUI Related

| Package | Version | Usage |
|---------|---------|-------|
| ink | ^4.4.1 | Core terminal renderer |
| ink-text-input | ^5.0.1 | Single-line text input widget |
| react | ^18.3.1 | Required by Ink |
| @types/react | ^18.3.28 | Dev types |

**Not installed (relevant candidates):**
- `ink-spinner` — animated spinner for loading states
- `ink-select-input` — interactive selection menus
- `ink-link` — hyperlink rendering
- `marked` / `marked-terminal` — Markdown rendering
- `chalk` — ANSI color strings (Ink handles color natively, but chalk enables inline styling)
- `cli-highlight` — syntax highlighting for code blocks

---

## 2. UX Gaps vs. Modern CLI Tools (Claude Code Style)

### Gap 1 — No Markdown Rendering (CRITICAL)

**Problem:** `report` command output is raw Markdown strings (e.g. `## Daily Summary\n\nAll good.`). These are emitted directly into the Chat via `result.messages`. The `**bold**` and `# heading` markers display literally.

**Evidence:** `actions.ts` line 150 — `messages.push(report.content)` pushes `report.content` (a Markdown string) unmodified. `chat.tsx` line 38-43 — messages render as `<Text>{msg.text}</Text>` with no processing.

**Impact:** Every generated report, goal creation response, and LLM chat reply that contains Markdown formatting is unreadable.

**Fix:** Add `marked-terminal` or a custom inline parser to convert Markdown to ANSI sequences before rendering. Alternatively, render a multi-line `<Text>` component that parses and applies bold/dim/color per token. The simplest approach: install `marked` + `marked-terminal`, apply in a `MarkdownText` component.

**Effort:** M (3-4h) — add dependency + create `<MarkdownText>` wrapper component + swap all `<Text>{msg.text}</Text>` for `<MarkdownText>` in `chat.tsx`.

---

### Gap 2 — No Visual Distinction Between User and AI Messages (HIGH)

**Problem:** In `chat.tsx`, user messages use `backgroundColor="blackBright"` — a grey background with no label. Motiva messages have no background at all. There are no role labels ("You", "Motiva"), no color-coded left borders, no visual differentiation beyond a subtle background.

**Evidence:** `chat.tsx` lines 37-44.

**Impact:** In a scrollback of 20 messages, the conversation is hard to scan. User cannot tell at a glance which lines are theirs vs. Motiva's.

**Fix:**
Option A (minimal): Add `color="cyan"` prefix label `"motiva › "` and `color="green"` prefix `"you › "` before each message.
Option B (polished): Add left-border column using Unicode `▌` in a different color per role, mirroring Claude Code's chat style.
Option C (full): Box each message in a `<Box borderStyle="single" borderColor="cyan">` (Motiva) vs `<Box borderStyle="single" borderColor="green">` (user).

**Effort:** S (1h) for Option A; M (2h) for Option B.

---

### Gap 3 — Static "thinking..." Indicator Instead of Spinner (HIGH)

**Problem:** When `isProcessing=true`, `chat.tsx` line 44 renders static `<Text color="yellow">thinking...</Text>`. It does not animate. This makes the TUI feel frozen during LLM calls (which can take 3-10 seconds).

**Evidence:** `chat.tsx` line 44.

**Impact:** User has no confirmation that the system is working. The interface appears unresponsive during LLM fallback intent recognition.

**Fix:** Install `ink-spinner` (0 deps, tiny). Replace static text with:
```tsx
import Spinner from "ink-spinner";
// ...
{isProcessing && (
  <Box>
    <Text color="yellow"><Spinner type="dots" /></Text>
    <Text color="yellow"> thinking...</Text>
  </Box>
)}
```
**Effort:** S (30min) — one dependency install, one component swap.

---

### Gap 4 — No Input Prompt Prefix / Visual Feedback (MEDIUM)

**Problem:** The `<TextInput>` in `chat.tsx` (line 48) renders bare — no prompt character (`>`, `›`, `$`), no label, no color. Users cannot distinguish the input area from the message log.

**Evidence:** `chat.tsx` lines 47-49.

**Impact:** First-time users do not know where to type. The input zone is invisible until the cursor appears.

**Fix:**
```tsx
<Box>
  <Text color="green" bold>{"› "}</Text>
  <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
</Box>
```
**Effort:** S (15min) — one-line JSX change.

---

### Gap 5 — Dashboard Has No Layout Structure (MEDIUM)

**Problem:** Dashboard and Chat are stacked vertically with no horizontal split or sidebar. The dashboard (progress bars) takes up whatever height it needs, then Chat fills the rest. There is no status bar at the bottom and no persistent header.

**Evidence:** `app.tsx` lines 84-93 — `<Box flexDirection="column" height={process.stdout.rows || 24}>`.

**Impact:** When 6+ dimensions are showing, the dashboard can consume 70% of vertical space, leaving little room for chat. On resize, no reflow logic exists.

**Fix (P1 — sidebar layout):** Wrap in a horizontal `<Box flexDirection="row">`:
- Left column (fixed ~40 chars): Dashboard
- Right column (flex): Chat

This is a layout restructure, not a dependency addition. Pure Ink flexbox.

**Fix (P2 — status bar):** Add a persistent `<Box>` at the bottom (1 line) showing: `[status] goal: X  iter: N  trust: +M  [ESC: help]`.

**Effort:** M (2-3h) for sidebar layout; S (45min) for status bar only.

---

### Gap 6 — Dashboard Separator Line Is Fixed Width (LOW)

**Problem:** `dashboard.tsx` line 80: `"─".repeat(53)` — hardcoded 53 chars. Does not adapt to terminal width.

**Evidence:** `dashboard.tsx` line 80.

**Impact:** On wide terminals (>80 cols), separator is too short; on narrow terminals (<60 cols), it wraps.

**Fix:** Use `process.stdout.columns` or Ink's `useStdout()` hook to get terminal width, then `"─".repeat(width - 2)`.

**Effort:** S (30min).

---

### Gap 7 — No Timestamps on Messages (LOW)

**Problem:** `ChatMessage` has a `timestamp: Date` field (captured at creation), but `chat.tsx` never renders it. All messages appear without time information.

**Evidence:** `chat.tsx` lines 36-44 — timestamp is destructured from `msg` but not displayed. `actions.ts` lines 104-135 — `handleStatus()` generates multi-message output that would benefit from a "last updated" marker.

**Impact:** When reporting and status outputs span multiple lines across multiple timestamps, the user cannot correlate output to time.

**Fix:** Add dim timestamp suffix `HH:MM` to each message:
```tsx
<Text dimColor> {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
```
**Effort:** S (20min).

---

### Gap 8 — Help Overlay Has No Keyboard Navigation (LOW)

**Problem:** `help-overlay.tsx` listens only for `key.escape` to dismiss. No scroll, no page-down, no highlighting of commands. Static list.

**Evidence:** `help-overlay.tsx` lines 14-16.

**Impact:** Minor — the help text is short enough to fit on screen. But the yellow `borderStyle="round"` overlay floats without backdrop dimming.

**Fix (P2):** Add command highlighting with colors: `<Text color="cyan">{"run, start"}</Text>` vs. dimmed description. No new dependencies.

**Effort:** S (30min).

---

### Gap 9 — Report Content Dumped as Single Chat Message (MEDIUM)

**Problem:** `actions.ts` line 150: `messages.push(report.content)` — the entire report Markdown string is added as a single `ChatMessage`. Multi-line reports become one unsplittable text block in the chat area. Combined with Gap 1 (no Markdown rendering), this is visually the worst output in the app.

**Evidence:** `actions.ts` lines 148-158.

**Impact:** Multi-line report output with headers, bullet points, and emphasis is crammed into one plain `<Text>` block.

**Fix:** Split `report.content` by `\n` into individual messages, or (better) create a dedicated `ReportView` component with styled Markdown rendering. This pairs with Gap 1's fix.

**Effort:** S (30min) for newline-split only; M (2h) with Markdown rendering.

---

### Gap 10 — No Approval UI for Irreversible Tasks (ARCHITECTURAL)

**Problem:** `entry.ts` line 57: `const approvalFn = async () => true` — all tasks are auto-approved. This is documented as a TODO for Phase 2 (`// TODO(Phase 2): Implement chat-based approval prompt`). The TUI cannot currently block task execution for human confirmation.

**Evidence:** `entry.ts` lines 55-57; also `console.warn` at line 133.

**Impact:** Users running the TUI cannot exercise the approval gate that CLI mode provides (Motiva's core safety feature). This is the biggest functional gap between TUI and CLI mode, not a visual issue.

**Fix (Phase 2):** Route approval requests through the Ink render loop: push a special `ChatMessage` of role `"approval"` with accept/reject keyboard shortcuts (Y/N via `useInput`), resolve the `approvalFn` Promise when user responds. This requires a new approval state in App and a new `ApprovalPrompt` component.

**Effort:** L (4-6h) — new component, new App state, Promise-resolution pattern across async boundary.

---

## 3. Prioritized Improvement Roadmap

### P0 — Critical (blocks usability)

| # | Gap | Effort | Notes |
|---|-----|--------|-------|
| 1 | Markdown rendering | M | `marked-terminal` dependency; wrap in `<MarkdownText>` |
| 2 | Role labels in chat | S | Green/cyan color labels; no new deps |
| 3 | Animated spinner | S | `ink-spinner` install; 1 component swap |

### P1 — Important (noticeably improves polish)

| # | Gap | Effort | Notes |
|---|-----|--------|-------|
| 4 | Input prompt prefix `›` | S | 15-minute change |
| 5 | Sidebar layout (Dashboard left / Chat right) | M | Pure Ink flexbox |
| 9 | Report split + Markdown render | M | Pairs with P0 Gap 1 |
| 7 | Timestamps on messages | S | Use existing `timestamp` field |

### P2 — Nice-to-have

| # | Gap | Effort | Notes |
|---|-----|--------|-------|
| 5b | Status bar at bottom | S | Persistent 1-line status |
| 6 | Adaptive separator width | S | `process.stdout.columns` |
| 8 | Colorized help overlay | S | No new deps |
| 10 | Approval UI | L | Phase 2 architectural work |

---

## 4. Architectural Limitations

### A. LoopController is a class, not a React hook

`use-loop.ts` is named like a hook but exports a class (`LoopController`). It uses a callback pattern (`setOnUpdate`) instead of React state. This works but diverges from Ink/React idioms. Future refactor: convert to `useLoop()` hook using `useState` + `useEffect`. Not urgent, but makes the component tree harder to reason about.

### B. No terminal resize handling

No component reacts to `process.stdout.on("resize", ...)`. The `height={process.stdout.rows || 24}` in `app.tsx` is read once at render time. On terminal resize, layout breaks without re-render. Ink 4.x re-renders on resize automatically (it subscribes internally), but the hardcoded `height={process.stdout.rows}` may be stale. Test and potentially replace with Ink's `useStdout()` hook.

### C. Approval is bypassed at the entry level

The `approvalFn` bypass (Gap 10) is hardcoded at `entry.ts` construction time. It cannot be toggled per-task. Proper approval UI requires threading a Promise resolver through the React state layer — a non-trivial architectural change that touches `entry.ts`, `App`, and `TaskLifecycle`.

### D. Message list is unbounded in memory

`chat.tsx` renders the last 20 messages (`messages.slice(-20)`), but `App` accumulates all messages in state indefinitely (`setMessages(prev => [...prev, ...new])`). Long sessions will grow the array. Low-risk for MVP but should be capped (e.g., keep last 200) for production.

### E. Single-column layout limits scalability

The current vertical layout (`<Box flexDirection="column">`) works for 3-4 dimensions but degrades with more. A horizontal split (Dashboard sidebar + Chat pane) requires restructuring `app.tsx`'s root box. This is a clean Ink flexbox refactor — no React or Motiva logic changes required.

---

## 5. Quick-Win Implementation Order

For maximum visual impact with minimum effort:

1. Add `ink-spinner` and swap `"thinking..."` → animated spinner (30 min)
2. Add `›` input prompt prefix in `chat.tsx` (15 min)
3. Add role color labels (`"motiva › "` in cyan, `"you › "` in green) (1 h)
4. Add timestamps to messages using existing `timestamp` field (20 min)
5. Split report content on `\n` to avoid wall-of-text (30 min)
6. Add adaptive separator width in `dashboard.tsx` (30 min)

Total quick-win time: ~3.5 hours. All S-effort items requiring zero new dependencies except `ink-spinner`.

For P0 polish milestone: add `marked-terminal` for Markdown rendering (~4h including testing).

---

## 6. Dependency Candidates

| Package | Purpose | Install |
|---------|---------|---------|
| `ink-spinner` | Animated loading dots | `npm i ink-spinner` |
| `marked` + `marked-terminal` | Markdown → ANSI rendering | `npm i marked marked-terminal` |
| `ink-select-input` | Goal selection menu (future) | `npm i ink-select-input` |

All are well-maintained Ink ecosystem packages compatible with Ink 4.x.
