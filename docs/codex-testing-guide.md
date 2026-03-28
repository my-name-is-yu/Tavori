# OpenAI / Codex Testing Guide

A guide for running PulSeed with the OpenAI API and OpenAI Codex CLI.

## Prerequisites

- ChatGPT Plus ($20/month) or a separate OpenAI API subscription
  - **Important**: ChatGPT Plus and the OpenAI API are billed completely separately. Calls made using an API key are pay-as-you-go. Codex CLI is available within the ChatGPT Plus subscription.
- Node.js 20+
- PulSeed built (`npm run build`)
- OpenAI Codex CLI installed (only required when running tasks via Codex)

### Obtaining an OpenAI API Key

1. Go to [https://platform.openai.com](https://platform.openai.com)
2. Navigate to "API Keys" → "Create new secret key"
3. Store the generated key (`sk-...`) somewhere safe

### Installing Codex CLI

```bash
npm install -g @openai/codex

# Verify the installation
codex --version
```

### OAuth Authentication for Codex CLI

The first time you run Codex CLI, it requires OAuth authentication via your browser.

1. Running `codex` for the first time will open a browser window showing the OpenAI/ChatGPT OAuth screen
2. Log in with your ChatGPT account (ChatGPT Plus plan) to complete authentication
3. After authentication, `codex exec --full-auto` will work in non-interactive mode without further prompts

---

## 1. Setting Environment Variables

### Required

```bash
export TAVORI_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
```

### Optional

```bash
# Model to use (default: gpt-5.4-mini)
export OPENAI_MODEL=gpt-5.4-mini    # default (recommended)
export OPENAI_MODEL=gpt-4.1         # higher-capability model
export OPENAI_MODEL=o3              # high-performance reasoning model
export OPENAI_MODEL=o4-mini         # reasoning model (lightweight)
# NOTE: gpt-4o-mini is NOT compatible with the openai_codex_cli adapter — use gpt-5.4-mini instead

# When using Azure OpenAI or a proxy
export OPENAI_BASE_URL=https://<your-endpoint>.openai.azure.com/
```

> **Note**: The `o1` / `o3` / `o4` reasoning models do not support the `temperature` parameter. PulSeed automatically omits temperature when calling these models.

### Using a .env File

Create a `.env` file at the project root (**confirm it is in .gitignore**):

```bash
# .env
TAVORI_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-5.4-mini

# For switching to Anthropic (see below)
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

Load it:

```bash
source .env  # or: set -a; source .env; set +a
```

---

## 2. PulSeed Entry Point

```bash
# Run the built binary directly
node dist/cli-runner.js <subcommand>

# Or via npx
npx pulseed <subcommand>
```

---

## 3. Step-by-Step Testing

### Step 1: Verify the Connection

```bash
TAVORI_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js status
```

If the command starts without errors and displays the goal list (even if empty), the connection is working.

### Step 2: Add a Goal

```bash
TAVORI_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js goal add "Create a file hello.txt and write 'Hello, PulSeed!' in it"
```

GoalNegotiator will call the LLM to evaluate the goal's dimensions, thresholds, and feasibility.
Confirm registration:

```bash
node dist/cli-runner.js goal list
```

### Step 3: Run One Core Loop Cycle

```bash
TAVORI_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js run
```

This executes one full cycle: observe → gap → score → task → verify.

### Step 4: Run a Task via the Codex Adapter

Set the goal's `adapter_type` to `openai_codex_cli` to delegate tasks to Codex.

Example goal JSON (`goal-codex-test.json`):

```json
{
  "description": "Create hello.txt and write 'Hello, PulSeed!' in it",
  "adapter_type": "openai_codex_cli",
  "dimensions": [
    {
      "name": "file_created",
      "threshold": { "type": "present", "value": true }
    }
  ]
}
```

Run:

```bash
TAVORI_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
node dist/cli-runner.js run
```

The Codex adapter internally executes:

```bash
codex exec --full-auto "PROMPT"
```

To specify `--model`, pass it to the `OpenAICodexCLIAdapter` constructor (requires a code change).

---

## 4. Example Goals for Testing

### A. Simple File Creation Task (easy to run with Codex)

```bash
node dist/cli-runner.js goal add "Create hello.txt in the current directory and write 'Hello from PulSeed!'"
```

### B. Run Tests Task

```bash
node dist/cli-runner.js goal add "Run npx vitest run and confirm all tests pass"
```

### C. Documentation Generation Task

```bash
node dist/cli-runner.js goal add "Create README.md and describe the project in 3 lines"
```

---

## 5. Troubleshooting

### API Key Not Set

```
OpenAILLMClient: no API key provided. Pass apiKey to constructor or set OPENAI_API_KEY env var.
```

→ Run `export OPENAI_API_KEY=sk-...` and try again.

### Codex CLI Not Installed

```
Error: spawn codex ENOENT
```

→ Run `npm install -g @openai/codex`. After installation, verify with `codex --version`.

### Rate Limit (429 Error)

```
OpenAILLMClient: HTTP 429 Too Many Requests
```

OpenAILLMClient will automatically retry up to 3 times with exponential backoff (1s → 2s → 4s).
If it still fails, wait a while before retrying, or upgrade to a higher-tier API plan.

### Temperature Error with Reasoning Models

The `o1` / `o3` / `o4` model families do not accept the temperature parameter.
PulSeed automatically omits temperature, so this is normally not an issue.
Take care if you are passing parameters directly from outside PulSeed.

### Incorrect Model Name

```
OpenAILLMClient: HTTP 404 ...
```

→ Check the value of `OPENAI_MODEL`. For available model names, refer to [https://platform.openai.com/docs/models](https://platform.openai.com/docs/models).

---

## 6. Switching Between Anthropic and OpenAI

You can switch providers simply by changing environment variables.

### Use OpenAI

```bash
export TAVORI_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-5.4-mini  # omit to use default
```

### Switch Back to Anthropic (Default)

```bash
unset TAVORI_LLM_PROVIDER
export ANTHROPIC_API_KEY=sk-ant-...
```

### Example .env with Both Providers

```bash
# .env — uncomment the provider you want to use, then run: source .env

# --- OpenAI ---
TAVORI_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-5.4-mini

# --- Anthropic (default) ---
# TAVORI_LLM_PROVIDER=
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

---

## 7. Resetting State

To clear test data and start fresh:

```bash
rm -rf ~/.pulseed
```

---

## 8. Automated E2E Tests

PulSeed includes E2E tests for OpenAI/Codex. They are skipped automatically if an API key or Codex CLI is not configured.

### Test Files

| File | Description | Test Count |
|------|-------------|------------|
| `tests/e2e/openai-e2e.test.ts` | Direct OpenAI API call tests | 3 tests |
| `tests/e2e/codex-cli-e2e.test.ts` | Codex CLI adapter tests | 3 tests |

### How to Run

```bash
# Run E2E tests only
OPENAI_API_KEY=sk-... npx vitest run tests/e2e/
```

### Skip Conditions

- If `OPENAI_API_KEY` is not set → `openai-e2e.test.ts` is skipped automatically
- If Codex CLI is not installed → `codex-cli-e2e.test.ts` is skipped automatically
