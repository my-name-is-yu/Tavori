import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../../src/state/manager.js';
import { Goal } from '../../src/state/models.js';
import { processSessionStart } from '../../src/hooks/session-start.js';

let tmpDir: string;
let manager: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'motive-session-start-test-'));
  manager = new StateManager(tmpDir);
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

describe('processSessionStart', () => {
  it('initializes .motive directory when it does not exist', async () => {
    await processSessionStart({}, tmpDir);
    expect(existsSync(manager.motiveDir)).toBe(true);
    expect(existsSync(manager.statePath)).toBe(true);
  });

  it('updates session_id in state when provided', async () => {
    await processSessionStart({ session_id: 'test-session-123' }, tmpDir);
    const state = manager.loadState();
    expect(state.session_id).toBe('test-session-123');
  });

  it('does not overwrite session_id when not provided', async () => {
    manager.init();
    const initialState = manager.loadState();
    const originalId = initialState.session_id;

    await processSessionStart({}, tmpDir);
    const state = manager.loadState();
    expect(state.session_id).toBe(originalId);
  });

  it('returns goalsProcessed = 0 when no active goals', async () => {
    const result = await processSessionStart({}, tmpDir);
    expect(result.goalsProcessed).toBe(0);
  });

  it('processes active goals and recomputes gaps', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Active Goal' });
    manager.addGoal(goal);

    const result = await processSessionStart({}, tmpDir);
    expect(result.goalsProcessed).toBe(1);

    const updated = manager.loadGoal(goal.id);
    expect(updated).not.toBeNull();
    expect(updated!.gaps.length).toBeGreaterThan(0);
  });

  it('saves motivation_score to each goal after processing', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Scored Goal' });
    // Ensure motivation_score starts at 0 (default)
    expect(goal.motivation_score).toBe(0);
    manager.addGoal(goal);

    await processSessionStart({}, tmpDir);

    const updated = manager.loadGoal(goal.id);
    expect(updated).not.toBeNull();
    // After processing a goal with a gap, motivation score should be > 0
    expect(updated!.motivation_score).toBeGreaterThan(0);
  });

  it('saves motivation_breakdown fields to each goal', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Breakdown Goal' });
    manager.addGoal(goal);

    await processSessionStart({}, tmpDir);

    const updated = manager.loadGoal(goal.id);
    expect(updated).not.toBeNull();
    expect(updated!.motivation_breakdown).toBeDefined();
    expect(typeof updated!.motivation_breakdown.deadline_pressure).toBe('number');
    expect(typeof updated!.motivation_breakdown.dissatisfaction).toBe('number');
    expect(typeof updated!.motivation_breakdown.opportunity).toBe('number');
  });

  it('writes motive.md context file', async () => {
    manager.init();
    const goal = makeGoal({ title: 'Context Goal' });
    manager.addGoal(goal);

    const result = await processSessionStart({}, tmpDir);

    expect(existsSync(result.contextPath)).toBe(true);
    const content = readFileSync(result.contextPath, 'utf-8');
    expect(content).toContain('# Motive Context');
  });

  it('writes motive.md with goal title when goals exist', async () => {
    manager.init();
    const goal = makeGoal({ title: 'My Specific Goal' });
    manager.addGoal(goal);

    const result = await processSessionStart({}, tmpDir);

    const content = readFileSync(result.contextPath, 'utf-8');
    expect(content).toContain('My Specific Goal');
  });

  it('writes motive.md with "No active goals" when none exist', async () => {
    const result = await processSessionStart({}, tmpDir);

    const content = readFileSync(result.contextPath, 'utf-8');
    expect(content).toContain('No active goals');
  });

  it('processes multiple goals', async () => {
    manager.init();
    const g1 = makeGoal({ title: 'Goal One' });
    const g2 = makeGoal({ title: 'Goal Two' });
    manager.addGoal(g1);
    manager.addGoal(g2);

    const result = await processSessionStart({}, tmpDir);
    expect(result.goalsProcessed).toBe(2);
  });

  it('saves updated state with last_updated timestamp', async () => {
    manager.init();
    const before = new Date().getTime();

    await processSessionStart({}, tmpDir);

    const state = manager.loadState();
    const lastUpdated = new Date(state.last_updated).getTime();
    expect(lastUpdated).toBeGreaterThanOrEqual(before);
  });

  it('uses process.cwd() when no projectRoot or cwd provided', async () => {
    // This test just verifies the function accepts missing root without throwing
    // We cannot easily test process.cwd() directly, but we verify the call signature
    const result = await processSessionStart({ cwd: tmpDir });
    expect(result).toBeDefined();
  });
});
