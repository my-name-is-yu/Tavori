# Batch F — Runtime Async Migration Analysis

Generated: 2026-03-18
Issue: #54 Phase 2, Batch F

---

## Context

`src/utils/json-io.ts` provides the async helpers available for reuse:
- `readJsonFile<T>(path): Promise<T>` — async read + JSON.parse
- `writeJsonFile(path, data): Promise<void>` — async JSON write

`src/knowledge/memory-persistence.ts` also has `atomicWriteAsync` (pattern: write .tmp then rename).

---

## 1. `src/runtime/daemon-runner.ts`

**Test file:** `tests/daemon-runner.test.ts` + `tests/daemon-runner-shutdown.test.ts`

**Callers of public methods:**
- `src/cli/commands/daemon.ts` — calls `daemon.start(goalIds)`, `daemon.stop()` (via SIGTERM), `DaemonRunner.generateCronEntry()` (static, no fs)
- `src/index.ts` — re-exports `DaemonRunner` and `DaemonDeps`

### Sync fs calls

| Line | Call | Context |
|------|------|---------|
| 389 | `fs.writeFileSync(tmpPath, ...)` | `saveDaemonState()` — writes daemon-state.json.tmp |
| 390 | `fs.renameSync(tmpPath, statePath)` | `saveDaemonState()` — atomic rename to daemon-state.json |
| 406 | `fs.existsSync(statePath)` | `loadDaemonState()` — guard before read |
| 407 | `fs.readFileSync(statePath, "utf-8")` | `loadDaemonState()` — reads daemon-state.json |
| 461 | `fs.writeFileSync(tmp, ...)` | `cleanup()` — writes shutdown-state.json.tmp (fallback path) |
| 462 | `fs.renameSync(tmp, markerPath)` | `cleanup()` — atomic rename to shutdown-state.json |

**Note:** `writeShutdownMarker()` (lines 511–519) and `rotateLog()`/`pruneRotatedLogs()` (lines 585–641) are already fully async (`fsp.*`). No action needed there.

### Migration plan

**`saveDaemonState()` (lines 385–397) — migrate to async**
- Rename to `saveDaemonState(): Promise<void>`
- Replace `fs.writeFileSync` + `fs.renameSync` with `fsp.writeFile` + `fsp.rename`
- **Callers inside daemon-runner.ts** (all must be awaited):
  - Line 171: `this.saveDaemonState()` inside `start()` — already async context, add `await`
  - Line 223: `this.saveDaemonState()` inside `stop()` — `stop()` is currently `void`; must become `async stop(): Promise<void>`
  - Line 268: `this.saveDaemonState()` inside `runLoop()` — already async context, add `await`
  - Line 376: `this.saveDaemonState()` inside `handleCriticalError()` — currently sync; must become `async handleCriticalError(): Promise<void>` and awaited in `runLoop()` catch block (line 277)
  - Line 447: `this.saveDaemonState()` inside `cleanup()` — currently sync; `cleanup()` must become `async cleanup(): Promise<void>` and awaited at end of `runLoop()` (line 282)

**`loadDaemonState()` (lines 403–412) — migrate to async**
- Rename to `loadDaemonState(): Promise<DaemonState | null>`
- Replace `fs.existsSync` with try/catch on `fsp.access` or catch ENOENT from `fsp.readFile`
- Replace `fs.readFileSync` with `await fsp.readFile`
- **Caller inside daemon-runner.ts:**
  - Line 420: `this.loadDaemonState()` inside `restoreState()` — already async, add `await`

**`cleanup()` (lines 441–471) — sync fallback path (lines 459–465)**
- Lines 461–462 (`fs.writeFileSync`/`fs.renameSync`) are the fallback when `writeShutdownMarker` is not called
- `cleanup()` is called from `runLoop()` line 282 (sync call in finally-equivalent position)
- Migrate to async: replace lines 459–465 with `await fsp.writeFile` + `await fsp.rename`
- `cleanup()` must become `private async cleanup(): Promise<void>`
- In `runLoop()` at line 282: change to `await this.cleanup()`

**Calls that MUST stay sync:** None — all sync calls are in non-callback contexts.

**External caller impact:**
- `daemon.stop()` in `src/cli/commands/daemon.ts` (line 87 — `pidManager.cleanup()`, not daemon.stop directly; SIGTERM is sent, daemon.stop() is triggered by signal handler which is already void). No external caller calls `saveDaemonState` or `loadDaemonState` directly — they are private.
- `stop()` (public, line 217) is called from signal handlers (sync callbacks). Making `stop()` async and fire-and-forget inside signal handlers is acceptable since it's already the pattern; the signal handler calls `shutdown()` which sets flags and aborts sleep — fs writes are secondary.

---

## 2. `src/runtime/pid-manager.ts`

**Test file:** `tests/pid-manager.test.ts`

**Callers of public methods:**
- `src/runtime/daemon-runner.ts`:
  - Line 106: `this.pidManager.isRunning()`
  - Line 107: `this.pidManager.readPID()`
  - Line 115: `this.pidManager.writePID()`
  - Line 448: `this.pidManager.cleanup()`
- `src/cli/commands/daemon.ts`:
  - Line 52: `pidManager.isRunning()`
  - Line 53: `pidManager.readPID()`
  - Line 74: `pidManager.isRunning()`
  - Line 79: `pidManager.readPID()`
  - Line 87: `pidManager.cleanup()`

### Sync fs calls

| Line | Call | Context |
|------|------|---------|
| 20 | `fs.renameSync(tmpPath, this.pidPath)` | `writePID()` — atomic rename after writeJsonFileSync |
| 26 | `fs.existsSync(this.pidPath)` | `readPID()` — guard before read |
| 52 | `fs.existsSync(this.pidPath)` | `cleanup()` — guard before unlink |
| 53 | `fs.unlinkSync(this.pidPath)` | `cleanup()` — removes PID file |

**Note:** Line 19 uses `writeJsonFileSync(tmpPath, info)` from json-io (sync helper).

### Migration plan

**`writePID()` — migrate to `async writePID(): Promise<void>`**
- Replace `writeJsonFileSync` with `await writeJsonFile` (already available in json-io)
- Replace `fs.renameSync` with `await fsp.rename`
- **Callers:**
  - `daemon-runner.ts` line 115: `this.pidManager.writePID()` inside `start()` (already async) → add `await`
  - `daemon.ts` has no direct call to `writePID()` (daemon-runner handles it)

**`readPID()` — migrate to `async readPID(): Promise<...| null>`**
- Replace `fs.existsSync` + `readJsonFileSync` with try/catch on `await fsp.readFile` + JSON.parse
- **Callers:**
  - `daemon-runner.ts` lines 107, 106 (via `isRunning()`) — both inside async context, add `await`
  - `daemon.ts` lines 53, 79 — inside async functions `cmdStart`/`cmdStop`, add `await`

**`isRunning()` — migrate to `async isRunning(): Promise<boolean>`**
- Depends on `readPID()` becoming async; add `await this.readPID()`
- **Callers:**
  - `daemon-runner.ts` line 106 — inside async `start()`, add `await`
  - `daemon.ts` lines 52, 74 — inside async functions, add `await`

**`cleanup()` — migrate to `async cleanup(): Promise<void>`**
- Replace `fs.existsSync` + `fs.unlinkSync` with try/catch on `await fsp.unlink` (ENOENT = file missing, ignore)
- **Callers:**
  - `daemon-runner.ts` line 448 — inside `cleanup()` of DaemonRunner (which is being made async, see above), add `await`
  - `daemon.ts` line 87 — inside async `cmdStop`, add `await`

**Calls that MUST stay sync:** None — no callbacks involved.

**Test file impact (`tests/pid-manager.test.ts`):**
- All test calls to `writePID()`, `readPID()`, `isRunning()`, `cleanup()` must become `await` calls
- Test functions must be changed from sync to `async`
- Lines using raw `fs.*` for setup/teardown in tests (e.g., `fs.writeFileSync`, `fs.existsSync`, `fs.rmSync`) are test helpers — they can stay sync or be migrated independently; NOT required for this batch

---

## 3. `src/runtime/event-server.ts`

**Test file:** `tests/event-server.test.ts`

**Callers of public methods:**
- `src/runtime/daemon-runner.ts`:
  - Line 123: `await this.eventServer.start()`
  - Line 207: `await this.eventServer.stop()`
  - `startFileWatcher()` and `stopFileWatcher()` are NOT called from daemon-runner directly (DriveSystem handles its own watcher; EventServer watcher started separately if needed)
- `src/index.ts` — re-exports only

### Sync fs calls

| Line | Call | Context | Migrate? |
|------|------|---------|----------|
| 77 | `fs.mkdirSync(this.eventsDir, { recursive: true })` | `startFileWatcher()` — before `fs.watch()` setup | **YES** — move before watcher, async |
| 102 | `fs.existsSync(filePath)` | `processEventFile()` — inside `fs.watch` callback | **NO** — must stay sync (watcher callback) |
| 103 | `fs.statSync(filePath)` | `processEventFile()` — inside `fs.watch` callback | **NO** — must stay sync (watcher callback) |
| 106 | `fs.readFileSync(filePath, "utf-8")` | `processEventFile()` — inside `fs.watch` callback | **NO** — must stay sync (watcher callback) |
| 115 | `fs.mkdirSync(processedDir, { recursive: true })` | `processEventFile()` — inside `fs.watch` callback | **NO** — must stay sync (watcher callback) |
| 117 | `fs.renameSync(filePath, dstPath)` | `processEventFile()` — inside `fs.watch` callback | **NO** — must stay sync (watcher callback) |

### Migration plan

**Only one call can be migrated: line 77 `fs.mkdirSync` in `startFileWatcher()`**

`startFileWatcher()` is currently sync (`void`). To make the `mkdir` async, two options:

**Option A (preferred):** Move the `mkdirSync` out of `startFileWatcher()` into `start()` which is already async:
```
In start(): await fsp.mkdir(this.eventsDir, { recursive: true })
Remove: fs.mkdirSync line 77 from startFileWatcher()
```
This is the cleanest approach — directory creation is a startup concern, not a watcher concern. `startFileWatcher()` signature stays `void`.

**Option B:** Make `startFileWatcher()` async and call `await fsp.mkdir(...)` before `fs.watch()`. Callers would need to `await startFileWatcher()` — but since no external callers use it in the current codebase (it's only called internally or in tests), this is feasible but adds interface churn.

**Calls that MUST stay sync (lines 102, 103, 106, 115, 117):**
These are inside the `fs.watch` callback passed to Node.js (`(eventType, filename) => { ... }`). Node.js `fs.watch` callbacks are synchronous event loop callbacks — they cannot be made async without converting to a promise-based file watching approach (e.g., using `fsp.opendir` + polling or `chokidar`). This is out of scope for #54 Phase 2.

**Test file impact (`tests/event-server.test.ts`):**
- No public API signatures change (only internal `start()` gains a `mkdir` call)
- All existing tests remain valid as-is
- `startFileWatcher()` signature stays the same under Option A

---

## Summary Table

| File | Sync calls | Migrate | Must stay sync | Test file |
|------|-----------|---------|----------------|-----------|
| daemon-runner.ts | 6 | 6 | 0 | tests/daemon-runner.test.ts + tests/daemon-runner-shutdown.test.ts |
| pid-manager.ts | 4 | 4 | 0 | tests/pid-manager.test.ts |
| event-server.ts | 6 | 1 (mkdirSync in startFileWatcher) | 5 (all in fs.watch callback) | tests/event-server.test.ts |

## Cascading Changes Required

### daemon-runner.ts internal methods that become async
1. `saveDaemonState(): void` → `async saveDaemonState(): Promise<void>`
2. `loadDaemonState(): DaemonState | null` → `async loadDaemonState(): Promise<DaemonState | null>`
3. `cleanup(): void` → `async cleanup(): Promise<void>`
4. `handleCriticalError(): void` → `async handleCriticalError(): Promise<void>`

### PIDManager public API that becomes async
1. `writePID(): void` → `async writePID(): Promise<void>`
2. `readPID(): ...| null` → `async readPID(): Promise<...| null>`
3. `isRunning(): boolean` → `async isRunning(): Promise<boolean>`
4. `cleanup(): void` → `async cleanup(): Promise<void>`

### External files requiring `await` additions after PIDManager migration
- `src/runtime/daemon-runner.ts` — 4 call sites (lines 106, 107, 115, 448)
- `src/cli/commands/daemon.ts` — 5 call sites (lines 52, 53, 74, 79, 87)
- `tests/pid-manager.test.ts` — all test calls to PIDManager public methods must be awaited (test functions → async)

### EventServer: no public API signature changes (Option A)
- Only internal: move `fs.mkdirSync` from `startFileWatcher()` to `start()` as `await fsp.mkdir(...)`
- Zero external caller changes needed

## Recommended Implementation Order

1. **pid-manager.ts** — standalone, no internal dependencies on other files being changed
2. **daemon-runner.ts** — depends on PIDManager being async first; migrate private methods + update callsites
3. **event-server.ts** — independent single-call migration; do last as trivial

**Confidence: Confirmed** — based on direct file reads of all source and test files.
