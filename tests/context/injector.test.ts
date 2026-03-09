import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContextInjector } from '../../src/context/injector.js';
import { StateManager } from '../../src/state/manager.js';
import { MotiveState, Goal } from '../../src/state/models.js';

function makeGoal(overrides: Partial<Parameters<typeof Goal.parse>[0]> = {}): ReturnType<typeof Goal.parse> {
  return Goal.parse({
    title: 'Test Goal',
    type: 'dissatisfaction',
    achievement_thresholds: { progress: 0.9 },
    state_vector: {
      progress: { value: 0.3, confidence: 0.8, source: 'tool_output' },
    },
    motivation_score: 0.6,
    ...overrides,
  });
}

function makeState(overrides: Partial<Parameters<typeof MotiveState.parse>[0]> = {}): ReturnType<typeof MotiveState.parse> {
  return MotiveState.parse({
    trust_balance: { global: 0.7 },
    ...overrides,
  });
}

describe('ContextInjector', () => {
  let tmpRoot: string;
  let manager: StateManager;
  let injector: ContextInjector;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `motive-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpRoot, { recursive: true });
    manager = new StateManager(tmpRoot);
    injector = new ContextInjector(manager);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('generate(state, goals)', () => {
    it('returns a no-goals message when goals array is empty', () => {
      const state = makeState();
      const content = injector.generate(state, []);
      expect(content).toContain('No active goals');
    });

    it('includes session focus heading for the top goal', () => {
      const state = makeState();
      const goals = [makeGoal({ title: 'Ship Feature X', motivation_score: 0.8 })];
      const content = injector.generate(state, goals);
      expect(content).toContain('Session Focus: Ship Feature X');
    });

    it('shows trust balance', () => {
      const state = makeState({ trust_balance: { global: 0.55 } });
      const content = injector.generate(state, [makeGoal()]);
      expect(content).toContain('Trust: 0.55');
    });

    it('shows deadline when goal has one', () => {
      const state = makeState();
      const goals = [makeGoal({ deadline: '2026-04-01T00:00:00Z' })];
      const content = injector.generate(state, goals);
      expect(content).toContain('Deadline: 2026-04-01');
    });

    it('shows gaps for the top goal', () => {
      const state = makeState();
      const goals = [makeGoal()];
      const content = injector.generate(state, goals);
      expect(content).toContain('progress');
    });

    it('suggests a next action when gaps exist', () => {
      const state = makeState();
      const goals = [makeGoal()];
      const content = injector.generate(state, goals);
      expect(content).toContain('Next:');
    });

    it('shows other active goals section when multiple goals exist', () => {
      const state = makeState();
      const goals = [
        makeGoal({ title: 'High Priority', motivation_score: 0.9 }),
        makeGoal({ title: 'Low Priority', motivation_score: 0.3 }),
      ];
      const content = injector.generate(state, goals);
      expect(content).toContain('Other Active Goals');
      expect(content).toContain('Low Priority');
    });

    it('shows low trust warning when global trust is below 0.4', () => {
      const state = makeState({ trust_balance: { global: 0.35 } });
      const content = injector.generate(state, [makeGoal()]);
      expect(content).toContain('Low trust balance');
    });

    it('shows stall warning when stall count exceeds 2', () => {
      const state = makeState({
        stall_state: { consecutive_failures: {}, last_stall_at: null, stall_count: 3 },
      });
      const content = injector.generate(state, [makeGoal()]);
      expect(content).toContain('Stall detected');
    });

    it('does not show warnings section when trust is healthy and no stall', () => {
      const state = makeState({ trust_balance: { global: 0.8 } });
      const content = injector.generate(state, [makeGoal()]);
      expect(content).not.toContain('## Warnings');
    });

    it('stays within 500-token limit (~2000 chars)', () => {
      // Create many goals with many dimensions to stress the truncation
      const manyGoals = Array.from({ length: 10 }, (_, i) =>
        makeGoal({
          title: `Goal ${i} with a very long title that takes up space in the output`,
          motivation_score: 1.0 - i * 0.05,
          achievement_thresholds: {
            progress: 0.9,
            quality_score: 0.8,
            test_coverage: 0.7,
            doc_coverage: 0.6,
          },
          state_vector: {
            progress: { value: 0.1, confidence: 0.9, source: 'tool_output' },
            quality_score: { value: 0.2, confidence: 0.8, source: 'llm_estimate' },
            test_coverage: { value: 0.1, confidence: 0.7, source: 'llm_estimate' },
            doc_coverage: { value: 0.0, confidence: 0.6, source: 'llm_estimate' },
          },
        })
      );
      const state = makeState();
      const content = injector.generate(state, manyGoals);
      expect(content.length).toBeLessThanOrEqual(2100); // 2000 chars + small truncation suffix
    });

    it('top priority goal appears before other goals', () => {
      const state = makeState();
      const highPriority = makeGoal({ title: 'HIGH', motivation_score: 0.95 });
      const lowPriority = makeGoal({ title: 'LOW', motivation_score: 0.1 });
      const content = injector.generate(state, [lowPriority, highPriority]);
      const highIdx = content.indexOf('HIGH');
      const lowIdx = content.indexOf('LOW');
      expect(highIdx).toBeLessThan(lowIdx);
    });
  });

  describe('generate() — no args (loads from disk)', () => {
    it('returns no-goals message when state has no active goals', () => {
      manager.init();
      const content = injector.generate();
      expect(content).toContain('No active goals');
    });

    it('generates content from persisted goals', () => {
      manager.init();
      const goal = makeGoal({ title: 'Persisted Goal', motivation_score: 0.7 });
      manager.addGoal(goal);

      const content = injector.generate();
      expect(content).toContain('Persisted Goal');
    });
  });

  describe('inject(projectRoot, state, goals)', () => {
    it('writes motive.md to .claude/rules/motive.md under the given projectRoot', () => {
      const state = makeState();
      const goals = [makeGoal({ title: 'Inject Target' })];
      injector.inject(tmpRoot, state, goals);

      const outPath = join(tmpRoot, '.claude', 'rules', 'motive.md');
      expect(existsSync(outPath)).toBe(true);
      const written = readFileSync(outPath, 'utf-8');
      expect(written).toContain('Inject Target');
    });

    it('creates the directory if it does not exist', () => {
      const state = makeState();
      injector.inject(tmpRoot, state, [makeGoal()]);
      expect(existsSync(join(tmpRoot, '.claude', 'rules'))).toBe(true);
    });
  });

  describe('write()', () => {
    it('writes to outputPath and returns the path', () => {
      manager.init();
      const goal = makeGoal({ title: 'Write Test' });
      manager.addGoal(goal);

      const resultPath = injector.write();
      expect(resultPath).toBe(injector.outputPath);
      expect(existsSync(resultPath)).toBe(true);
      const written = readFileSync(resultPath, 'utf-8');
      expect(written).toContain('Write Test');
    });
  });
});
