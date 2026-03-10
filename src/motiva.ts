#!/usr/bin/env node
import { Command } from 'commander';
import * as readline from 'readline';
import {
  initMotiva,
  readGoals,
  readState,
  writeState,
  addGoal,
  updateGoal,
  checkCompletion,
  detectStall,
  type Goal,
  type SessionResult,
} from './state.js';
import { runSession, detectIrreversibleActions } from './adapters/claude-code.js';

const program = new Command();
const CWD = process.cwd();

// ---- Helpers ----

function log(msg: string): void {
  console.log(`[Motiva] ${msg}`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`[Motiva] ${question} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function buildTaskPrompt(goal: Goal, sessionNum: number): string {
  const lines: string[] = [
    `You are working on the following goal (session #${sessionNum}):`,
    ``,
    `Goal: ${goal.description}`,
    ``,
  ];

  const { thresholds } = goal;
  if (thresholds.files_exist && thresholds.files_exist.length > 0) {
    lines.push(`Success criteria:`);
    lines.push(`- These files must exist and be non-empty: ${thresholds.files_exist.join(', ')}`);
  }
  if (thresholds.tests_pass) {
    lines.push(`- npm test must pass`);
  }
  if (thresholds.build_pass) {
    lines.push(`- npm run build must pass`);
  }

  if (goal.sessions.length > 0) {
    const last = goal.sessions[goal.sessions.length - 1];
    lines.push(``, `Previous session result: ${last.success ? 'success' : 'failed'}`);
    if (last.summary) {
      lines.push(`Previous session summary: ${last.summary}`);
    }
  }

  lines.push(``, `Work toward the goal. Be concise and focused.`);

  lines.push(
    ``,
    `IMPORTANT CONSTRAINTS:`,
    `- Do NOT execute irreversible actions: git push, rm -rf, DROP TABLE, deploy, publish`,
    `- Do NOT modify files outside the current project directory`,
    `- If you encounter a situation requiring an irreversible action, stop and report it`,
  );

  return lines.join('\n');
}

// ---- Main Loop ----

async function runLoop(): Promise<void> {
  log('Starting main loop...');
  log('WARNING: Claude Code will be invoked with --dangerously-skip-permissions.');
  log('Irreversible actions (git push, rm -rf, deploy) should be avoided in your goal prompts.');
  log('');

  const proceed = await confirm('Continue?');
  if (!proceed) {
    log('Aborted.');
    process.exit(0);
  }

  let state = readState(CWD);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const goals = readGoals(CWD);
    const activeGoals = goals.filter(g => g.status === 'active');

    if (activeGoals.length === 0) {
      log('No active goals. All done or all stalled.');
      break;
    }

    // Pick first active goal
    const goal = activeGoals[0];
    state.currentGoalId = goal.id;
    state.sessionCount += 1;
    writeState(CWD, state);

    const sessionNum = goal.sessions.length + 1;
    log(`Goal: "${goal.description}"`);
    log(`Starting session #${sessionNum}...`);

    const startedAt = new Date().toISOString();
    const task = buildTaskPrompt(goal, sessionNum);
    const output = await runSession(task, CWD);
    const completedAt = new Date().toISOString();

    if (output.timedOut) {
      log(`Session #${sessionNum} timed out.`);
    }

    const detected = detectIrreversibleActions(output.stdout);
    if (detected.length > 0) {
      console.warn(`[Motiva] WARNING: Irreversible action patterns detected: ${detected.join(', ')}`);
    }

    const success = output.exitCode === 0 && !output.timedOut;
    const summary = output.stdout.slice(-500).trim(); // last 500 chars as summary

    const result: SessionResult = {
      id: sessionNum,
      startedAt,
      completedAt,
      success,
      summary,
    };

    goal.sessions.push(result);
    log(`Session #${sessionNum} ${success ? 'succeeded' : 'failed'} (exit code: ${output.exitCode})`);

    // Check completion
    const completed = checkCompletion(goal, CWD);
    if (completed) {
      goal.status = 'completed';
      updateGoal(CWD, goal);
      log(`Goal completed: "${goal.description}"`);
      log('Satisficing: gap is below threshold. Stopping.');
      continue;
    }

    // Check stall
    const stalled = detectStall(goal);
    if (stalled) {
      goal.status = 'stalled';
      updateGoal(CWD, goal);
      log(`Goal stalled after ${goal.sessions.length} sessions: "${goal.description}"`);
      log('Escalating: manual intervention required.');
      continue;
    }

    // Update goal with new session result and continue
    updateGoal(CWD, goal);
    log(`Not yet complete. Starting next session...`);
    log('');
  }

  state.currentGoalId = null;
  writeState(CWD, state);
  log('Loop finished.');
}

// ---- CLI Commands ----

program
  .name('motiva')
  .description('AI agent orchestrator — goal-driven autonomous task execution')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize .motiva/ directory in the current project')
  .action(() => {
    initMotiva(CWD);
    log('Initialized .motiva/ directory.');
  });

program
  .command('add-goal <description>')
  .description('Add a new goal')
  .option('--thresholds <json>', 'Completion thresholds as JSON', '{}')
  .action((description: string, options: { thresholds: string }) => {
    let thresholds: Goal['thresholds'] = {};
    try {
      thresholds = JSON.parse(options.thresholds) as Goal['thresholds'];
    } catch {
      console.error('Invalid JSON for --thresholds');
      process.exit(1);
    }
    const goal = addGoal(CWD, description, thresholds);
    log(`Goal added: ${goal.id}`);
    log(`  Description: ${goal.description}`);
    if (goal.thresholds.files_exist) {
      log(`  files_exist: ${goal.thresholds.files_exist.join(', ')}`);
    }
    if (goal.thresholds.tests_pass) {
      log(`  tests_pass: true`);
    }
    if (goal.thresholds.build_pass) {
      log(`  build_pass: true`);
    }
  });

program
  .command('goals')
  .description('List all goals')
  .action(() => {
    const goals = readGoals(CWD);
    if (goals.length === 0) {
      log('No goals found. Use `motiva add-goal` to add one.');
      return;
    }
    log(`Goals (${goals.length}):`);
    for (const g of goals) {
      const icon = g.status === 'completed' ? '[done]' : g.status === 'stalled' ? '[stalled]' : '[active]';
      console.log(`  ${icon} ${g.id}: ${g.description}`);
      console.log(`         sessions: ${g.sessions.length}, status: ${g.status}`);
    }
  });

program
  .command('status')
  .description('Show current Motiva state')
  .action(() => {
    const state = readState(CWD);
    const goals = readGoals(CWD);
    const active = goals.filter(g => g.status === 'active').length;
    const completed = goals.filter(g => g.status === 'completed').length;
    const stalled = goals.filter(g => g.status === 'stalled').length;

    log('Current state:');
    console.log(`  currentGoalId : ${state.currentGoalId ?? '(none)'}`);
    console.log(`  sessionCount  : ${state.sessionCount}`);
    console.log(`  lastUpdated   : ${state.lastUpdated}`);
    console.log(`  goals active  : ${active}`);
    console.log(`  goals completed: ${completed}`);
    console.log(`  goals stalled : ${stalled}`);
  });

program
  .command('run')
  .description('Start the autonomous main loop')
  .action(async () => {
    await runLoop();
  });

program.parse(process.argv);
