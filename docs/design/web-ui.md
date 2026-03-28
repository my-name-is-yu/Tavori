# Web UI Design

> Milestone 18. Defines a Web UI that complements the TUI. Multi-user support is a future concern.
> Design philosophy: **"Calm Control Room"** — a dense but organized, control-room-like calm UI.
> Related: `plugin-architecture.md`, `multi-agent-delegation.md`, `reporting.md`, `knowledge-transfer.md`

---

## 1. Overview

- The TUI (`src/tui/`) is designed for a single terminal. The Web UI enables browser access and multi-screen display.
- The TUI is kept. The Web UI shares the same data layer as the TUI (StateManager, CoreLoop, etc.) and operates concurrently.

**In scope**: 4 Web UI screens, REST API layer, SSE real-time updates
**Out of scope**: Multi-user support (to be considered when the project grows), mobile support, external OAuth, creating/editing goals from the Web UI

---

## 2. Design Philosophy: "Calm Control Room"

PulSeed is the "control room for agents." Like a cockpit, a large amount of information is arranged in organized positions, and attention is drawn only when something is anomalous.

| Patterns to avoid | Countermeasure |
|------------------|---------------|
| Generic card UI | No cards. Section dividers are only 1px borders or whitespace |
| All elements at the same visual weight | 3-level typographic hierarchy. Numbers large, labels small |
| Excessive decoration and gradients | Zero decoration. Accent color only for status indication |
| Uniform grid | Asymmetric layout: main 70% + side panel 30% |
| SaaS blue + light gray | Dark base + amber accent (warm color to express "motivation") |

**Reference UIs**: Linear (information density, keyboard navigation), Vercel Dashboard (real-time monitoring), Grafana (data-heavy monitoring), Railway (minimal developer dashboard)

---

## 3. Tech Stack

| Category | Selection | Reason |
|---------|-----------|--------|
| Framework | Next.js 15 (App Router) | SSR for initial render + client-side real-time. React 18 already in dependencies |
| Styling | Tailwind CSS v4 + CSS custom properties | Theme switching and customizability |
| Components | shadcn/ui (copy approach) | Source ownership for full customization |
| Real-time | SSE (extending existing EventServer) | Upgrade path to WebSocket preserved |
| State | Zustand | Lightweight store usable outside React |
| Charts | Recharts | Gap/Trust time-series display |
| Font | Geist Sans + Geist Mono | Icons: Lucide |

---

## 4. Architecture

### Directory Structure

```
web/
├── app/                    # Next.js App Router
│   ├── layout.tsx / page.tsx (Dashboard)
│   ├── goals/[id]/page.tsx, sessions/page.tsx
│   ├── knowledge/page.tsx, settings/page.tsx
│   └── api/                # Route Handlers
│       ├── goals/, sessions/, strategies/, knowledge/, reports/
│       └── events/route.ts  # SSE proxy
├── components/  (ui/, dashboard/, goal/, session/, knowledge/, layout/)
├── lib/  (pulseed-client.ts, store.ts, sse.ts)
├── styles/tokens.css
└── package.json, next.config.ts, tailwind.config.ts
```

### Data Layer and API

Route Handlers directly import pulseed-core modules within the Node.js process (same process, no RPC needed).

| Endpoint | Method | Corresponding module |
|----------|--------|---------------------|
| `/api/goals` | GET | StateManager.listGoals() |
| `/api/goals/:id` | GET | StateManager.getGoalState() |
| `/api/goals/:id/gap-history` | GET | StateManager (gap history) |
| `/api/sessions` | GET | SessionManager.listSessions() |
| `/api/sessions/:id/output` | GET (SSE) | EventServer (streaming) |
| `/api/strategies/:goalId` | GET | StrategyManager.getActiveStrategy() |
| `/api/knowledge/search` | POST | KnowledgeManager.search() |
| `/api/knowledge/transfers` | GET | KnowledgeTransfer.listTransfers() |
| `/api/reports/:goalId` | GET | ReportingEngine.generateReport() |
| `/api/events` | GET (SSE) | EventServer (real-time) |

### SSE Integration

`Browser → /api/events → EventServer.subscribe() → SSE stream`
On the client side, the Zustand store subscribes to SSE, and UI components subscribe to the store.

---

## 5. Screen Design

Common layout: left sidebar (nav, 120px fixed) + main area

### 5.1 Dashboard

**Top — Goal list table**: Goal name (link), Gap % (progress bar, background `#1a1a1a`), Trust score (number + color: red <0, gray 0-20, green >20), strategy status badge, last updated

**Middle — Active sessions**: Adapter name + role + stage (observe→gap→score→task→execute→verify), elapsed time

**Bottom — Decision timeline (last 10 items)**: Timestamp + goal name + decision type (PIVOT/REFINE/ESCALATE) + one-line summary

### 5.2 Goal Detail (`/goals/:id`)

**Header**: Goal name + threshold type + current Gap % (48px Geist Mono)

**Left 60%**: Gap history chart (AreaChart, 30 days), Trust trend (LineChart), task list (outcome: success/partial/fail icons)

**Right 40%**: Strategy history (PIVOT/REFINE), knowledge transfer records (with effectiveness_score), constraints

### 5.3 Agent Sessions

**Filter bar**: Status, adapter, role

**Table**: Session ID, goal, adapter, role, status, time

**Detail panel**: Pipeline stage progress indicator, real-time output (SSE, `Geist Mono`, background `#0a0a0a`)

### 5.4 Knowledge & Learning

3-section layout:
1. **Meta-pattern list** — LearningPipeline output, domain tags, application count, average effectiveness
2. **Decision records** — PIVOT/REFINE list, what_worked/what_failed/suggested_next
3. **Transfer candidates** — source → target goal, transfer_score, application results

### 5.5 Settings & Users

Provider settings (`~/.pulseed/provider.json`), plugin management (enable/disable), system health (CoreLoop state, EventServer connection count)

---

## 6. Multi-User Support

**Future concern** — to be designed and implemented when the project has grown. At MVP, single-user only (no authentication, localhost assumed).

---

## 7. Implementation Sub-stages

| Sub | Theme | Scale | Impact |
|-----|-------|-------|--------|
| 18.1 | Project structure + API layer — Next.js 15, Tailwind v4, shadcn/ui, design tokens, Route Handlers | Medium (2-3 days) | New `web/` |
| 18.2 | Dashboard screen — nav, goal list, session list, timeline | Medium (2-3 days) | `web/app/page.tsx`, `web/components/dashboard/` |
| 18.3 | Goal Detail + Sessions — charts (Recharts), task list, session detail | Medium (3-4 days) | `web/app/goals/`, `web/app/sessions/` |
| 18.4 | Real-time updates — SSE client, Zustand integration, output streaming | Medium (2-3 days) | `web/lib/sse.ts`, `web/lib/store.ts` |
| 18.5 | Knowledge + Settings screens | Medium (2-3 days) | `web/app/knowledge/`, `web/app/settings/` |
| 18.6 | Integration testing + Dogfooding — API tests, real goal monitoring, performance verification | Medium (2-3 days) | `web/__tests__/` |

---

## 8. Success Criteria

- [ ] Gap %, Trust, and strategy status are displayed in real-time on the Dashboard
- [ ] Gap/Trust trend charts display 30 days of data on Goal Detail
- [ ] Session output is streamed via SSE on Agent Sessions
- [ ] All features are accessible without authentication via localhost
- [ ] TUI and Web UI can operate concurrently against the same PulSeed process
- [ ] Initial load < 1.5 seconds (SSR), SSE event reflected < 500ms
- [ ] Dogfooding: Web UI monitoring operates without issues for 2+ hours

---

## 9. UI Design Details

### Color Palette

```css
:root {
  --bg-primary: #0a0a0a;  --bg-secondary: #141414;  --bg-tertiary: #1a1a1a;  --bg-hover: #1f1f1f;
  --border-primary: #262626;  --border-secondary: #333333;
  --text-primary: #fafafa;  --text-secondary: #a3a3a3;  --text-tertiary: #737373;
  /* Accent: Amber (motivation = warmth) */
  --accent-primary: #f59e0b;  --accent-secondary: #d97706;  --accent-muted: #78350f;
  /* Semantic */
  --status-success: #22c55e;  --status-warning: #f59e0b;  --status-error: #ef4444;
  --status-info: #6366f1;  --status-stalled: #f97316;
  /* Trust */
  --trust-negative: #ef4444;  --trust-neutral: #737373;  --trust-positive: #22c55e;
}
```

### Typography

| Usage | Font | Size | Weight |
|-------|------|------|--------|
| Screen title | Geist Sans | 20px | 600 |
| Section heading | Geist Sans | 14px | 500 |
| Body / table | Geist Sans | 13px | 400 |
| Emphasized numbers (Gap%, Trust) | Geist Mono | 32-48px | 700 |
| Code / output | Geist Mono | 12px | 400 |
| Labels | Geist Sans | 11px | 400 |

### Spacing and Components

4px base grid: 4, 8, 12, 16, 24, 32, 48, 64. Internal 8-16px, between sections 24-32px.

**shadcn/ui customization**: `border-radius: 4px` (sharp), `box-shadow: none`, Button = ghost/outline centered + filled only for accent, Table = 1px border row dividers + header `--bg-secondary`, Badge = low rounding, padding `2px 8px`, 11px

**Motion**: Micro 150ms `ease-out`, layout 300ms `ease-in-out`, data updates immediate, loading uses pulse skeleton (`--bg-tertiary`→`--bg-hover`)
