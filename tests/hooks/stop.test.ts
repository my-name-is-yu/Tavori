import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../../src/state/manager.js';
import { Goal } from '../../src/state/models.js';
import { processStop } from '../../src/hooks/stop.js';

let tmpDir: string;
let manager: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'motive-stop-test-'));
  manager = new StateManager(tmpDir);
  manager.init();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeGoal(overrides: Partial<Parameters<typeof Goal.parse>[0]> = {}): Goal {
  return Goal.parse({
    title: 'Test Goal',
    achievement_thresholds: { progress: 0.9 },
    state_vector: {
      progress: { value: 0.4, confidence: 0.8, source: 'tool_output' },
    },
    ...overrides,
  });
}

function makeCompletedGoal(overrides: Partial<Parameters<typeof Goal.parse>[0]> = {}): Goal {
  return Goal.parse({
    title: 'Completed Goal',
    achievement_thresholds: { progress: 0.9 },
    state_vector: {
      // value exceeds threshold → magnitude = 0
      progress: { value: 0.95, confidence: 0.9, source: 'tool_output' },
    },
    ...overrides,
  });
}

describe('processStop', () => {
  it('returns goalsProcessed = 0 when no active goals', async () => {
    const result = await processStop({}, tmpDir);
    expect(result.goalsProcessed).toBe(0);
    expect(result.goalsCompleted).toBe(0);
    expect(result.summaries).toHaveLength(0);
  });

  it('processes one in-progress goal without marking it completed', async () => {
    const goal = makeGoal({ title: 'In Progress' });
    manager.addGoal(goal);

    const result = await processStop({}, tmpDir);

    expect(result.goalsProcessed).toBe(1);
    expect(result.goalsCompleted).toBe(0);
    expect(result.summaries[0].status).not.toBe('completed');
  });

  it('marks a satisfied goal as completed', async () => {
    const goal = makeCompletedGoal({ title: 'Done Goal' });
    manager.addGoal(goal);

    const result = await processStop({}, tmpDir);

    expect(result.goalsCompleted).toBe(1);
    expect(result.summaries[0].status).toBe('completed');
  });

  it('saves completed status to goal file on disk', async () => {
    const goal = makeCompletedGoal({ title: 'Persisted Complete' });
    manager.addGoal(goal);

    await processStop({}, tmpDir);

    const saved = manager.loadGoal(goal.id);
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('completed');
  });

  it('removes completed goals from active_goal_ids', async () => {
    const goal = makeCompletedGoal({ title: 'Remove Me' });
    manager.addGoal(goal);

    await processStop({}, tmpDir);

    const state = manager.loadState();
    expect(state.active_goal_ids).not.toContain(goal.id);
  });

  it('keeps in-progress goals in active_goal_ids', async () => {
    const goal = makeGoal({ title: 'Keep Me' });
    manager.addGoal(goal);

    await processStop({}, tmpDir);

    const state = manager.loadState();
    expect(state.active_goal_ids).toContain(goal.id);
  });

  it('handles mixed completed and in-progress goals', async () => {
    const inProgress = makeGoal({ title: 'Still Going' });
    const done = makeCompletedGoal({ title: 'Finished' });
    manager.addGoal(inProgress);
    manager.addGoal(done);

    const result = await processStop({}, tmpDir);

    expect(result.goalsProcessed).toBe(2);
    expect(result.goalsCompleted).toBe(1);

    const state = manager.loadState();
    expect(state.active_goal_ids).toContain(inProgress.id);
    expect(state.active_goal_ids).not.toContain(done.id);
  });

  it('appends a session_stop entry to log.jsonl', async () => {
    const goal = makeGoal({ title: 'Logged Goal' });
    manager.addGoal(goal);

    await processStop({ session_id: 'sess-abc', stop_reason: 'end_turn' }, tmpDir);

    expect(existsSync(manager.logPath)).toBe(true);
    const lines = readFileSync(manager.logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.event).toBe('session_stop');
    expect(entry.session_id).toBe('sess-abc');
    expect(entry.stop_reason).toBe('end_turn');
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.goals_processed).toBe(1);
  });

  it('logs goals_completed count in session summary', async () => {
    const done = makeCompletedGoal();
    manager.addGoal(done);

    await processStop({}, tmpDir);

    const lines = readFileSync(manager.logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.goals_completed).toBe(1);
  });

  it('includes per-goal summaries in log entry', async () => {
    const goal = makeGoal({ title: 'Summary Goal' });
    manager.addGoal(goal);

    await processStop({}, tmpDir);

    const lines = readFileSync(manager.logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(Array.isArray(entry.summaries)).toBe(true);
    expect(entry.summaries[0].title).toBe('Summary Goal');
    expect(typeof entry.summaries[0].judgment).toBe('string');
  });

  it('recomputes gaps before satisficing judgment', async () => {
    const goal = makeGoal({ title: 'Gap Recompute' });
    // Start with empty gaps
    goal.gaps = [];
    manager.saveGoal(goal);
    const state = manager.loadState();
    state.active_goal_ids.push(goal.id);
    manager.saveState(state);

    await processStop({}, tmpDir);

    const saved = manager.loadGoal(goal.id);
    expect(saved).not.toBeNull();
    // Gaps should have been recomputed from state_vector
    expect(saved!.gaps.length).toBeGreaterThan(0);
  });

  it('uses state session_id in log when no input session_id provided', async () => {
    await processStop({ stop_reason: 'end_turn' }, tmpDir);

    const lines = readFileSync(manager.logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    const state = manager.loadState();
    expect(entry.session_id).toBe(state.session_id);
  });

  it('returns summaries with correct fields', async () => {
    const goal = makeGoal({ title: 'Field Check' });
    manager.addGoal(goal);

    const result = await processStop({}, tmpDir);

    const summary = result.summaries[0];
    expect(typeof summary.id).toBe('string');
    expect(typeof summary.title).toBe('string');
    expect(typeof summary.status).toBe('string');
    expect(typeof summary.motivation_score).toBe('number');
    expect(typeof summary.judgment).toBe('string');
  });
});
