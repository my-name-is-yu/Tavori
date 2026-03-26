# @seedpulse/openclaw-plugin

OpenClaw handles the conversation. SeedPulse handles long-running goals.

This plugin connects [SeedPulse](https://github.com/my-name-is-yu/SeedPulse) to [OpenClaw](https://openclaw.dev) via the Gateway API, giving your OpenClaw sessions autonomous goal tracking, agent orchestration, and progress observation — without changing how you use OpenClaw.

SeedPulse goal-driven orchestration as an OpenClaw Gateway plugin.

The plugin hooks into the **Gateway lifecycle** via `SeedPulseEngine` — automatically detecting goals in user messages, launching `seedpulse run` in the background, and streaming progress back into the session.

## Installation

```bash
# Install the plugin in your OpenClaw project
npm install @seedpulse/openclaw-plugin

# Install the SeedPulse CLI globally (peer dependency)
npm install -g seedpulse
```

Then add to your `openclaw.config.json` (or equivalent):

```json
{
  "plugins": ["@seedpulse/openclaw-plugin"]
}
```

OpenClaw will call `activate(api)` at startup.

## Prerequisites

- SeedPulse CLI must be in your `$PATH`, or set `SEEDPULSE_CLI_PATH` to the full path.
- SeedPulse CLI installed globally — see [main README](../README.md#quick-start)
- SeedPulse uses `~/.seedpulse/` for state persistence. No extra configuration needed for basic use.

## Configuration

| Environment variable | Default     | Description                       |
|----------------------|-------------|-----------------------------------|
| `SEEDPULSE_CLI_PATH` | `seedpulse` | Path to the SeedPulse CLI binary  |

For provider settings (which LLM to use), create `~/.seedpulse/provider.json`:

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

### SeedPulseEngine lifecycle

#### `onSessionStart` — resume in-progress goals
When a session begins, the engine queries `~/.seedpulse/goals/` for any active goals. If found, it sends a resume message and restarts the background `seedpulse run` process.

```
[SeedPulse] Resuming active goal: Refactor auth module (id: goal_abc123, gap remaining: 28.0%)
```

#### `onMessage` — goal detection and automatic orchestration
Every user message is classified by `detectGoal()` (rule-based fast path, LLM fallback). If a goal is detected:

1. Sends a goal-start message with detected dimensions
2. Runs `seedpulse negotiate` to structure the goal
3. Spawns `seedpulse run --adapter openclaw_gateway` as a background process
4. Polls `~/.seedpulse/goals/<goalId>/state.json` every 3s and streams progress

```
User: "Increase test coverage to 90%+"
Plugin: Goal detected: Increase test coverage to 90%+
        Dimensions: numeric_target
Plugin: [1/10] Run test suite | gap: 28.0%
Plugin: [2/10] Fix uncovered branches | gap: 15.3%
Plugin: Goal complete.
```

#### `onSessionEnd` — clean state reset
Resets engine state. SeedPulse state is already persisted automatically to `~/.seedpulse/` — no extra action needed.

### Registered tools

| Tool name          | Description                            |
|--------------------|----------------------------------------|
| `seedpulse_status` | Show current SeedPulse goal status     |
| `seedpulse_stop`   | Stop the currently running loop        |

## Demo scenario

```
User: "Migrate this repository's TypeScript fully to ESM"

Plugin -> detectGoal(): isGoal=true, dimensions=["migration"]

Plugin: Goal detected: Migrate TypeScript to ESM
        Dimensions: migration

[seedpulse negotiate runs in background -> creates structured goal]
[seedpulse run --adapter openclaw_gateway starts in background]
[OpenClaw receives tasks from SeedPulse and executes them]

Plugin: [1/10] Update tsconfig.json for ESM | gap: 82.0%
Plugin: [3/10] Fix .js extension imports | gap: 45.1%
Plugin: [7/10] Verify build passes | gap: 12.3%
Plugin: Goal complete.

User: "seedpulse_status"
Plugin: (returns current seedpulse status output)
```

---

<details><summary>日本語版</summary>

```
User: "このリポジトリのTypeScriptをESMに完全移行してほしい"

Plugin → detectGoal(): isGoal=true, dimensions=["migration"]

Plugin: ゴール設定: TypeScriptをESMに完全移行
        計測次元: migration

[seedpulse negotiate runs in background → creates structured goal]
[seedpulse run --adapter openclaw_gateway starts in background]
[OpenClaw receives tasks from SeedPulse and executes them]

Plugin: [1/10] Update tsconfig.json for ESM | gap: 82.0%
Plugin: [3/10] Fix .js extension imports | gap: 45.1%
Plugin: [7/10] Verify build passes | gap: 12.3%
Plugin: ゴール達成！

User: "seedpulse_status"
Plugin: (returns current seedpulse status output)
```

</details>

## Design notes

- **SeedPulseEngine class** — all state (activeGoalId, isRunning, poll timer) is encapsulated. No module-level globals.
- **CLI-driven** — drives SeedPulse via `execFile`/`spawn` (no direct import). The full seedpulse dependency tree (zod, openai, etc.) is not bundled.
- **State file polling** — reads `~/.seedpulse/goals/<goalId>/state.json` every 3s to detect progress, stalls, and completion. No extra IPC needed.
- **Fail-open** — all errors are caught and logged via `api.log`. The plugin never crashes the Gateway.
- **200-line budget** — the engine class stays in `src/index.ts`; goal detection, adapter, and progress formatting are in separate modules.

## License

MIT
