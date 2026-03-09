import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { TaskGenerationEngine } from '../engines/task-generation.js';
import type { MotiveState, Goal } from '../state/models.js';

export class ContextInjector {
  private static readonly MAX_CHARS = 2000; // ~500 tokens
  private manager: StateManager;
  private gapEngine: GapAnalysisEngine;
  private taskEngine: TaskGenerationEngine;
  readonly outputPath: string;

  constructor(manager: StateManager) {
    this.manager = manager;
    this.gapEngine = new GapAnalysisEngine();
    this.taskEngine = new TaskGenerationEngine();
    this.outputPath = join(manager.projectRoot, '.claude', 'rules', 'motive.md');
  }

  /**
   * Generate motive.md content (≤500 tokens).
   * Can be called with explicit state/goals, or without args to load from disk.
   */
  generate(state?: MotiveState, goals?: Goal[]): string {
    const resolvedState = state ?? this.manager.loadState();
    const resolvedGoals = goals ?? this.manager.loadActiveGoals();

    if (resolvedGoals.length === 0) {
      return '# Motive Context\n\nNo active goals. Awaiting user direction.\n';
    }

    const lines: string[] = ['# Motive Context\n'];
    lines.push(`Trust: ${resolvedState.trust_balance.global.toFixed(2)}\n`);

    // Sort goals by motivation score descending
    const sorted = [...resolvedGoals].sort((a, b) => b.motivation_score - a.motivation_score);

    // Top priority goal — current session focus
    const topGoal = sorted[0];
    lines.push(`## Session Focus: ${topGoal.title}`);
    lines.push(`Score: ${topGoal.motivation_score.toFixed(2)} | Type: ${topGoal.type}`);
    if (topGoal.deadline) {
      lines.push(`Deadline: ${topGoal.deadline}`);
    }

    // Gaps for top goal (top 3)
    const topGaps = this.gapEngine.computeGaps(topGoal)
      .filter(g => g.magnitude > 0.05)
      .slice(0, 3);

    if (topGaps.length > 0) {
      lines.push('Gaps:');
      for (const g of topGaps) {
        const magPct = (g.magnitude * 100).toFixed(0);
        const confPct = (g.confidence * 100).toFixed(0);
        lines.push(`  - ${g.dimension}: ${g.current.toFixed(1)}→${g.target.toFixed(1)} (${magPct}% gap, conf:${confPct}%)`);
      }
    }

    // Suggested next action from top task
    const topTask = this.taskEngine.getTopTask(topGaps, topGoal);
    if (topTask) {
      lines.push(`Next: ${topTask.description}`);
    }

    lines.push('');

    // Progress summary for remaining active goals (if any)
    if (sorted.length > 1) {
      lines.push('## Other Active Goals');
      for (const goal of sorted.slice(1)) {
        const progressEl = goal.state_vector.progress;
        const progressStr = progressEl
          ? `${(progressEl.value * 100).toFixed(0)}%`
          : 'unknown';
        lines.push(`  - ${goal.title}: progress=${progressStr}, score=${goal.motivation_score.toFixed(2)}`);
      }
      lines.push('');
    }

    // Warnings / constraints
    const warnings: string[] = [];
    if (resolvedState.trust_balance.global < 0.4) {
      warnings.push('Low trust balance — prefer reversible actions and seek confirmation.');
    }
    if (resolvedState.stall_state.stall_count > 2) {
      warnings.push(`Stall detected (${resolvedState.stall_state.stall_count}x) — consider switching strategy or asking user.`);
    }
    if (warnings.length > 0) {
      lines.push('## Warnings');
      for (const w of warnings) {
        lines.push(`  - ${w}`);
      }
      lines.push('');
    }

    let content = lines.join('\n');
    if (content.length > ContextInjector.MAX_CHARS) {
      content = content.slice(0, ContextInjector.MAX_CHARS) + '\n...(truncated)\n';
    }
    return content;
  }

  /**
   * Write motive.md to .claude/rules/motive.md and return the output path.
   * Accepts optional explicit state/goals; falls back to loading from disk.
   */
  inject(projectRoot: string, state: MotiveState, goals: Goal[]): void {
    const content = this.generate(state, goals);
    const outPath = join(projectRoot, '.claude', 'rules', 'motive.md');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
  }

  /**
   * Write motive.md using state loaded from disk. Returns the output path.
   */
  write(): string {
    const content = this.generate();
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, content);
    return this.outputPath;
  }
}
