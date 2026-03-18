# Research: Issue #54 — Sync fs API Migration

**Date**: 2026-03-18
**Total sync API occurrences**: 172 across 26 files

---

## File Table

| File | Sync count | Callers async? | Hot path? | Notes |
|------|-----------|----------------|-----------|-------|
| `src/state-manager.ts` | 26 | No (all sync methods) | YES | Constructor calls `ensureDirectories()` (sync mkdirSync×8). `goalDir()` sync. `atomicWrite`, `readJsonFile` are private sync helpers called by every public method. All public methods (saveGoal, loadGoal, deleteGoal, archiveGoal, etc.) are sync. |
| `src/drive/drive-system.ts` | 20 | No (all sync methods) | YES | Constructor calls `ensureDirectories()` (sync). `readEventQueue()`, `processEvents()`, `archiveEvent()`, `writeEvent()`, `getSchedule()`, `updateSchedule()` are all sync. `startWatcher()` uses `readFileSync` inside watcher callback (sync is intentional there). |
| `src/knowledge/memory-lifecycle.ts` | 14 (via imports) | Mixed | Indirect | Direct `fs.*` calls: `mkdirSync` in `initializeDirectories()`, `existsSync` + `mkdirSync` + `readdirSync` + `copyFileSync` + `rmSync` in async `onGoalClose()`. Most sync calls are in `recordToShortTerm()` (sync method). Uses `atomicWrite`/`readJsonFile` from `memory-persistence.ts`. |
| `src/runtime/logger.ts` | 11 | No (sync log path) | YES | `mkdirSync` in constructor. `appendFileSync`, `statSync`, `existsSync`, `renameSync`, `unlinkSync` all in sync `writeToFile()` / `rotateIfNeeded()`. Logger is called from daemon hot path — must stay sync or switch to buffered async. |
| `src/knowledge/memory-persistence.ts` | 8 | No (all sync) | Indirect | Pure sync utility library: `atomicWrite()` (mkdirSync + writeFileSync + renameSync), `readJsonFile()` (existsSync + readFileSync), `getDirectorySize()` (existsSync + readdirSync + statSync). Exported and consumed by `memory-lifecycle`, `memory-index`, `memory-compression`, `memory-phases`. |
| `src/observation/workspace-context.ts` | 8 | No (returns async fn wrapping sync) | Indirect | `readdirSync`, `statSync`, `readFileSync`, `accessSync` inside exported async factory return value. The returned async function does synchronous file reads internally. |
| `src/cli/commands/plugin.ts` | 8 | Mixed | No | `fsSync.existsSync` and `fsSync.statSync` used alongside `fs/promises` (`readdir`, `readFile`). Explicit mixed usage — partially migrated already. |
| `src/knowledge/memory-compression.ts` | 4 | Mixed (called from async fns) | Indirect | `existsSync` in `applyRetentionPolicy()` (async), `runGarbageCollection()` (async). `existsSync` + `readdirSync` in `runGarbageCollection()`. |
| `src/knowledge/knowledge-graph.ts` | 5 | No (all sync) | No | `constructor` calls sync `load()` (existsSync + readFileSync). Every mutating method calls sync `save()` (mkdirSync + writeFileSync + renameSync). |
| `src/knowledge/vector-index.ts` | 5 | No (private methods sync) | No | `constructor` calls sync `_load()` (existsSync + readFileSync). Every mutating method calls sync `_save()` (mkdirSync + writeFileSync + renameSync). |
| `src/runtime/daemon-runner.ts` | 6 | Mixed | YES | `saveDaemonState()` sync (writeFileSync + renameSync), `loadDaemonState()` sync (existsSync + readFileSync), `cleanup()` sync fallback write (writeFileSync + renameSync). All async methods (start/stop/restoreState/rotateLog) use `fs/promises` — already mixed. |
| `src/runtime/event-server.ts` | 6 | No (private sync callback) | YES | `startFileWatcher()` uses `mkdirSync` + watcher callback with `existsSync`, `statSync`, `readFileSync`, `mkdirSync`, `renameSync`. Watcher callback `processEventFile()` is sync (event-driven, can't easily be async). |
| `src/runtime/pid-manager.ts` | 4 | No (all sync) | YES | `writePID()`: `writeJsonFileSync` + `renameSync`. `readPID()`: existsSync + `readJsonFileSync`. `cleanup()`: existsSync + unlinkSync. All sync. |
| `src/llm/provider-config.ts` | 5 | No (sync functions) | No | `loadProviderConfig()` and `saveProviderConfig()` are sync (existsSync + readFileSync + writeFileSync + mkdirSync). Called at CLI startup and in tests. |
| `src/llm/codex-llm-client.ts` | 4 | Mixed (inside Promise callback) | No | `mkdtempSync` inside Promise constructor (sync, required for temp dir before spawn). `readFileSync` to read temp output after child closes. `existsSync` + `unlinkSync` + `rmdirSync` in `_cleanupTmp()`. These are inside a `new Promise()` — cannot trivially be async. |
| `src/strategy/strategy-template-registry.ts` | 5 | Mixed | No | `save()` is `async` but uses `mkdirSync` + `writeFileSync` + `renameSync`. `load()` is `async` but uses `existsSync` + `readFileSync`. Easy migration: swap to `fsp.*`. |
| `src/knowledge/memory-index.ts` | 3 | No (sync functions) | Indirect | `initializeIndex()`: existsSync + mkdirSync. `saveIndex()`: mkdirSync. Both sync, called from memory-lifecycle and memory-compression. |
| `src/reporting-engine.ts` | 4 | No (sync methods) | No | `listReports()` and `_loadReportsFromAbsDir()` are sync methods using existsSync + readdirSync. |
| `src/cli/commands/goal-utils.ts` | 4 | No (sync functions) | No | `writeJsonFileSync` in auto-registration helpers. existsSync to check dir. |
| `src/cli/commands/goal.ts` | 6 | Mixed (async fn, sync calls) | No | Calls `readJsonFileSync`, `existsSync`, `readdirSync` inside async CLI command handlers. Easy migration. |
| `src/cli/commands/config.ts` | 6 | Mixed (async fn, sync calls) | No | `readJsonFileSync`, `writeJsonFileSync`, `existsSync` inside sync CLI command handlers (`cmdProvider`, etc.). |
| `src/cli/setup.ts` | 2 | No (sync function `buildDeps`) | No | `existsSync` + `readdirSync` in `buildDeps()` to load datasource configs. `buildDeps` is sync. |
| `src/observation/data-source-adapter.ts` | 3 | Mixed | No | `connect()` and `query()` are async but call `existsSync` and `readFileSync` synchronously inside. |
| `src/execution/task-prompt-builder.ts` | 2 | No (sync fn) | No | Imports `_fs` and `_path` but the grep count suggests 2 occurrences — likely from import only (function uses `stateManager.loadGoal()` not direct fs). Verify: may be 0 actual calls. |
| `src/adapters/file-existence-datasource.ts` | 1 | Mixed (async query method) | No | `existsSync` inside async `query()`. Easy: swap to `fsp.access()`. |
| `src/utils/json-io.ts` | 2 | Both (explicit sync + async versions) | No | Provides both `readJsonFileSync`/`writeJsonFileSync` (sync) and `readJsonFile`/`writeJsonFile` (async). It IS the migration helper — async versions already exist. |

---

## Hot Path Summary

Files called directly during `CoreLoop.run()` or `DaemonRunner.runLoop()`:

**Critical hot path** (called every loop iteration):
- `src/state-manager.ts` — all sync, massive refactor needed
- `src/drive/drive-system.ts` — all sync, called for every goal activation check
- `src/runtime/daemon-runner.ts` — mixed, sync paths are in `saveDaemonState()` and `cleanup()`
- `src/runtime/logger.ts` — sync by design (append-only); changing this is controversial
- `src/runtime/event-server.ts` — watcher callback must be sync (Node.js fs.watch callback)
- `src/runtime/pid-manager.ts` — called at daemon start/stop only, not inner loop

---

## Tricky Cases

### 1. Constructors / top-level initialization (hardest to migrate)
- `StateManager.constructor` → `ensureDirectories()` uses `mkdirSync` × 8
- `DriveSystem.constructor` → `ensureDirectories()` uses `mkdirSync` × 3
- `KnowledgeGraph.constructor` → `load()` uses `existsSync` + `readFileSync`
- `VectorIndex.constructor` → `_load()` uses `existsSync` + `readFileSync`
- `Logger.constructor` → `mkdirSync` (ensure log dir exists)
- **Resolution**: Convert constructors to sync-safe (keep mkdirSync in constructors, migrate reads/writes in methods). Or add async `init()` factory pattern.

### 2. Watcher callbacks (can't be async)
- `DriveSystem.startWatcher()` watcher callback uses `readFileSync` — this is intentional: `fs.watch` callbacks cannot be async. Must stay sync or use a different pattern (read via `fsp.readFile` + queue).
- `EventServer.processEventFile()` is sync callback called from `fs.watch` — same constraint.

### 3. Logger (hot path, sync by design)
- `appendFileSync` is the correct API for log appending: atomic under single-threaded Node.js, lower overhead than async for high-frequency writes. **Recommend: do NOT migrate Logger.**

### 4. `memory-persistence.ts` is a sync utility library
- `atomicWrite` and `readJsonFile` here are consumed by 4+ modules. Migrating these to async would require migrating all callers simultaneously.

### 5. `codex-llm-client.ts` `_spawnCodex()`
- `mkdtempSync` inside a `new Promise()` constructor — sync is required here because temp dir must exist before `spawn()` is called. Keep sync.
- `readFileSync` after child close and `_cleanupTmp()` are inside the `close` event callback — can be replaced with `fsp.*` since it's not a constructor.

### 6. `strategy-template-registry.ts` methods declared async but use sync fs
- `save()` and `load()` are `async` but use `fs.*` sync. Easy wins: just swap calls to `fsp.*`.

### 7. `task-prompt-builder.ts`
- Imports `_fs` and `_path` but they appear unused in the visible code (2 grep hits = likely just imports). Verify before migration.

---

## Recommended Migration Batches

### Batch A — Easy wins (async methods already, just swap calls) [~3 files]
1. `src/strategy/strategy-template-registry.ts` — `save()` and `load()` are async, swap to `fsp.*`
2. `src/adapters/file-existence-datasource.ts` — `query()` is async, `existsSync` → `fsp.access()`
3. `src/observation/data-source-adapter.ts` — `connect()` and `query()` are async, swap calls

### Batch B — CLI commands (async handlers, sync calls) [~4 files]
4. `src/cli/commands/goal.ts`
5. `src/cli/commands/config.ts`
6. `src/cli/commands/goal-utils.ts`
7. `src/cli/setup.ts` — needs `buildDeps()` to become async or use top-level await

### Batch C — Knowledge subsystem (no hot path, cohesive module) [~4 files]
8. `src/knowledge/memory-persistence.ts` — core utility; migrating this cascades to all consumers
9. `src/knowledge/memory-index.ts`
10. `src/knowledge/memory-compression.ts`
11. `src/knowledge/memory-lifecycle.ts`

### Batch D — Graph/index classes with sync constructor loads [~2 files]
12. `src/knowledge/knowledge-graph.ts` — add `async load()` factory or keep constructor sync `_load`
13. `src/knowledge/vector-index.ts` — same pattern

### Batch E — Config and reporting (low risk, isolated) [~3 files]
14. `src/llm/provider-config.ts`
15. `src/reporting-engine.ts`
16. `src/execution/task-prompt-builder.ts` (verify actual usage first)

### Batch F — Runtime (hot path, risky) [~3 files, needs careful design]
17. `src/runtime/daemon-runner.ts` — `saveDaemonState()` and `loadDaemonState()` can become async; `cleanup()` sync fallback can be converted to `writeShutdownMarker()` call (already async)
18. `src/runtime/pid-manager.ts` — all methods can become async
19. `src/runtime/event-server.ts` — watcher callback cannot be async; keep `processEventFile()` sync OR refactor to fire-and-forget queue

### Batch G — Core classes (breaking change, most tests affected) [do last]
20. `src/state-manager.ts` — massive scope; all 30+ public methods change signature; every caller must await
21. `src/drive/drive-system.ts` — depends on StateManager; migrate together

### Do NOT migrate
- `src/runtime/logger.ts` — `appendFileSync` is correct for log files; async logging would require buffering and is not worth the complexity
- `fs.watch` callbacks in `DriveSystem` and `EventServer` — Node.js constraint, cannot be async

---

## Key Insight: json-io.ts as Migration Enabler

`src/utils/json-io.ts` already provides async versions (`readJsonFile`, `writeJsonFile`). Many files that use `readJsonFileSync`/`writeJsonFileSync` (pid-manager, cli/setup, cli/commands/config, cli/commands/goal) can simply switch to the async versions already exported from this file. No new code needed for JSON read/write — just change callers to `await`.
