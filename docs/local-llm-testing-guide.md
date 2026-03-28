# Local LLM Testing Guide (for Older MacBooks)

## Prerequisites

- Intel MacBook (8GB RAM / 256GB Storage)
- macOS
- Node.js 20+
- Ollama installed
- Model: `qwen3:4b`

## 1. Setup

### Ollama

```bash
# Install Ollama (if not already installed)
# Download from https://ollama.com

# Pull the model
ollama pull qwen3:4b

# Verify
ollama list  # qwen3:4b should appear in the list
```

### PulSeed Repository

```bash
git clone <repository-url> PulSeed
cd PulSeed
npm install
npm run build
```

## 2. Starting Ollama

```bash
# Local only (when running PulSeed on the same machine)
ollama serve

# Allow external access (when accessing from another machine)
OLLAMA_HOST=0.0.0.0 ollama serve
```

## 3. Running PulSeed

### Common Environment Variables

```bash
export TAVORI_LLM_PROVIDER=ollama
export ANTHROPIC_API_KEY=dummy
```

> **Note**: `ANTHROPIC_API_KEY=dummy` is set to bypass the startup check in the TUI. A real key is not required when using Ollama.

### Entry Point

Use `npx pulseed` or run directly:

```bash
npx pulseed <subcommand>
# or
node dist/cli-runner.js <subcommand>
```

### Help

```bash
node dist/cli-runner.js --help
```

### Add a Goal

```bash
node dist/cli-runner.js goal add "Create a readme for PulSeed"
```

### List Goals

```bash
node dist/cli-runner.js goal list
```

### Run the Core Loop

```bash
node dist/cli-runner.js run
```

### Check Status

```bash
node dist/cli-runner.js status
```

### Report

```bash
node dist/cli-runner.js report
```

### TUI (Interactive UI)

```bash
node dist/cli-runner.js tui
```

TUI controls:
- `/help` — show command list
- `/goal add <goal>` — add a goal
- `Ctrl-C` — quit

> **TUI notes**:
> - Display may be garbled over SSH + tmux due to insufficient terminal width → use `Ctrl-b z` to zoom the pane and gain more width
> - Chat is command-based, not free-form input
> - If frozen, press `Ctrl-C` or run `pkill -f "node dist/cli-runner.js"` from another terminal pane

## 4. Connecting to Ollama from Another Machine

Run Ollama on the older MacBook and run PulSeed from your development machine:

```bash
# Find the IP address of the older MacBook
ifconfig | grep "inet "

# Test the connection from your development machine
curl http://<older-mac-ip>:11434/v1/models

# Run PulSeed from your development machine
TAVORI_LLM_PROVIDER=ollama \
OLLAMA_BASE_URL=http://<older-mac-ip>:11434 \
node dist/cli-runner.js run
```

## 5. Test Scenarios

### A. Basic Operation Check

```bash
# 1. Add a goal
node dist/cli-runner.js goal add "A simple goal for testing"

# 2. Confirm registration with goal list
node dist/cli-runner.js goal list

# 3. Run the core loop
node dist/cli-runner.js run

# 4. Check status
node dist/cli-runner.js status

# 5. Generate a report
node dist/cli-runner.js report
```

### B. TUI Operation Check

```bash
node dist/cli-runner.js tui
# → Run /help to see available commands
# → Try adding and running a goal
# → Press Ctrl-C to exit
```

### C. Error Handling Check

```bash
# Run PulSeed while Ollama is stopped → verify retry and error output
# (stop ollama in another terminal first, then run)
node dist/cli-runner.js run
```

## 6. Known Issues

| Issue | Cause | Workaround |
|-------|-------|------------|
| ~~`npx pulseed` produces no output~~ | ~~Fixed~~ Updated to use `import.meta.url` + `realpathSync` check | Both `npx pulseed` and `node dist/cli-runner.js` work |
| TUI display garbled | Insufficient terminal width over SSH + tmux | Zoom the pane with `Ctrl-b z` |
| TUI chat says "I didn't understand" | Chat is command-based (free-form input not supported) | Check available commands with `/help` |
| TUI frozen | Ink rendering issue | `Ctrl-C` or `pkill -f "node dist/cli-runner.js"` |
| `ANTHROPIC_API_KEY` required | Hard-coded check at TUI startup | Set `ANTHROPIC_API_KEY=dummy` |

## 7. Resetting State

To clear test data and start fresh:

```bash
rm -rf ~/.pulseed
```
