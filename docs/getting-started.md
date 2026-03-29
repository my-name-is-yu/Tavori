# Getting Started with PulSeed

This guide gets you from zero to a running goal loop in about 5 minutes.

---

## 1. Prerequisites

- **Node.js 20 or later** — check with `node --version`
- **An LLM API key** — OpenAI is the recommended starting point; Anthropic and local Ollama are also supported

---

## 2. Installation

### Global install (recommended)

```bash
npm install -g pulseed
pulseed --help
```

### Local install (for a single project)

```bash
npm install pulseed
npx pulseed --help
```

### From source

```bash
git clone https://github.com/my-name-is-yu/PulSeed.git
cd PulSeed
npm install
npm run build
node dist/cli-runner.js --help
```

---

## 3. Configure Your LLM Provider

PulSeed needs an LLM to reason about goals, generate tasks, and verify results.

### Option A — Environment variables (quickest)

```bash
export OPENAI_API_KEY=sk-...
# PULSEED_LLM_PROVIDER defaults to openai when OPENAI_API_KEY is set
```

### Option B — Persistent provider file

Create `~/.pulseed/provider.json`:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "apiKey": "sk-..."
}
```

PulSeed reads this file on every startup, so you only need to set it once. See [configuration.md](configuration.md) for the full provider.json reference and examples for Anthropic and Ollama.

### Verify the connection

```bash
pulseed status
```

Expected output (no goals registered yet):

```
No goals found. Add one with: pulseed goal add "<description>"
```

If you see an API key error instead, double-check the key and that `PULSEED_LLM_PROVIDER` matches your key type.

---

## 4. Your First Goal

### Step 1 — Discover goal suggestions (optional but helpful)

```bash
pulseed suggest .
```

PulSeed scans your current directory and proposes concrete goals based on what it finds. Example output:

```
Suggested goals:
  1. Increase test coverage to 80% (currently ~52%)
  2. Add JSDoc to all exported functions
  3. Fix 3 open TODO comments in src/

Select a goal [1-3] or press Enter to skip:
```

Select a number, or skip and add your own goal manually.

### Step 2 — Add a goal manually

```bash
pulseed goal add "Ensure all tests pass and coverage is above 80%"
```

PulSeed calls the LLM to negotiate the goal: it evaluates feasibility, decomposes the description into measurable dimensions (e.g., `test_pass_rate`, `coverage_percent`), and assigns thresholds. You will be shown a summary and asked to confirm.

Expected output:

```
Negotiating goal...

Goal: Ensure all tests pass and coverage is above 80%
Dimensions:
  - test_pass_rate  >=1.0  (currently: unknown)
  - coverage_pct   >=80   (currently: unknown)
Feasibility: achievable

Accept this goal? [Y/n]:
```

Press Enter to accept.

### Step 3 — Run the loop

```bash
pulseed run --goal <goal-id>
```

The goal ID is shown after the goal is accepted (e.g., `goal_abc123`). You can also look it up with:

```bash
pulseed goal list
```

Example run output:

```
Observing... [Ensure all tests pass and coverage is above 80%]
  test_pass_rate: 0.94 (gap: 0.06)
  coverage_pct:   61   (gap: 19)

Largest gap: coverage_pct
Generating task...
  Task: Write unit tests for src/utils/formatter.ts (currently 0% covered)
  Adapter: openai_codex_cli

Approve task? [Y/n]: Y

Executing...
Verifying...
  coverage_pct: 61 → 67 (+6)

Loop complete. Run again to continue.
```

### Step 4 — Check progress

```bash
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
```

---

## 5. What Happens Next

Each time you call `pulseed run`, PulSeed executes one full iteration of its core loop:

```
Observe → Gap → Score → Task → Execute → Verify
```

1. **Observe** — collects evidence from mechanical checks, an independent LLM review, and the executor's self-report
2. **Gap** — quantifies how far each dimension is from its threshold
3. **Score** — ranks gaps by dissatisfaction, deadline urgency, and opportunity
4. **Task** — generates a concrete, verifiable task targeting the largest gap
5. **Execute** — delegates the task to the selected adapter (Codex CLI, Claude Code, GitHub Issues, etc.)
6. **Verify** — runs 3-layer verification; self-report alone caps progress at 70%

State is written to `~/.pulseed/` after every loop, so you can stop and resume at any time. Running `pulseed run` again picks up exactly where the last run left off.

To run the loop continuously without manual re-invocation, use daemon mode:

```bash
pulseed start --goal <goal-id>
pulseed stop
```

Or generate a crontab entry:

```bash
pulseed cron --goal <goal-id>
```

---

## 6. Next Steps

- **Real-world examples** — [docs/usecase.md](usecase.md): dog health monitoring, SaaS revenue growth
- **Full configuration reference** — [docs/configuration.md](configuration.md): all env vars, provider.json formats, plugin config
- **Available adapters** — README.md `Supported Adapters` table
- **Architecture deep-dive** — [docs/mechanism.md](mechanism.md), [docs/runtime.md](runtime.md)
- **Design documents** — [docs/design/](design/) (23 files covering every subsystem)
- **OpenAI / Codex setup** — [docs/codex-testing-guide.md](codex-testing-guide.md)
- **Local LLM (Ollama)** — [docs/local-llm-testing-guide.md](local-llm-testing-guide.md)
