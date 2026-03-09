import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { PriorityScoringEngine } from '../engines/priority-scoring.js';
import { ContextInjector } from '../context/injector.js';

export interface SessionStartInput {
  session_id?: string;
  cwd?: string;
}

export interface SessionStartResult {
  goalsProcessed: number;
  contextPath: string;
}

export async function processSessionStart(
  input: SessionStartInput,
  projectRoot?: string
): Promise<SessionStartResult> {
  const root = input.cwd ?? projectRoot ?? process.cwd();

  const manager = new StateManager(root);
  const state = manager.init();

  // Update session_id if provided
  if (input.session_id) {
    state.session_id = input.session_id;
  }

  const gapEngine = new GapAnalysisEngine();
  const scoringEngine = new PriorityScoringEngine();

  const goals = manager.loadActiveGoals();

  for (const goal of goals) {
    // Recompute gaps
    goal.gaps = gapEngine.computeGaps(goal);

    // Compute motivation score and breakdown
    const score = scoringEngine.motivationScore(goal, goal.gaps);
    const dl = scoringEngine.deadlineScore(goal);
    const ds = scoringEngine.dissatisfactionScore(goal.gaps);
    const op = scoringEngine.opportunityScore([]);

    goal.motivation_score = score;
    goal.motivation_breakdown = {
      deadline_pressure: dl,
      dissatisfaction: ds,
      opportunity: op,
    };

    manager.saveGoal(goal);
  }

  manager.saveState(state);

  // Generate context injection file
  const injector = new ContextInjector(manager);
  const contextPath = injector.write();

  return {
    goalsProcessed: goals.length,
    contextPath,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: SessionStartInput = {};
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput) as SessionStartInput;
    } catch {
      // Unparseable stdin — treat as empty input
    }
  }

  await processSessionStart(input);
  process.exit(0);
}

// Run main only when this module is the entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith('session-start.ts') ||
    process.argv[1].endsWith('session-start.js'))
) {
  main().catch(() => process.exit(1));
}
