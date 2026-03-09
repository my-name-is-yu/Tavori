import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Goal } from '../../src/state/models.js';
import { StateManager } from '../../src/state/manager.js';
import {
  isRelatedToGoal,
  findRelatedGoal,
  buildInjectedContext,
  buildReminderContext,
  run,
} from '../../src/hooks/user-prompt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<Parameters<typeof Goal.parse>[0]> = {}): ReturnType<typeof Goal.parse> {
  return Goal.parse({
    title: 'Auth module',
    description: 'Implement JWT authentication for the API',
    type: 'dissatisfaction',
    status: 'active',
    motivation_score: 0.7,
    ...overrides,
  });
}

function makeTempProject(): string {
  const root = join(tmpdir(), `motive-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeConfig(root: string, content: string): void {
  const motiveDir = join(root, '.motive');
  mkdirSync(motiveDir, { recursive: true });
  writeFileSync(join(motiveDir, 'config.yaml'), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// isRelatedToGoal
// ---------------------------------------------------------------------------

describe('isRelatedToGoal', () => {
  it('matches when prompt contains a keyword from the goal title', () => {
    const goal = makeGoal({ title: 'Authentication module', description: '' });
    expect(isRelatedToGoal('implement authentication flow', goal)).toBe(true);
  });

  it('matches when prompt contains a keyword from the goal description', () => {
    const goal = makeGoal({ title: 'API work', description: 'Implement JWT tokens' });
    expect(isRelatedToGoal('add JWT validation middleware', goal)).toBe(true);
  });

  it('is case-insensitive', () => {
    const goal = makeGoal({ title: 'Database Migration', description: '' });
    expect(isRelatedToGoal('run DATABASE migration script', goal)).toBe(true);
  });

  it('returns false when no keywords match', () => {
    const goal = makeGoal({ title: 'Auth module', description: 'JWT implementation' });
    expect(isRelatedToGoal('fix the CSS layout on home page', goal)).toBe(false);
  });

  it('ignores very short words (< 3 chars)', () => {
    const goal = makeGoal({ title: 'Do it', description: 'Be a go to' });
    // "it", "be", "go", "to" are all < 3 chars — none should trigger a match
    expect(isRelatedToGoal('make the feature', goal)).toBe(false);
  });

  it('returns false for an empty prompt', () => {
    const goal = makeGoal();
    expect(isRelatedToGoal('', goal)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findRelatedGoal
// ---------------------------------------------------------------------------

describe('findRelatedGoal', () => {
  it('returns the first matching goal', () => {
    const g1 = makeGoal({ title: 'Auth module', description: '' });
    const g2 = makeGoal({ title: 'Database setup', description: '' });
    const result = findRelatedGoal('write auth middleware', [g1, g2]);
    expect(result?.title).toBe('Auth module');
  });

  it('returns null when no goals match', () => {
    const goals = [makeGoal({ title: 'Auth module', description: '' })];
    expect(findRelatedGoal('fix CSS spacing', goals)).toBeNull();
  });

  it('returns null for empty goals array', () => {
    expect(findRelatedGoal('do something', [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildInjectedContext
// ---------------------------------------------------------------------------

describe('buildInjectedContext', () => {
  it('includes goal title', () => {
    const goal = makeGoal({ title: 'Auth module', description: '' });
    const ctx = buildInjectedContext(goal);
    expect(ctx).toContain('Auth module');
  });

  it('includes Motive label', () => {
    const goal = makeGoal();
    expect(buildInjectedContext(goal)).toContain('[Motive]');
  });

  it('includes progress percentage when state_vector has progress', () => {
    const goal = makeGoal({
      state_vector: {
        progress: { value: 0.45, confidence: 0.9, observed_at: new Date().toISOString(), source: 'llm_estimate', observation_method: '' },
      },
    });
    const ctx = buildInjectedContext(goal);
    expect(ctx).toContain('45%');
  });

  it('does not include progress when state_vector is empty', () => {
    const goal = makeGoal({ state_vector: {} });
    const ctx = buildInjectedContext(goal);
    expect(ctx).not.toContain('progress:');
  });

  it('includes deadline when set', () => {
    const goal = makeGoal({ deadline: '2026-12-31T00:00:00Z' });
    const ctx = buildInjectedContext(goal);
    expect(ctx).toContain('2026-12-31');
  });

  it('includes suggested next task when gaps are present', () => {
    const goal = makeGoal({
      achievement_thresholds: { progress: 0.9 },
      state_vector: {
        progress: { value: 0.2, confidence: 0.8, observed_at: new Date().toISOString(), source: 'llm_estimate', observation_method: '' },
      },
    });
    const ctx = buildInjectedContext(goal);
    expect(ctx).toContain('Suggested next task');
  });
});

// ---------------------------------------------------------------------------
// buildReminderContext
// ---------------------------------------------------------------------------

describe('buildReminderContext', () => {
  it('returns empty string when no goals', () => {
    expect(buildReminderContext([])).toBe('');
  });

  it('mentions the top goal by title', () => {
    const lowGoal = makeGoal({ title: 'Low priority goal', motivation_score: 0.2 });
    const highGoal = makeGoal({ title: 'High priority goal', motivation_score: 0.9 });
    const ctx = buildReminderContext([lowGoal, highGoal]);
    expect(ctx).toContain('High priority goal');
    expect(ctx).toContain('[Motive]');
  });

  it('picks the goal with the highest motivation_score', () => {
    const goals = [
      makeGoal({ title: 'B', motivation_score: 0.5 }),
      makeGoal({ title: 'A', motivation_score: 0.8 }),
    ];
    expect(buildReminderContext(goals)).toContain('"A"');
  });
});

// ---------------------------------------------------------------------------
// run() — integration
// ---------------------------------------------------------------------------

describe('run()', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject();
  });

  afterEach(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes through with injected context when prompt matches an active goal', () => {
    const manager = new StateManager(projectRoot);
    manager.init();
    const goal = makeGoal({ title: 'Auth module', description: 'JWT authentication' });
    manager.addGoal(goal);

    const { output, exitCode } = run({ prompt: 'add auth middleware' }, projectRoot);
    expect(exitCode).toBe(0);
    expect(output.prompt).toContain('add auth middleware');
    expect(output.prompt).toContain('[Motive]');
    expect(output.prompt).toContain('Auth module');
  });

  it('passes through with reminder when prompt is unrelated and strict mode is off', () => {
    const manager = new StateManager(projectRoot);
    manager.init();
    manager.addGoal(makeGoal({ title: 'Auth module', description: 'JWT' }));

    const { output, exitCode } = run({ prompt: 'fix the readme typos' }, projectRoot);
    expect(exitCode).toBe(0);
    expect(output.prompt).toContain('fix the readme typos');
    // Should include a reminder or pass through cleanly
  });

  it('blocks with exit code 2 when strict_goal_alignment=true and prompt is unrelated', () => {
    const manager = new StateManager(projectRoot);
    manager.init();
    manager.addGoal(makeGoal({ title: 'Auth module', description: 'JWT' }));
    writeConfig(projectRoot, 'strict_goal_alignment: true\n');

    const { output, exitCode, stderrMessage } = run({ prompt: 'check the weather API' }, projectRoot);
    expect(exitCode).toBe(2);
    expect(stderrMessage).toContain('[Motive]');
    expect(stderrMessage).toContain('strict_goal_alignment');
    // prompt is still returned unchanged
    expect(output.prompt).toBe('check the weather API');
  });

  it('does NOT block when strict_goal_alignment=false', () => {
    const manager = new StateManager(projectRoot);
    manager.init();
    manager.addGoal(makeGoal({ title: 'Auth module', description: 'JWT' }));
    writeConfig(projectRoot, 'strict_goal_alignment: false\n');

    const { exitCode } = run({ prompt: 'fix CSS', }, projectRoot);
    expect(exitCode).toBe(0);
  });

  it('passes through with exit 0 when there are no active goals', () => {
    const manager = new StateManager(projectRoot);
    manager.init();

    const { output, exitCode } = run({ prompt: 'do something random' }, projectRoot);
    expect(exitCode).toBe(0);
    expect(output.prompt).toContain('do something random');
  });

  it('skips paused goals when checking relevance', () => {
    const manager = new StateManager(projectRoot);
    manager.init();
    const pausedGoal = makeGoal({ title: 'Auth module', description: 'JWT', status: 'paused' });
    manager.addGoal(pausedGoal);
    writeConfig(projectRoot, 'strict_goal_alignment: true\n');

    // Prompt matches paused goal title, but paused goals should be excluded
    const { exitCode } = run({ prompt: 'add auth middleware' }, projectRoot);
    // paused goal → not active → treated as unrelated → strict mode blocks
    expect(exitCode).toBe(2);
  });

  it('includes strict mode goal list in stderr message', () => {
    const manager = new StateManager(projectRoot);
    manager.init();
    manager.addGoal(makeGoal({ title: 'Deploy pipeline', description: '' }));
    writeConfig(projectRoot, 'strict_goal_alignment: true\n');

    const { stderrMessage } = run({ prompt: 'random stuff' }, projectRoot);
    expect(stderrMessage).toContain('Deploy pipeline');
  });
});
