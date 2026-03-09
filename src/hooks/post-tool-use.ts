import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { SatisficingEngine } from '../engines/satisficing.js';
import { StallDetectionEngine } from '../engines/stall-detection.js';
import type { Goal, StateVectorElement } from '../state/models.js';

export interface PostToolUseInput {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
}

export interface PostToolUseResult {
  goalsUpdated: number;
  goalsCompleted: string[];
  stallResetsApplied: string[];
}

// Error-like patterns in tool output
const ERROR_PATTERNS = [
  /error/i,
  /exception/i,
  /failed/i,
  /failure/i,
  /fatal/i,
  /panic/i,
  /traceback/i,
];

function hasErrorOutput(output: string): boolean {
  return ERROR_PATTERNS.some(p => p.test(output));
}

// Heuristics: return a partial state vector update based on tool type and output
function deriveStateUpdates(
  input: PostToolUseInput,
): Record<string, Partial<StateVectorElement>> {
  const updates: Record<string, Partial<StateVectorElement>> = {};
  const output = input.tool_output ?? '';
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const now = new Date().toISOString();

  const hasError = hasErrorOutput(output);

  // Bash + test command → update quality_score
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    if (/\btest\b|jest|vitest|pytest|mocha|rspec|go test/i.test(command)) {
      // Detect test pass/fail from common test runner output patterns.
      //
      // Positive signals (test suite passed):
      //   "15 passed, 0 failed" / "Tests: 15 passed" / "PASSED" / "All tests pass"
      // Negative signals (test suite failed — at least 1 failure):
      //   "2 failed" / "FAILED" / "AssertionError" / "Error:" (but NOT "0 failed")
      //
      // Strategy: first look for an explicit non-zero failure count, then look
      // for failure keywords not preceded by "0 "; if neither matches, check for
      // any pass indicator.
      // Non-zero failure: "2 failed", "failed: 3", exact "FAILED", "AssertionError"
      // Note: we deliberately avoid /i flag on "FAILED" to not match "0 failed".
      const nonZeroFail =
        /[1-9]\d*\s+failed/i.test(output) ||
        /failed:\s*[1-9]/i.test(output) ||
        /\bFAILED\b/.test(output) ||
        /AssertionError/i.test(output);
      const anyPassIndicator = /\bpassed\b|PASSED|all tests pass|\bok\b/i.test(output);
      const passed = !nonZeroFail && anyPassIndicator;
      updates['quality_score'] = {
        value: passed ? 1.0 : 0.0,
        confidence: 0.9,
        observed_at: now,
        source: 'tool_output',
        observation_method: 'test_runner_output',
      };
    }
  }

  // Write / Edit → increment progress slightly (0.05 bump, capped at goal's target)
  if (toolName === 'Write' || toolName === 'Edit') {
    updates['progress'] = {
      // sentinel: merge with existing value in the caller
      value: 0.05,
      confidence: 0.6,
      observed_at: now,
      source: 'tool_output',
      observation_method: 'file_write_heuristic',
    };
  }

  // Any tool with error output → note in state
  if (hasError) {
    updates['last_error'] = {
      value: -1,
      confidence: 0.8,
      observed_at: now,
      source: 'tool_output',
      observation_method: 'error_pattern_match',
    };
  }

  return updates;
}

// Merge derived updates into the goal's state_vector.
// For 'progress', adds to existing value instead of replacing, and preserves
// the higher confidence (don't downgrade a high-confidence existing observation
// with a heuristic patch that has lower confidence).
function applyStateUpdates(
  goal: Goal,
  updates: Record<string, Partial<StateVectorElement>>,
): void {
  for (const [dim, patch] of Object.entries(updates)) {
    const existing = goal.state_vector[dim];

    if (dim === 'progress' && existing) {
      // Additive bump: clamp to [0, 1]. Preserve the higher confidence.
      goal.state_vector[dim] = {
        ...existing,
        observed_at: patch.observed_at ?? new Date().toISOString(),
        source: patch.source ?? existing.source,
        observation_method: patch.observation_method ?? existing.observation_method,
        confidence: Math.max(existing.confidence, patch.confidence ?? 0),
        value: Math.min(1.0, existing.value + (patch.value ?? 0)),
      };
    } else if (existing) {
      goal.state_vector[dim] = { ...existing, ...patch };
    } else {
      // New dimension — fill required fields with defaults
      goal.state_vector[dim] = {
        value: patch.value ?? 0,
        confidence: patch.confidence ?? 0.5,
        observed_at: patch.observed_at ?? new Date().toISOString(),
        source: patch.source ?? 'tool_output',
        observation_method: patch.observation_method ?? '',
      };
    }
  }
}

export async function processPostToolUse(
  input: PostToolUseInput,
  projectRoot?: string,
): Promise<PostToolUseResult> {
  const root = projectRoot ?? process.cwd();
  const manager = new StateManager(root);
  const state = manager.loadState();

  const gapEngine = new GapAnalysisEngine();
  const satisficingEngine = new SatisficingEngine();
  const stallEngine = new StallDetectionEngine();

  // Seed stall engine from persisted stall state
  for (const [tool, count] of Object.entries(state.stall_state.consecutive_failures)) {
    for (let i = 0; i < count; i++) {
      stallEngine.onFailure(tool);
    }
  }

  const stateUpdates = deriveStateUpdates(input);
  const hasError = hasErrorOutput(input.tool_output ?? '');

  const goals = manager.loadActiveGoals();
  const goalsCompleted: string[] = [];
  const stallResetsApplied: string[] = [];

  for (const goal of goals) {
    // Apply heuristic state updates
    applyStateUpdates(goal, stateUpdates);

    // Recompute gaps
    goal.gaps = gapEngine.computeGaps(goal);

    // Check completion
    const judgment = satisficingEngine.judgeCompletion(goal.gaps);
    if (judgment.status === 'completed') {
      goal.status = 'completed';
      goalsCompleted.push(goal.id);

      // Remove from active list
      state.active_goal_ids = state.active_goal_ids.filter(id => id !== goal.id);
    }

    manager.saveGoal(goal);
  }

  // On success (no error), reset stall counters for this tool
  if (!hasError) {
    stallEngine.onSuccess(input.tool_name);
    state.stall_state.consecutive_failures[input.tool_name] = 0;
    stallResetsApplied.push(input.tool_name);
  }

  // Persist updated stall state
  // (failure side is managed in post-tool-failure; here we only clear on success)
  manager.saveState(state);

  // Log action
  manager.appendLog({
    event: 'post_tool_use',
    tool_name: input.tool_name,
    has_error: hasError,
    goals_updated: goals.map(g => g.id),
    goals_completed: goalsCompleted,
    stall_resets: stallResetsApplied,
    timestamp: new Date().toISOString(),
  });

  return {
    goalsUpdated: goals.length,
    goalsCompleted,
    stallResetsApplied,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: PostToolUseInput = { tool_name: 'Unknown' };
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput) as PostToolUseInput;
    } catch {
      // Unparseable stdin — use defaults
    }
  }

  await processPostToolUse(input);
  process.exit(0);
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('post-tool-use.ts') ||
    process.argv[1].endsWith('post-tool-use.js'))
) {
  main().catch(() => process.exit(1));
}
