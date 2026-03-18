# Batch G — StateManager Async Migration Analysis

Generated: 2026-03-18
Issue: #54 Phase 2, Batch G

---

## Context

`src/utils/json-io.ts` provides the async helpers available for reuse:
- `readJsonFile<T>(path): Promise<T>` — async read + JSON.parse (throws on ENOENT)
- `writeJsonFile(path, data): Promise<void>` — async JSON write

Note: `readJsonFile` from json-io **throws** on ENOENT; StateManager's internal `readJsonFile` **catches** ENOENT and returns null. The internal private method must be replaced with a `try/catch` around `fsp.readFile`, not the json-io helper directly.

`StateManager` also has its own internal `readJsonFile<T>` private method (lines 77–93) which shadows the util. This private method will become `private async readJsonFile<T>(): Promise<T | null>`.

---

## 1. `src/state-manager.ts`

**570 lines** — the most impactful migration file. Every other layer of the system depends on it.

**Test file:** `tests/state-manager.test.ts`

---

### 1.1 Complete Sync fs Call Inventory

| Line | Call | Private method / context | Action |
|------|------|--------------------------|--------|
| 59 | `fs.mkdirSync(dir, { recursive: true })` | `ensureDirectories()` — loop over 8 dirs | Migrate |
| 65 | `fs.mkdirSync(dir, { recursive: true })` | `goalDir()` — create per-goal dir | Migrate |
| 73 | `fs.writeFileSync(tmpPath, ...)` | `atomicWrite()` — write .tmp | Migrate |
| 74 | `fs.renameSync(tmpPath, filePath)` | `atomicWrite()` — rename to final | Migrate |
| 80 | `fs.readFileSync(filePath, "utf-8")` | `readJsonFile<T>()` private — read file | Migrate |
| 118 | `fs.existsSync(dir)` | `deleteGoal()` — guard before rmSync | Migrate |
| 119 | `fs.rmSync(dir, { recursive: true, force: true })` | `deleteGoal()` — remove dir | Migrate |
| 138 | `fs.existsSync(goalDir)` | `archiveGoal()` — guard before archive | Migrate |
| 141 | `fs.mkdirSync(archiveBase, { recursive: true })` | `archiveGoal()` — create archive base | Migrate |
| 145 | `fs.cpSync(goalDir, archiveGoalDir, { recursive: true })` | `archiveGoal()` — copy goal dir | Migrate |
| 146 | `fs.rmSync(goalDir, { recursive: true, force: true })` | `archiveGoal()` — remove original | Migrate |
| 150 | `fs.existsSync(tasksDir)` | `archiveGoal()` — guard tasks | Migrate |
| 152 | `fs.cpSync(tasksDir, archiveTasksDir, { recursive: true })` | `archiveGoal()` — copy tasks | Migrate |
| 153 | `fs.rmSync(tasksDir, { recursive: true, force: true })` | `archiveGoal()` — remove tasks | Migrate |
| 158 | `fs.existsSync(strategiesDir)` | `archiveGoal()` — guard strategies | Migrate |
| 160 | `fs.cpSync(strategiesDir, archiveStrategiesDir, { recursive: true })` | `archiveGoal()` — copy strategies | Migrate |
| 161 | `fs.rmSync(strategiesDir, { recursive: true, force: true })` | `archiveGoal()` — remove strategies | Migrate |
| 166 | `fs.existsSync(stallsFile)` | `archiveGoal()` — guard stalls | Migrate |
| 168 | `fs.cpSync(stallsFile, archiveStallsFile)` | `archiveGoal()` — copy stalls file | Migrate |
| 169 | `fs.rmSync(stallsFile, { force: true })` | `archiveGoal()` — remove stalls | Migrate |
| 174 | `fs.existsSync(reportsDir)` | `archiveGoal()` — guard reports | Migrate |
| 176 | `fs.cpSync(reportsDir, archiveReportsDir, { recursive: true })` | `archiveGoal()` — copy reports | Migrate |
| 177 | `fs.rmSync(reportsDir, { recursive: true, force: true })` | `archiveGoal()` — remove reports | Migrate |
| 188 | `fs.existsSync(archiveDir)` | `listArchivedGoals()` — guard before readdir | Migrate |
| 189–191 | `fs.readdirSync(archiveDir, { withFileTypes: true })` | `listArchivedGoals()` — list dirs | Migrate |
| 197 | `fs.existsSync(goalsDir)` | `listGoalIds()` — guard before readdir | Migrate |
| 198–201 | `fs.readdirSync(goalsDir, { withFileTypes: true })` | `listGoalIds()` — list dirs | Migrate |
| 225 | `fs.existsSync(filePath)` | `deleteGoalTree()` — guard before unlink | Migrate |
| 226 | `fs.unlinkSync(filePath)` | `deleteGoalTree()` — remove file | Migrate |
| 552–554 | `fs.existsSync(...)` | `goalExists()` — check file exists | Migrate |
| 567 | `fs.mkdirSync(dir, { recursive: true })` | `writeRaw()` — ensure dir | Migrate |

**Total: ~31 sync calls, all migratable.** None are inside `fs.watch` callbacks or other sync-only contexts.

---

### 1.2 Public Method Groups

#### Private helpers that must become async

| Method | Current signature | New signature | Notes |
|--------|------------------|---------------|-------|
| `ensureDirectories()` | `private void` | `private async ensureDirectories(): Promise<void>` | Called from constructor — see § Constructor Problem |
| `goalDir()` | `private string` | `private async goalDir(): Promise<string>` | Called by saveGoal, saveObservationLog, saveGapHistory |
| `atomicWrite()` | `private void` | `private async atomicWrite(): Promise<void>` | Called by saveGoal, saveGoalTree, saveObservationLog, saveGapHistory, writeRaw |
| `readJsonFile<T>()` (private) | `private T \| null` | `private async readJsonFile<T>(): Promise<T \| null>` | Called by loadGoal, loadObservationLog, loadGapHistory, loadGoalTree, readRaw |

#### Constructor Problem

`ensureDirectories()` is called from the constructor (`this.ensureDirectories()` at line 36). Constructors cannot be `async`. Two options:

**Option A (preferred — lazy init):** Remove `this.ensureDirectories()` from constructor. Add a static `async create(...)` factory method, or make `ensureDirectories()` a no-op and call it lazily inside the first write call. However, this is a significant API change as all code does `new StateManager(...)`.

**Option B (simplest — one-time sync call stays):** Keep `ensureDirectories()` as sync for the base dirs (it uses `mkdirSync` with `{ recursive: true }` which is safe at startup). Only migrate the per-goal `goalDir()` to async, and the read/write methods. This is the pragmatic approach since dir creation at startup is a one-time O(1) cost.

**Option C:** Convert all uses of `new StateManager(...)` to `await StateManager.create(...)` — this is a very large refactor touching all 62 files that import StateManager.

**Recommendation: Option B.** Keep `ensureDirectories()` and `goalDir()` sync, only migrate the IO-heavy read/write paths. This is consistent with the pattern used in Batch F (event-server.ts kept `startFileWatcher` sync, moved mkdir to `start()`).

Under Option B, the remaining sync calls in these two methods are **acceptable** since they are startup/directory-setup operations that are fast, non-blocking on modern filesystems, and used at process start.

#### Public methods that must become async

| Method | Current signature | New signature | Reason |
|--------|------------------|---------------|--------|
| `saveGoal(goal)` | `void` | `async saveGoal(): Promise<void>` | calls `goalDir()` (async) + `atomicWrite()` (async) |
| `loadGoal(goalId)` | `Goal \| null` | `async loadGoal(): Promise<Goal \| null>` | calls `readJsonFile<>()` (async) |
| `deleteGoal(goalId)` | `boolean` | `async deleteGoal(): Promise<boolean>` | calls `existsSync` + `rmSync` |
| `archiveGoal(goalId)` | `boolean` | `async archiveGoal(): Promise<boolean>` | 12 sync calls |
| `listArchivedGoals()` | `string[]` | `async listArchivedGoals(): Promise<string[]>` | `existsSync` + `readdirSync` |
| `listGoalIds()` | `string[]` | `async listGoalIds(): Promise<string[]>` | `existsSync` + `readdirSync` |
| `saveGoalTree(tree)` | `void` | `async saveGoalTree(): Promise<void>` | calls `atomicWrite()` |
| `loadGoalTree(rootId)` | `GoalTree \| null` | `async loadGoalTree(): Promise<GoalTree \| null>` | calls `readJsonFile<>()` |
| `deleteGoalTree(rootId)` | `boolean` | `async deleteGoalTree(): Promise<boolean>` | `existsSync` + `unlinkSync` |
| `saveObservationLog(log)` | `void` | `async saveObservationLog(): Promise<void>` | calls `goalDir()` + `atomicWrite()` |
| `loadObservationLog(goalId)` | `ObservationLog \| null` | `async loadObservationLog(): Promise<ObservationLog \| null>` | calls `readJsonFile<>()` |
| `appendObservation(goalId, entry)` | `void` | `async appendObservation(): Promise<void>` | calls `loadObservationLog` + `saveObservationLog` |
| `saveGapHistory(goalId, history)` | `void` | `async saveGapHistory(): Promise<void>` | calls `goalDir()` + `atomicWrite()` |
| `loadGapHistory(goalId)` | `GapHistoryEntry[]` | `async loadGapHistory(): Promise<GapHistoryEntry[]>` | calls `readJsonFile<>()` |
| `appendGapHistoryEntry(goalId, entry)` | `void` | `async appendGapHistoryEntry(): Promise<void>` | calls `loadGapHistory` + `saveGapHistory` |
| `goalExists(goalId)` | `boolean` | `async goalExists(): Promise<boolean>` | `existsSync` |
| `readRaw(relativePath)` | `unknown \| null` | `async readRaw(): Promise<unknown \| null>` | calls `readJsonFile<>()` |
| `writeRaw(relativePath, data)` | `void` | `async writeRaw(): Promise<void>` | `mkdirSync` + `atomicWrite()` |
| `getGoalTree(rootId)` | `Goal[] \| null` | `async getGoalTree(): Promise<Goal[] \| null>` | calls `loadGoal()` in BFS loop |
| `getSubtree(goalId)` | `Goal[]` | `async getSubtree(): Promise<Goal[]>` | calls `loadGoal()` in BFS loop |
| `updateGoalInTree(goalId, updates)` | `void` | `async updateGoalInTree(): Promise<void>` | calls `loadGoal` + `saveGoal` multiple times |
| `savePaceSnapshot(goalId, snap)` | `async void` (already!) | stays `async Promise<void>` | calls `loadGoal` + `saveGoal` — already async wrapper, but callee not yet async |

**Methods with NO fs calls (no signature change needed):**
- `getBaseDir()` — returns string, no IO
- `getMilestones()` — pure function, no IO
- `getOverdueMilestones()` — pure function, no IO
- `evaluatePace()` — pure function, no IO
- `generateRescheduleOptions()` — pure function (calls `evaluatePace`), no IO

---

## 2. json-io.ts helpers available

**Confirmed available** (read directly):
- `readJsonFile<T>(filePath): Promise<T>` — throws on ENOENT (note: NOT the same as StateManager's private method which returns null on ENOENT)
- `writeJsonFile(filePath, data): Promise<void>` — async write

For the private `readJsonFile<T>()` replacement in StateManager, the pattern should be:
```
try {
  const content = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw err;
}
```
(`atomicWrite` → `await fsp.writeFile(tmpPath, ...) + await fsp.rename(tmpPath, filePath)`)

---

## 3. Production File Caller Map

Total production source files calling StateManager methods that will change signature: **40+ files** (derived from grep output). Listed by domain:

### Execution layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/execution/task-lifecycle.ts` | `loadGoal` (L326) | Yes — async class |
| `src/execution/task-generation.ts` | `writeRaw` (L126) | Yes — async function |
| `src/execution/task-executor.ts` | `writeRaw` (L106, 130, 227), `readRaw` (L239) | Yes — async function |
| `src/execution/task-verifier.ts` | `readRaw` (L207, 284, 321, 642, 659), `writeRaw` (L246, 278, 302, 334, 370, 652, 680) | Yes — async function |
| `src/execution/session-manager.ts` | `readRaw` (L138, 570), `writeRaw` (L564, 581) | Yes — async class |
| `src/execution/task-prompt-builder.ts` | `loadGoal` (L21) | Yes — async function |

### Loop layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/loop/core-loop-phases.ts` | `loadGoal` (L41, 59, 100), `appendGapHistoryEntry` (L135) | Yes — async |
| `src/loop/core-loop-phases-b.ts` | `loadGoal` (L45, 356, 373), `savePaceSnapshot` (L60), `loadGapHistory` (L100) | Yes — async |
| `src/loop/tree-loop-runner.ts` | `loadGoal` (L21, 39, 66, 72) | Yes — async |
| `src/core-loop.ts` | `loadGoal` (L97, 226, 406), `saveGapHistory` (L125), `archiveGoal` (L262) | Yes — async |

### Goal layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/goal/goal-tree-manager.ts` | `loadGoal` (L271, 538, 565, 608, 640, 661), `saveGoal` (L291, 336, 443, 460, 492, 497, 524) | Yes — async class |
| `src/goal/goal-negotiator.ts` | `saveGoal` (L207, 376), `loadGoal` (L238), `readRaw` (L424), `writeRaw` (L464) | Yes — async class |
| `src/goal/goal-decomposer.ts` | `saveGoal` (L148, 170), `loadGoal` (L204) | Mixed — L148 sync call, L170 async |
| `src/goal/state-aggregator.ts` | `loadGoal` (L71, 84, 155, 166, 260, 266, 272), `saveGoal` (L224) | Yes — async class |
| `src/goal/tree-loop-orchestrator.ts` | `loadGoal` (many), `saveGoal` (many) | Yes — async class |
| `src/goal/goal-dependency-graph.ts` | `readRaw` (L360), `writeRaw` (L374) | Yes — async class |
| `src/goal/goal-tree-pruner.ts` | `loadGoal` (L20, 47, 59, 89, 101), `saveGoal` (L32, 66, 108) | Yes — async functions |

### Observation layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/observation/observation-engine.ts` | `saveObservationLog` (L188), `loadGoal` (L210, 262) | Yes — async class |
| `src/observation/observation-apply.ts` | `loadGoal` (L24), `appendObservation` (L92), `saveGoal` (L95) | Yes — async function |
| `src/observation/observation-helpers.ts` | `loadObservationLog` (L240) | Yes — async function |
| `src/observation/capability-dependencies.ts` | `readRaw` (L22), `writeRaw` (L38) | Yes — async functions |
| `src/observation/capability-registry.ts` | `readRaw` (L38), `writeRaw` (L58) | Yes — async functions |

### Drive layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/drive/drive-system.ts` | `loadGoal` (L69) in `shouldActivate()` | **NO** — `shouldActivate()` is sync `boolean` |
| `src/drive/stall-detector.ts` | `readRaw` (L300), `writeRaw` (L319) | Yes — async class |
| `src/drive/satisficing-judge.ts` | `readRaw` (L333) | Yes — async class |
| `src/drive/satisficing-propagation.ts` | `loadGoal` (L23, 45, 113), `saveGoal` (L216, 245) | Yes — async functions |

### Strategy layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/strategy/strategy-manager-base.ts` | `readRaw` (L269, 285), `writeRaw` (L317, 335), `listGoalIds` (L351) | Yes — async class |
| `src/strategy/cross-goal-portfolio.ts` | `loadGoal` (L107, 325) | Yes — async class |

### Knowledge layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/knowledge/knowledge-manager.ts` | `writeRaw` (L296, 314, 534) | Yes — async class |
| `src/knowledge/knowledge-transfer.ts` | `listGoalIds` (L129, 455), `readRaw` (L568) | Yes — async class |
| `src/knowledge/learning-pipeline.ts` | `readRaw` (L271, 565, 585), `writeRaw` (L578, 598), `listGoalIds` (L477) | Yes — async class |
| `src/knowledge/learning-feedback.ts` | `readRaw` (L28), `writeRaw` (L54) | Yes — async functions |
| `src/knowledge/knowledge-search.ts` | `readRaw` (L25, 43) | Yes — async functions |

### Traits layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/traits/trust-manager.ts` | `readRaw` (L66), `writeRaw` (L78) | Yes — async class |
| `src/traits/character-config.ts` | `readRaw` (L28), `writeRaw` (L40) | Yes — async class |
| `src/traits/ethics-gate.ts` | `readRaw` (L419), `writeRaw` (L426) | Yes — async class |
| `src/traits/curiosity-engine.ts` | `readRaw` (L119), `writeRaw` (L143) | Yes — async class |

### Portfolio layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/portfolio-manager.ts` | `readRaw` (L498, 506), `writeRaw` (L531, 547) | Yes — async class |
| `src/portfolio-rebalance.ts` | (indirect via portfolio-manager) | Yes |

### Reporting layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/reporting-engine.ts` | `writeRaw` (L324), `readRaw` (L376), `loadGoal` (L529, 539) | Yes — async class |

### CLI layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/cli/commands/goal.ts` | `deleteGoal` (L107), `loadGoal` (L173, 223, 266, 303, 386, 415), `saveGoal` (L326), `loadObservationLog` (L337), `loadGapHistory` (L338), `archiveGoal` (L398, 425), `listGoalIds` (L411, 430), `listArchivedGoals` (L185) | Mixed — most functions are async (commander handlers) |
| `src/cli/commands/goal-raw.ts` | `saveGoal` (L93) | Yes — async function |
| `src/cli/commands/run.ts` | `loadGoal` (L121) | Yes — async function |
| `src/cli/commands/report.ts` | `loadGoal` (L11) | Yes — async function |
| `src/cli/commands/suggest.ts` | `listGoalIds` (L459, 567), `loadGoal` (L462, 570) | Yes — async functions |
| `src/cli/setup.ts` | `loadGoal` (L96) | Yes — async function |
| `src/cli-runner.ts` | `deleteGoal` (L281) | Yes — async function |

### TUI layer

| File | Key calls | Already async? |
|------|-----------|----------------|
| `src/tui/actions.ts` | `listGoalIds` (L64, 100, 139, 166), `loadGoal` (L66, 83, 109, 180) | Mixed — methods are sync but in a class with async neighbors |
| `src/tui/use-loop.ts` | `loadGoal` (L172) | Mixed — inside a hook callback |

---

## 4. Critical Blocker: DriveSystem.shouldActivate()

`src/drive/drive-system.ts` L67–97: `shouldActivate(goalId: string): boolean`

This method calls `this.stateManager.loadGoal(goalId)` **synchronously** (L69). After StateManager migration, `loadGoal` returns `Promise<Goal | null>`.

**Problem:** `shouldActivate()` is called from `src/runtime/daemon-runner.ts` L297 inside `getActiveGoals()` which iterates all goal IDs. If we make it async, daemon-runner must await it (already async context — OK).

**Critical dependency:** DriveSystem's sync call surface must change SIMULTANEOUSLY with StateManager or the code will not compile:
- `shouldActivate(): boolean` → `async shouldActivate(): Promise<boolean>`
- Caller at `daemon-runner.ts` L297: `if (this.driveSystem.shouldActivate(goalId))` → `if (await this.driveSystem.shouldActivate(goalId))`

DriveSystem also has 20 of its own sync fs calls (separate from StateManager dependency). These are in:
- `ensureDirectories()` (constructor) — same constructor problem
- `atomicWrite()` — used by `writeEvent()`, `updateSchedule()`
- `readEventQueue()` — `existsSync`, `readdirSync`, `statSync`, `readFileSync`
- `processEvents()` — same pattern
- `getSchedule()` — `readFileSync`
- `updateSchedule()` — `mkdirSync` + `atomicWrite`
- `archiveEvent()` — `mkdirSync` + `renameSync`
- `writeEvent()` — `mkdirSync` + `writeFileSync` + `renameSync`
- `startWatcher()` — `mkdirSync` + `fs.watch` (callback sync calls must STAY sync)

**Answer to Task 6:** StateManager and DriveSystem CANNOT be fully decoupled. The `shouldActivate()` method must be changed at the same time as StateManager, or TypeScript will produce a compile error (calling `.then()` on `Goal | null`). However, DriveSystem's own 20 sync calls are independent of StateManager's migration — they can be done in a separate sub-batch.

**Recommended split:**
- **Batch G-1:** Migrate `state-manager.ts` + update `DriveSystem.shouldActivate()` to be async (only the one line that calls `loadGoal`) + update `daemon-runner.ts` L297 call site. This is the minimum viable unit.
- **Batch G-2:** Migrate `drive-system.ts` remaining sync calls (its own `atomicWrite`, `readEventQueue`, `processEvents`, `getSchedule`, `updateSchedule`, `writeEvent`, `archiveEvent`).

---

## 5. Test File Map

**Tests directly testing StateManager (require full async update):**
- `tests/state-manager.test.ts` — all test calls to StateManager methods must become `await`; all test functions must be `async`

**Tests for callers (likely need `await` additions wherever StateManager methods are called directly or via mocks):**

| File | Why affected |
|------|-------------|
| `tests/drive-system.test.ts` | DriveSystem.shouldActivate → now async |
| `tests/daemon-runner.test.ts` | daemon-runner awaits shouldActivate |
| `tests/core-loop.test.ts` | loadGoal, saveGapHistory, archiveGoal |
| `tests/core-loop-integration.test.ts` | same |
| `tests/core-loop-capability.test.ts` | same |
| `tests/r1-core-loop-completion.test.ts` | same |
| `tests/observation-engine.test.ts` | saveObservationLog, loadGoal |
| `tests/observation-engine-llm.test.ts` | same |
| `tests/observation-engine-context.test.ts` | same |
| `tests/observation-engine-dedup.test.ts` | same |
| `tests/observation-engine-crossvalidation.test.ts` | same |
| `tests/goal-negotiator.test.ts` | saveGoal, loadGoal, readRaw, writeRaw |
| `tests/goalNegotiator.test.ts` | same |
| `tests/unit/goalNegotiator.test.ts` | same |
| `tests/negotiate-context.test.ts` | same |
| `tests/goal-tree-manager.test.ts` | saveGoal, loadGoal |
| `tests/goal-tree-quality.test.ts` | same |
| `tests/goal-tree-concreteness.test.ts` | same |
| `tests/task-lifecycle.test.ts` | loadGoal |
| `tests/task-lifecycle-healthcheck.test.ts` | same |
| `tests/strategy-manager.test.ts` | readRaw, writeRaw, listGoalIds |
| `tests/trust-manager.test.ts` | readRaw, writeRaw |
| `tests/stall-detector.test.ts` | readRaw, writeRaw |
| `tests/satisficing-judge.test.ts` | readRaw |
| `tests/satisficing-judge-undershoot.test.ts` | same |
| `tests/session-manager.test.ts` | readRaw, writeRaw |
| `tests/session-manager-phase2.test.ts` | same |
| `tests/reporting-engine.test.ts` | writeRaw, readRaw, loadGoal |
| `tests/cli-runner.test.ts` | deleteGoal |
| `tests/cli-runner-integration.test.ts` | various |
| `tests/curiosity-engine.test.ts` | readRaw, writeRaw |
| `tests/ethics-gate.test.ts` | readRaw, writeRaw |
| `tests/portfolio-manager.test.ts` | readRaw, writeRaw |
| `tests/cross-goal-portfolio.test.ts` | loadGoal |
| `tests/cross-goal-portfolio-phase2.test.ts` | same |
| `tests/knowledge-manager.test.ts` | writeRaw |
| `tests/knowledge-transfer.test.ts` | listGoalIds, readRaw |
| `tests/learning-pipeline.test.ts` | readRaw, writeRaw, listGoalIds |
| `tests/tui/actions.test.ts` | listGoalIds, loadGoal |
| `tests/tui/use-loop.test.ts` | loadGoal |
| `tests/state-aggregator.test.ts` | loadGoal, saveGoal |
| `tests/tree-loop-orchestrator.test.ts` | loadGoal, saveGoal |
| `tests/goal-dependency-graph.test.ts` | readRaw, writeRaw |
| `tests/capability-detector.test.ts` | readRaw |

**Approximate total test files needing updates: ~45 files**

---

## 6. Summary Table

| File | Sync calls | Migrate | Must stay sync | Notes |
|------|-----------|---------|----------------|-------|
| `state-manager.ts` | ~31 | ~27 | ~4 (constructor dirs, goalDir) | Core migration |
| `drive-system.ts` | ~20 | ~17 | ~3 (fs.watch callback: readFileSync) | Batch G-2 |

---

## 7. Cascading Signature Changes

### StateManager public API that becomes async (22 methods)
1. `saveGoal(goal): void` → `async saveGoal(): Promise<void>`
2. `loadGoal(goalId): Goal | null` → `async loadGoal(): Promise<Goal | null>`
3. `deleteGoal(goalId): boolean` → `async deleteGoal(): Promise<boolean>`
4. `archiveGoal(goalId): boolean` → `async archiveGoal(): Promise<boolean>`
5. `listArchivedGoals(): string[]` → `async listArchivedGoals(): Promise<string[]>`
6. `listGoalIds(): string[]` → `async listGoalIds(): Promise<string[]>`
7. `saveGoalTree(tree): void` → `async saveGoalTree(): Promise<void>`
8. `loadGoalTree(rootId): GoalTree | null` → `async loadGoalTree(): Promise<GoalTree | null>`
9. `deleteGoalTree(rootId): boolean` → `async deleteGoalTree(): Promise<boolean>`
10. `saveObservationLog(log): void` → `async saveObservationLog(): Promise<void>`
11. `loadObservationLog(goalId): ObservationLog | null` → `async loadObservationLog(): Promise<ObservationLog | null>`
12. `appendObservation(goalId, entry): void` → `async appendObservation(): Promise<void>`
13. `saveGapHistory(goalId, history): void` → `async saveGapHistory(): Promise<void>`
14. `loadGapHistory(goalId): GapHistoryEntry[]` → `async loadGapHistory(): Promise<GapHistoryEntry[]>`
15. `appendGapHistoryEntry(goalId, entry): void` → `async appendGapHistoryEntry(): Promise<void>`
16. `goalExists(goalId): boolean` → `async goalExists(): Promise<boolean>`
17. `readRaw(rel): unknown | null` → `async readRaw(): Promise<unknown | null>`
18. `writeRaw(rel, data): void` → `async writeRaw(): Promise<void>`
19. `getGoalTree(rootId): Goal[] | null` → `async getGoalTree(): Promise<Goal[] | null>`
20. `getSubtree(goalId): Goal[]` → `async getSubtree(): Promise<Goal[]>`
21. `updateGoalInTree(goalId, updates): void` → `async updateGoalInTree(): Promise<void>`
22. `savePaceSnapshot(goalId, snap)` — already `Promise<void>` but calls now-async `loadGoal`/`saveGoal` correctly

### StateManager private helpers that become async
- `atomicWrite()` → `async atomicWrite(): Promise<void>`
- `readJsonFile<T>()` → `async readJsonFile<T>(): Promise<T | null>`
- `goalDir()` — **KEEP SYNC** under Option B (just `mkdirSync`, acceptable)
- `ensureDirectories()` — **KEEP SYNC** under Option B (constructor call, 8 mkdir calls)

### External files requiring `await` additions (Batch G-1 scope)
- `src/drive/drive-system.ts` — L69: `shouldActivate()` must become `async Promise<boolean>`
- `src/runtime/daemon-runner.ts` — L297: `await this.driveSystem.shouldActivate(goalId)`

### All other callers (~40 production files)
All other callers already operate in async contexts. They require mechanical `await` additions before each StateManager method call. No function signatures need to change in those files — just add `await`.

**Exception: `src/goal/goal-decomposer.ts` L148** — `stateManager.saveGoal(subgoal)` appears in a possibly sync path (needs verification). L170 is already `await stateManager.saveGoal(subgoal)` — this may be a bug even today.

**Exception: `src/tui/actions.ts`** — methods like `loadGoals()` may be sync despite calling StateManager. These will need to become async.

---

## 8. Recommended Implementation Order and Batch Strategy

### Why DriveSystem matters for ordering

The single call `shouldActivate()` at L69 is the only **compile-breaking** dependency. All other 40+ caller files are already async — adding `await` is mechanical and can be done in parallel.

### Recommended split into 3 workers

**Worker G-1 (state-manager.ts core — ~200 lines changed):**
- Owns: `src/state-manager.ts`
- Tasks:
  1. Add `import * as fsp from "node:fs/promises"` at top
  2. Migrate private `atomicWrite()` to async
  3. Migrate private `readJsonFile<T>()` to async
  4. Make all 22 public methods async (signature + add awaits)
  5. Keep `ensureDirectories()` and `goalDir()` sync (Option B)
- Does NOT touch any caller files

**Worker G-2 (DriveSystem interface fix — ~5 lines changed):**
- Owns: `src/drive/drive-system.ts`, `src/runtime/daemon-runner.ts`
- BLOCKED on Worker G-1 completing
- Tasks:
  1. Make `shouldActivate()` async: `async shouldActivate(): Promise<boolean>`
  2. In `daemon-runner.ts` L297: add `await`
- Note: DriveSystem's own 20 sync calls are NOT in scope here (that's Batch G-2 per the naming above — moved to a future batch)

**Worker G-3 (callers — mechanical await additions across ~40 files):**
- BLOCKED on Worker G-1 completing
- Owns: all remaining 40 production source files
- Purely mechanical: add `await` before every StateManager method call
- High file count but low complexity per change
- Can be split into sub-workers by domain if needed:
  - G-3a: `src/execution/` (5 files)
  - G-3b: `src/loop/` + `src/core-loop.ts` (5 files)
  - G-3c: `src/goal/` (8 files)
  - G-3d: `src/observation/` + `src/drive/` (6 files, excl. drive-system.ts)
  - G-3e: `src/strategy/` + `src/knowledge/` + `src/traits/` + `src/portfolio*` (12 files)
  - G-3f: `src/cli/` + `src/reporting-engine.ts` + `src/tui/` (9 files)

**Worker G-4 (tests — await additions in ~45 test files):**
- BLOCKED on Workers G-1 through G-3 completing
- Owns: all test files for StateManager callers
- `tests/state-manager.test.ts` is the priority (direct tests of the migrated class)
- Add `await` to all StateManager method calls in tests + ensure test functions are `async`

### Sequencing diagram

```
G-1 (state-manager.ts)
  ↓
  ├── G-2 (drive-system shouldActivate + daemon-runner L297)
  └── G-3a-f (parallel: await in 40 caller files)
        ↓
        G-4 (45 test files)
```

---

**Confidence: Confirmed** — based on direct reads of `src/state-manager.ts` (all 570 lines), `src/drive/drive-system.ts` (all 370 lines), `src/utils/json-io.ts`, and grep across all 62 production files and 75 test files that reference StateManager.
