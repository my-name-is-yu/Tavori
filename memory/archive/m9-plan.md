# M9 Implementation Plan — Observation Accuracy

**Background**: M8 dogfooding revealed LLM observation hallucination (reported todo_count=0 when 3 remained).
M9 fixes observation accuracy through shell-based mechanical observation, cross-validation, prompt improvements, and dedup fixes.

**Target file**: `src/observation-engine.ts` (primary), plus new adapters and test files.

---

## Overview

| Sub-milestone | Focus | Effort |
|---|---|---|
| 9.1 | Shell command DataSourceAdapter (grep/wc/vitest) | New file + tests |
| 9.2 | Cross-validation: mechanical vs LLM divergence detection | observation-engine.ts extension |
| 9.3 | LLM prompt improvement (few-shot, calibration, file-read instruction) | observation-engine.ts edit |
| 9.4 | Dimension key `_2` suffix dedup | observation-engine.ts + types fix |

**Implementation order**: 9.4 → 9.1 → 9.2 → 9.3
(9.4 is a runtime bug that could corrupt other results; fix first. 9.1 provides mechanical layer; 9.2 depends on both mechanical and LLM layers coexisting; 9.3 is prompt-only and can run last.)

---

## 9.4 — Dimension Key `_2` Suffix Dedup

### Problem

When the LLM returns a JSON observation response, duplicate dimension keys are sometimes emitted (e.g., `todo_count` and `todo_count_2`). The `_2` variant lands in `applyObservation` and throws `dimension not found` because no dimension is named `todo_count_2`.

### Files to Modify

- `src/observation-engine.ts` — sanitize dimension name before lookup in `applyObservation()`

### Logic (pseudocode)

```
// In applyObservation(), before findIndex:
private normalizeDimensionName(name: string): string {
  // Strip trailing _2, _3, ... _N suffixes introduced by LLM dedup
  // WARNING: avoid stripping if dimension names legitimately end in _N.
  // Log a warning when stripping occurs so the upstream bug is surfaced.
  const stripped = name.replace(/_\d+$/, "");
  if (stripped !== name) {
    console.warn(`[ObservationEngine] normalizeDimensionName: stripped "${name}" → "${stripped}"`);
  }
  return stripped;
}
```

Call site in `applyObservation()`:
```typescript
const safeName = this.normalizeDimensionName(entry.dimension_name);
const dimIndex = goal.dimensions.findIndex((d) => d.name === safeName);
```

**Root cause investigation note (for worker)**:
- grep `_2` in `src/` to find where the suffix is introduced.
- Check if `StateManager.saveGoal` or `GoalNegotiator` ever creates duplicate dimension names.
- The `normalizeDimensionName` guard is defensive; the real fix is upstream goal creation preventing duplicate dimension names.

### Test file

`tests/observation-engine-dedup.test.ts`

Key test cases:
1. `applyObservation` with `dimension_name: "todo_count_2"` succeeds when goal has dimension `todo_count`.
2. `applyObservation` with `dimension_name: "quality_3"` succeeds when goal has dimension `quality`.
3. `applyObservation` with a truly unknown dimension (no matching stripped name) still throws.
4. `normalizeDimensionName("coverage_2")` returns `"coverage"`.
5. `normalizeDimensionName("step_count")` returns `"step_count"` (no false strip).

### Dependencies

None — pure bug fix, no new interfaces needed.

---

## 9.1 — Shell Command DataSourceAdapter

### Problem

Mechanical observation (Layer 1, confidence 0.85–1.0) is underused. The existing `FileDataSourceAdapter` only reads file content; it cannot run shell commands. For code-quality goals, the most reliable count observations require:

- `grep -c <pattern> <file>` — count occurrences (todo_count, warning_count)
- `wc -l <file>` — line count
- `npx vitest run --reporter=json` — test pass/fail counts
- existence checks returning 0/1

### Files to Create

- `src/adapters/shell-datasource.ts` — `ShellDataSourceAdapter`

### Files to Modify

- `src/types/data-source.ts` — add `commands` field to `DataSourceConnectionSchema`

### Security note

**Do not use `exec()` or `execSync()`** (shell injection risk). Use `execFile` from `child_process` with a pre-split argv array. The command spec stored in config must be an array `[executable, ...args]`, never a raw shell string. If `src/utils/execFileNoThrow.ts` is created as a shared utility, `ShellDataSourceAdapter` should import and use it.

### Interface

```typescript
// src/adapters/shell-datasource.ts

import { execFile } from "child_process";
import { promisify } from "util";
import type { IDataSourceAdapter } from "../data-source-adapter.js";
import type { DataSourceConfig, DataSourceQuery, DataSourceResult } from "../types/data-source.js";

const execFileAsync = promisify(execFile);

export interface ShellCommandSpec {
  // Executable + arguments as separate array items (NO shell string — prevents injection)
  argv: string[];                     // e.g. ["grep", "-rc", "TODO", "src/"]
  output_type: "number" | "boolean" | "raw";
  cwd?: string;                       // working directory (default: process.cwd())
  timeout_ms?: number;               // default: 15000
}

// config.connection.commands: Record<string, ShellCommandSpec>
// dimension_name → ShellCommandSpec for that dimension

export class ShellDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "file" as const;
  readonly config: DataSourceConfig;

  constructor(config: DataSourceConfig) { ... }

  async connect(): Promise<void> {
    // Verify each command's executable is accessible (optional, log warning if not)
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    // 1. Resolve ShellCommandSpec for params.dimension_name
    //    - Look in config.connection.commands[params.dimension_name]
    //    - Throw if not found
    // 2. Execute: await execFileAsync(argv[0], argv.slice(1), { cwd, timeout })
    // 3. Parse stdout:
    //    - "number": parseFloat(stdout.trim()); throw if NaN
    //    - "boolean": stdout.trim() === "1" || stdout.trim().toLowerCase() === "true"
    //    - "raw": stdout.trim()
    // 4. Return DataSourceResult { value, raw: stdout, timestamp, source_id }
  }

  async disconnect(): Promise<void> { /* no-op */ }

  async healthCheck(): Promise<boolean> {
    // Run ["echo", "1"] to verify execFile is functional
  }

  getSupportedDimensions(): string[] {
    const cmds = (this.config.connection as Record<string, unknown>).commands;
    if (!cmds || typeof cmds !== "object") return [];
    return Object.keys(cmds as Record<string, unknown>);
  }
}
```

### DataSourceConfig extension

In `src/types/data-source.ts`, add to `DataSourceConnectionSchema`:

```typescript
commands: z.record(z.string(), z.unknown()).optional(),
// Each value is a ShellCommandSpec (validated at runtime by ShellDataSourceAdapter)
```

This is a backward-compatible addition (`.optional()`).

### Pre-built dimension patterns (documented as JSDoc examples)

| Dimension | argv | output_type |
|---|---|---|
| `test_pass_count` | `["node", "-e", "...vitest json parse..."]` | number |
| `file_exists` | `["test", "-f", "/path/to/file"]` (exit 0/1) | boolean |
| `line_count` | `["wc", "-l", "src/index.ts"]` | number |

Note: `grep` with `-c` returns exit 1 when count=0, which `execFile` treats as an error. Use a wrapper script or `grep ... | wc -l` via a shell script file to avoid this. Since we avoid `exec()`, use `["sh", "/path/to/count-todos.sh"]` with a pre-authored script, or handle exit code 1 as a valid "0 matches" result.

### Test file

`tests/adapters/shell-datasource.test.ts`

Key test cases:
1. `query` with `argv: ["echo", "42"]`, output_type `"number"` → returns value `42`.
2. `query` with `argv: ["echo", "1"]`, output_type `"boolean"` → returns `true`.
3. `query` with `argv: ["false"]` (non-zero exit) → throws with error message.
4. `query` with `timeout_ms: 1` and `argv: ["sleep", "2"]` → throws timeout error.
5. `getSupportedDimensions()` returns keys from `config.connection.commands`.
6. `healthCheck()` returns `true` in normal environment.
7. Integration: `ObservationEngine.observe()` with `ShellDataSourceAdapter` registered produces a `mechanical` layer entry with confidence >= 0.85.

### Dependencies

- Node.js built-in `child_process.execFile` (promisified) — no new npm deps.
- `DataSourceConfig` type extension in `src/types/data-source.ts`.

---

## 9.2 — Cross-Validation (Mechanical vs LLM Divergence)

### Problem

When both a `ShellDataSourceAdapter` (mechanical) and LLM observation are run for the same dimension, divergent results should be logged and the LLM confidence should be downgraded. Currently the fallback chain stops at the first success (DataSource), so LLM is never run if mechanical succeeds. Cross-validation requires running both and comparing.

### Files to Modify

- `src/observation-engine.ts` — add `crossValidate()` method; extend `observe()` with opt-in cross-validation mode via constructor options.

### New type (internal, no Zod schema needed)

```typescript
interface CrossValidationResult {
  dimensionName: string;
  mechanicalValue: number | string | boolean | null;
  mechanicalConfidence: number;
  llmValue: number | string | boolean | null;
  llmConfidence: number;
  diverged: boolean;
  divergenceRatio: number;   // abs(mech - llm) / max(abs(mech), abs(llm), 1)
  resolution: "mechanical_wins" | "downgraded";
}
```

### New method: `crossValidate()`

```typescript
crossValidate(
  dimensionName: string,
  mechanicalEntry: ObservationLogEntry,
  llmEntry: ObservationLogEntry,
  divergenceThreshold: number = 0.20  // 20% relative difference triggers divergence
): CrossValidationResult
```

Logic:
```
1. If both values are numeric:
   ratio = abs(mechanical - llm) / max(abs(mechanical), abs(llm), 1)
   diverged = ratio > divergenceThreshold

2. If either is non-numeric (boolean/string):
   diverged = (mechanicalValue !== llmValue)
   ratio = diverged ? 1.0 : 0.0

3. If diverged:
   Log warning (see format below)
   resolution = "mechanical_wins"   // mechanical entry already applied via applyObservation

4. If not diverged:
   resolution = "mechanical_wins"   // corroborated; LLM not applied
```

The LLM entry is never written to goal state when cross-validation is active — it is only used as a comparison signal. The mechanical entry is written first (in `observe()` before `crossValidate()` is called).

### Constructor options extension

```typescript
interface ObservationEngineOptions {
  crossValidationEnabled?: boolean;     // default: false
  divergenceThreshold?: number;         // default: 0.20
}

constructor(
  stateManager: StateManager,
  dataSources: IDataSourceAdapter[] = [],
  llmClient?: ILLMClient,
  contextProvider?: (goalId: string, dimensionName: string) => Promise<string>,
  options?: ObservationEngineOptions
)
```

When `crossValidationEnabled=true`, in the `observe()` loop after successful DataSource observation:
```
if (this.options.crossValidationEnabled && this.llmClient) {
  try {
    const llmEntry = await this.observeWithLLM(...)  // run LLM without applying
    this.crossValidate(dim.name, mechanicalEntry, llmEntry)
  } catch (err) {
    console.warn(`[CrossValidation] LLM call failed: ${err}`)
  }
}
continue  // always move on; mechanical result is authoritative
```

### Divergence log format

```
[CrossValidation] DIVERGED goal="${goalId}" dim="${dimensionName}"
  mechanical=${mechanicalValue} (conf=${mechanicalConfidence})
  llm=${llmValue} (conf=${llmConfidence})
  ratio=${divergenceRatio.toFixed(3)} threshold=${divergenceThreshold}
  resolution=mechanical_wins
```

Written via `console.warn` (consistent with existing engine warning pattern).

### Test file

`tests/observation-engine-crossvalidation.test.ts`

Key test cases:
1. No divergence (mechanical=5, llm=5.1, ratio≈0.02 < 0.20) → `diverged=false`, `resolution=mechanical_wins`.
2. Divergence (mechanical=5, llm=0) → `diverged=true`, `resolution=mechanical_wins`.
3. Boolean divergence (mechanical=true, llm=false) → `diverged=true`.
4. `observe()` with `crossValidationEnabled=true` calls LLM even when DataSource succeeds.
5. `observe()` with `crossValidationEnabled=false` (default) skips LLM when DataSource succeeds (existing behavior preserved).
6. Goal dimension retains mechanical value after cross-validation (LLM does not overwrite it).

### Dependencies

- 9.1 must be complete (ShellDataSourceAdapter needed as a real mechanical source to cross-validate).
- `ILLMClient` already injected into `ObservationEngine`.

---

## 9.3 — LLM Prompt Improvement

### Problem

The existing `observeWithLLM()` prompt:
- Mixes Japanese and English — creates inconsistency risk with non-Japanese LLMs.
- Has no few-shot examples showing what score=0.0 vs score=1.0 looks like.
- The absence-warning block is placed mid-prompt; recency effect means the LLM may forget it.
- Does not explicitly instruct the LLM to read the provided content line by line before scoring.

### Files to Modify

- `src/observation-engine.ts` — rewrite the prompt string inside `observeWithLLM()`

### New prompt structure

```
You are an independent observer evaluating a goal dimension.
Your task: score the dimension from 0.0 (not achieved) to 1.0 (fully achieved).

CRITICAL RULES:
1. Base your score ONLY on the evidence in the workspace content below. Do not invent or assume.
2. If no workspace content is provided, score MUST be 0.0.
3. Read every line of the provided content before scoring.
4. Return ONLY valid JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"}

Goal: ${goalDescription}
Dimension: ${dimensionLabel}
Target threshold: ${thresholdDescription}
Previous score: ${previousScore !== null ? previousScore.toFixed(2) : "none"}

=== FEW-SHOT CALIBRATION ===
Example A — evidence confirms achievement:
  Context: grep output shows 0 TODO matches in codebase
  Output: {"score": 1.0, "reason": "No TODOs found; target of 0 achieved"}

Example B — evidence shows shortfall:
  Context: grep output shows 3 matches: src/foo.ts:42: TODO: fix this
  Output: {"score": 0.0, "reason": "3 TODOs remain; target is 0"}

Example C — no content provided:
  Context: (empty)
  Output: {"score": 0.0, "reason": "No evidence available; cannot confirm achievement"}
=== END CALIBRATION ===

${contextSection || "WARNING: No workspace content was provided. Score MUST be 0.0 per Rule 2."}

Score the dimension now based strictly on the above content.
```

### Changes to `observeWithLLM()` signature

No signature change. Internal prompt string replacement only.

Key improvements over current prompt:
1. All-English (eliminates Japanese/English mixing).
2. Three few-shot calibration examples covering score=1.0, score=0.0, and absent evidence.
3. Explicit "read every line" instruction.
4. `WARNING` block positioned at the end of the context section (benefits from recency effect).
5. Previous score labeled `Previous score:` in English.

### Test file

`tests/observation-engine-prompt.test.ts`

Use a mock `ILLMClient` that captures the messages array passed to `sendMessage()`.

Key test cases:
1. Prompt contains `"FEW-SHOT CALIBRATION"` regardless of whether context is provided.
2. When `workspaceContext` is absent, prompt contains `"Score MUST be 0.0"`.
3. When `workspaceContext` is present, prompt contains the context content.
4. Prompt contains `previousScore` value when provided (e.g., `"Previous score: 0.75"`).
5. Prompt contains `"Previous score: none"` when previousScore is null/undefined.
6. Prompt does NOT contain Japanese characters (regex `/[\u3000-\u9FFF]/`).
7. Mock LLM returning `{"score": 0.0, "reason": "test"}` → `extracted_value = 0.0`.
8. Mock LLM returning `{"score": 1.0, "reason": "done"}` with threshold `{type:"min", value:10}` → `extracted_value = 10.0` (scale-up logic preserved).

### Dependencies

- No new imports. Purely a string change inside `observeWithLLM()`.
- Can be implemented independently of 9.1 and 9.2.

---

## Shared Interfaces

No new exported interfaces are required. The internal `CrossValidationResult` stays private to `observation-engine.ts`. The only new exported class is `ShellDataSourceAdapter` in `src/adapters/shell-datasource.ts`.

`DataSourceConfig` in `src/types/data-source.ts` needs one additive schema change:

```typescript
// In DataSourceConnectionSchema — add:
commands: z.record(z.string(), z.unknown()).optional(),
```

---

## Implementation Order (sequential)

1. **9.4** — `normalizeDimensionName` in `observation-engine.ts` + `tests/observation-engine-dedup.test.ts`
2. **9.1** — `src/adapters/shell-datasource.ts` + `src/types/data-source.ts` extension + `tests/adapters/shell-datasource.test.ts`
3. **9.2** — `crossValidate()` + constructor `options` in `observation-engine.ts` + `tests/observation-engine-crossvalidation.test.ts`
4. **9.3** — prompt rewrite in `observeWithLLM()` + `tests/observation-engine-prompt.test.ts`

Run `npx vitest run` after each step before proceeding.

---

## Files Changed Summary

| File | Action | Sub-milestone |
|---|---|---|
| `src/observation-engine.ts` | Modify (normalizeDimensionName, crossValidate, constructor options, prompt rewrite) | 9.4, 9.2, 9.3 |
| `src/adapters/shell-datasource.ts` | Create | 9.1 |
| `src/types/data-source.ts` | Modify (add `commands` field to connection schema) | 9.1 |
| `tests/observation-engine-dedup.test.ts` | Create | 9.4 |
| `tests/adapters/shell-datasource.test.ts` | Create | 9.1 |
| `tests/observation-engine-crossvalidation.test.ts` | Create | 9.2 |
| `tests/observation-engine-prompt.test.ts` | Create | 9.3 |

Total: 2 files modified, 5 files created.

---

## Risk Notes

- **9.2 cross-validation default=false**: Cross-validation doubles LLM calls per observation cycle. Enable only when `crossValidationEnabled: true` is passed explicitly (e.g., high-stakes goals or dogfooding runs).
- **9.1 shell security**: `ShellDataSourceAdapter` must use `execFile` (not `exec`/`execSync`) with a pre-split `argv` array. This prevents shell injection. Commands must be developer-authored static configs; never accept command strings from LLM output or user API input without validation. If `src/utils/execFileNoThrow.ts` is introduced as a project utility, import and use it.
- **9.3 prompt change**: Changing the prompt may shift LLM scores for existing goals. After deploying 9.3, treat prior LLM observation scores as stale and re-observe before relying on them for satisficing judgments.
- **9.4 normalizeDimensionName**: The `/_\d+$/` regex strips suffixes like `_2`. A dimension legitimately named `step_2` would be incorrectly stripped to `step`. If such dimension names exist, use a more conservative pattern or always log the strip as a warning to surface the upstream naming bug.
