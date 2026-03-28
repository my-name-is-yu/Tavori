# @pulseed/openclaw-plugin

OpenClaw handles the conversation. PulSeed handles long-running goals.

This plugin connects [PulSeed](https://github.com/my-name-is-yu/PulSeed) to OpenClaw via the Gateway API, giving your OpenClaw sessions autonomous goal tracking, agent orchestration, and progress observation — without changing how you use OpenClaw.

PulSeed goal-driven orchestration as an OpenClaw Gateway plugin.

The plugin hooks into the **Gateway lifecycle** via `PulSeedEngine` — automatically detecting goals in user messages, launching `pulseed run` in the background, and streaming progress back into the session.

## Installation

```bash
# Install the plugin in your OpenClaw project
npm install @pulseed/openclaw-plugin

# Install the PulSeed CLI globally (peer dependency)
npm install -g pulseed
```

Then add to your `openclaw.config.json` (or equivalent):

```json
{
  "plugins": ["@pulseed/openclaw-plugin"]
}
```

OpenClaw will call `activate(api)` at startup.

## Prerequisites

- PulSeed CLI must be in your `$PATH`, or set `PULSEED_CLI_PATH` to the full path.
- PulSeed CLI installed globally — see [main README](../README.md#quick-start)
- PulSeed uses `~/.pulseed/` for state persistence. No extra configuration needed for basic use.

## Configuration

| Environment variable | Default     | Description                       |
|----------------------|-------------|-----------------------------------|
| `PULSEED_CLI_PATH` | `pulseed` | Path to the PulSeed CLI binary  |

For provider settings (which LLM to use), create `~/.pulseed/provider.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "openclaw": {
    "gatewayUrl": "http://localhost:3000",
    "adapter": "openclaw_gateway"
  }
}
```

## What it does

### PulSeedEngine lifecycle

#### `onSessionStart` — resume in-progress goals
When a session begins, the engine queries `~/.pulseed/goals/` for any active goals. If found, it sends a resume message and restarts the background `pulseed run` process.

```
[PulSeed] Resuming active goal: Refactor auth module (id: goal_abc123, gap remaining: 28.0%)
```

#### `onMessage` — goal detection and automatic orchestration
Every user message is classified by `detectGoal()` (rule-based fast path, LLM fallback). If a goal is detected:

1. Sends a goal-start message with detected dimensions
2. Runs `pulseed negotiate` to structure the goal
3. Spawns `pulseed run --adapter openclaw_gateway` as a background process
4. Polls `~/.pulseed/goals/<goalId>/state.json` every 3s and streams progress

```
User: "Increase test coverage to 90%+"
Plugin: Goal detected: Increase test coverage to 90%+
        Dimensions: numeric_target
Plugin: [1/10] Run test suite | gap: 28.0%
Plugin: [2/10] Fix uncovered branches | gap: 15.3%
Plugin: Goal complete.
```

#### `onSessionEnd` — clean state reset
Resets engine state. PulSeed state is already persisted automatically to `~/.pulseed/` — no extra action needed.

### Registered tools

| Tool name          | Description                            |
|--------------------|----------------------------------------|
| `pulseed_status` | Show current PulSeed goal status     |
| `pulseed_stop`   | Stop the currently running loop        |

## Demo scenario

```
User: "Migrate this repository's TypeScript fully to ESM"

Plugin -> detectGoal(): isGoal=true, dimensions=["migration"]

Plugin: Goal detected: Migrate TypeScript to ESM
        Dimensions: migration

[pulseed negotiate runs in background -> creates structured goal]
[pulseed run --adapter openclaw_gateway starts in background]
[OpenClaw receives tasks from PulSeed and executes them]

Plugin: [1/10] Update tsconfig.json for ESM | gap: 82.0%
Plugin: [3/10] Fix .js extension imports | gap: 45.1%
Plugin: [7/10] Verify build passes | gap: 12.3%
Plugin: Goal complete.

User: "pulseed_status"
Plugin: (returns current pulseed status output)
```

---

<details><summary>日本語版</summary>

```
User: "このリポジトリのTypeScriptをESMに完全移行してほしい"

Plugin → detectGoal(): isGoal=true, dimensions=["migration"]

Plugin: ゴール設定: TypeScriptをESMに完全移行
        計測次元: migration

[pulseed negotiate runs in background → creates structured goal]
[pulseed run --adapter openclaw_gateway starts in background]
[OpenClaw receives tasks from PulSeed and executes them]

Plugin: [1/10] Update tsconfig.json for ESM | gap: 82.0%
Plugin: [3/10] Fix .js extension imports | gap: 45.1%
Plugin: [7/10] Verify build passes | gap: 12.3%
Plugin: ゴール達成！

User: "pulseed_status"
Plugin: (returns current pulseed status output)
```

</details>

## Design notes

- **PulSeedEngine class** — all state (activeGoalId, isRunning, poll timer) is encapsulated. No module-level globals.
- **CLI-driven** — drives PulSeed via `execFile`/`spawn` (no direct import). The full pulseed dependency tree (zod, openai, etc.) is not bundled.
- **State file polling** — reads `~/.pulseed/goals/<goalId>/state.json` every 3s to detect progress, stalls, and completion. No extra IPC needed.
- **Fail-open** — all errors are caught and logged via `api.log`. The plugin never crashes the Gateway.
- **200-line budget** — the engine class stays in `src/index.ts`; goal detection, adapter, and progress formatting are in separate modules.

## License

MIT
