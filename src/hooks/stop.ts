import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { SatisficingEngine } from '../engines/satisficing.js';

export interface StopInput {
  session_id?: string;
  stop_reason?: string;
}

export interface GoalSummary {
  id: string;
  title: string;
  status: string;
  motivation_score: number;
  judgment: string;
}

export interface StopResult {
  goalsProcessed: number;
  goalsCompleted: number;
  summaries: GoalSummary[];
}

export async function processStop(
  input: StopInput,
  projectRoot?: string
): Promise<StopResult> {
  const root = projectRoot ?? process.cwd();

  const manager = new StateManager(root);
  const state = manager.loadState();

  const gapEngine = new GapAnalysisEngine();
  const satisficingEngine = new SatisficingEngine();

  const goals = manager.loadActiveGoals();
  const summaries: GoalSummary[] = [];
  let goalsCompleted = 0;

  for (const goal of goals) {
    // Run final gap analysis
    goal.gaps = gapEngine.computeGaps(goal);

    // Run satisficing judgment
    const judgment = satisficingEngine.judgeCompletion(goal.gaps);

    if (judgment.status === 'completed') {
      goal.status = 'completed';
      goalsCompleted++;
    }

    manager.saveGoal(goal);

    summaries.push({
      id: goal.id,
      title: goal.title,
      status: goal.status,
      motivation_score: goal.motivation_score,
      judgment: judgment.reason,
    });
  }

  // Remove completed goals from active list
  const completedIds = summaries
    .filter(s => s.status === 'completed')
    .map(s => s.id);

  state.active_goal_ids = state.active_goal_ids.filter(
    id => !completedIds.includes(id)
  );

  manager.saveState(state);

  // Log session summary
  manager.appendLog({
    event: 'session_stop',
    session_id: input.session_id ?? state.session_id,
    stop_reason: input.stop_reason ?? 'unknown',
    timestamp: new Date().toISOString(),
    goals_processed: goals.length,
    goals_completed: goalsCompleted,
    summaries,
  });

  return {
    goalsProcessed: goals.length,
    goalsCompleted,
    summaries,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: StopInput = {};
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput) as StopInput;
    } catch {
      // Unparseable stdin — treat as empty input
    }
  }

  await processStop(input);
  process.exit(0);
}

// Run main only when this module is the entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith('stop.ts') || process.argv[1].endsWith('stop.js'))
) {
  main().catch(() => process.exit(1));
}
