import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StateManager } from '../../src/state/manager.js';
import { Goal } from '../../src/state/models.js';
import { processPostToolUse } from '../../src/hooks/post-tool-use.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `motiva-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeGoal(overrides: Partial<import('../../src/state/models.js').Goal> = {}): Goal {
  return Goal.parse({
    title: 'Test goal',
    achievement_thresholds: { progress: 0.9 },
    state_vector: {
      progress: { value: 0.5, confidence: 0.8, source: 'llm_estimate' },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Setup/Teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let manager: StateManager;

beforeEach(() => {
  tmpRoot = makeTmpDir();
  manager = new StateManager(tmpRoot);
  manager.init();
});

// ---------------------------------------------------------------------------
// State vector updates — Write / Edit
// ---------------------------------------------------------------------------

describe('post-tool-use: Write/Edit increments progress', () => {
  it('Write tool increments progress by 0.05', async () => {
    const goal = makeGoal({
      state_vector: {
        progress: { value: 0.5, confidence: 0.8, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    await processPostToolUse({ tool_name: 'Write', tool_output: 'ok' }, tmpRoot);

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['progress']?.value).toBeCloseTo(0.55, 5);
  });

  it('Edit tool increments progress by 0.05', async () => {
    const goal = makeGoal({
      state_vector: {
        progress: { value: 0.7, confidence: 0.8, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    await processPostToolUse({ tool_name: 'Edit', tool_output: '' }, tmpRoot);

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['progress']?.value).toBeCloseTo(0.75, 5);
  });

  it('progress is capped at 1.0 regardless of increments', async () => {
    const goal = makeGoal({
      state_vector: {
        progress: { value: 0.98, confidence: 0.8, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    await processPostToolUse({ tool_name: 'Write', tool_output: '' }, tmpRoot);

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['progress']?.value).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// State vector updates — Bash + test command
// ---------------------------------------------------------------------------

describe('post-tool-use: Bash + test command updates quality_score', () => {
  it('passing test output sets quality_score to 1.0', async () => {
    const goal = makeGoal();
    manager.addGoal(goal);

    await processPostToolUse(
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_output: '15 passed, 0 failed',
      },
      tmpRoot,
    );

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['quality_score']?.value).toBe(1.0);
    expect(updated.state_vector['quality_score']?.source).toBe('tool_output');
  });

  it('failing test output sets quality_score to 0.0', async () => {
    const goal = makeGoal();
    manager.addGoal(goal);

    await processPostToolUse(
      {
        tool_name: 'Bash',
        tool_input: { command: 'vitest run' },
        tool_output: '2 failed, 10 passed\nError: assertion failed',
      },
      tmpRoot,
    );

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['quality_score']?.value).toBe(0.0);
  });

  it('Bash command without "test" keyword does not update quality_score', async () => {
    const goal = makeGoal();
    manager.addGoal(goal);

    await processPostToolUse(
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_output: 'some files',
      },
      tmpRoot,
    );

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['quality_score']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error output detection
// ---------------------------------------------------------------------------

describe('post-tool-use: error output handling', () => {
  it('tool output containing "error" records last_error in state vector', async () => {
    const goal = makeGoal();
    manager.addGoal(goal);

    await processPostToolUse(
      { tool_name: 'Read', tool_output: 'Error: file not found' },
      tmpRoot,
    );

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['last_error']?.value).toBe(-1);
  });

  it('clean tool output does not add last_error to state vector', async () => {
    const goal = makeGoal();
    manager.addGoal(goal);

    await processPostToolUse(
      { tool_name: 'Read', tool_output: 'file contents here' },
      tmpRoot,
    );

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.state_vector['last_error']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap recomputation
// ---------------------------------------------------------------------------

describe('post-tool-use: gap recomputation', () => {
  it('gaps are recomputed after state vector update', async () => {
    const goal = makeGoal({
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        progress: { value: 0.5, confidence: 0.8, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    await processPostToolUse(
      { tool_name: 'Write', tool_output: '' },
      tmpRoot,
    );

    const updated = manager.loadGoal(goal.id)!;
    expect(updated.gaps.length).toBeGreaterThan(0);
    // After incrementing progress from 0.5 to 0.55, gap magnitude should be less than 1
    const progressGap = updated.gaps.find(g => g.dimension === 'progress');
    expect(progressGap).toBeDefined();
    expect(progressGap!.magnitude).toBeGreaterThan(0);
    expect(progressGap!.magnitude).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

describe('post-tool-use: completion detection', () => {
  it('marks goal as completed when all gaps fall below threshold', async () => {
    const goal = makeGoal({
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        // progress at 0.89 — one Write bump (0.05) brings it to 0.94 > 0.9 → gap = 0
        progress: { value: 0.89, confidence: 0.95, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    const result = await processPostToolUse(
      { tool_name: 'Write', tool_output: '' },
      tmpRoot,
    );

    expect(result.goalsCompleted).toContain(goal.id);
    const updated = manager.loadGoal(goal.id)!;
    expect(updated.status).toBe('completed');
  });

  it('completed goals are removed from active_goal_ids', async () => {
    const goal = makeGoal({
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        progress: { value: 0.89, confidence: 0.95, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    await processPostToolUse({ tool_name: 'Write', tool_output: '' }, tmpRoot);

    const state = manager.loadState();
    expect(state.active_goal_ids).not.toContain(goal.id);
  });

  it('does not mark in-progress goal as completed', async () => {
    const goal = makeGoal({
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        progress: { value: 0.3, confidence: 0.8, source: 'llm_estimate' },
      },
    });
    manager.addGoal(goal);

    const result = await processPostToolUse(
      { tool_name: 'Write', tool_output: '' },
      tmpRoot,
    );

    expect(result.goalsCompleted).not.toContain(goal.id);
    const updated = manager.loadGoal(goal.id)!;
    expect(updated.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Stall counter reset on success
// ---------------------------------------------------------------------------

describe('post-tool-use: stall counter reset', () => {
  it('resets stall counter for the tool on successful use', async () => {
    const state = manager.loadState();
    state.stall_state.consecutive_failures['Bash'] = 2;
    manager.saveState(state);

    await processPostToolUse({ tool_name: 'Bash', tool_output: '' }, tmpRoot);

    const updated = manager.loadState();
    expect(updated.stall_state.consecutive_failures['Bash']).toBe(0);
  });

  it('does not reset counter when tool output contains errors', async () => {
    const state = manager.loadState();
    state.stall_state.consecutive_failures['Bash'] = 2;
    manager.saveState(state);

    await processPostToolUse(
      { tool_name: 'Bash', tool_output: 'Error: command failed' },
      tmpRoot,
    );

    const updated = manager.loadState();
    // Counter stays because we detected an error in the output
    expect(updated.stall_state.consecutive_failures['Bash']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('post-tool-use: logging', () => {
  it('appends an entry to log.jsonl', async () => {
    await processPostToolUse({ tool_name: 'Read', tool_output: 'ok' }, tmpRoot);

    const logPath = join(tmpRoot, '.motive', 'log.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.event).toBe('post_tool_use');
    expect(entry.tool_name).toBe('Read');
  });
});

// ---------------------------------------------------------------------------
// Return value
// ---------------------------------------------------------------------------

describe('post-tool-use: return value', () => {
  it('returns correct goalsUpdated count', async () => {
    manager.addGoal(makeGoal({ title: 'Goal A' }));
    manager.addGoal(makeGoal({ title: 'Goal B' }));

    const result = await processPostToolUse({ tool_name: 'Read', tool_output: '' }, tmpRoot);

    expect(result.goalsUpdated).toBe(2);
  });

  it('returns empty arrays when no goals exist', async () => {
    const result = await processPostToolUse({ tool_name: 'Write', tool_output: '' }, tmpRoot);

    expect(result.goalsUpdated).toBe(0);
    expect(result.goalsCompleted).toHaveLength(0);
  });
});
