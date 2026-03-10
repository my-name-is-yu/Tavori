import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// ---- Types ----

export interface Goal {
  id: string;
  description: string;
  thresholds: {
    files_exist?: string[];
    tests_pass?: boolean;
    build_pass?: boolean;
  };
  status: 'active' | 'completed' | 'stalled';
  sessions: SessionResult[];
}

export interface SessionResult {
  id: number;
  startedAt: string;
  completedAt: string;
  success: boolean;
  summary: string;
}

export interface MotivaState {
  currentGoalId: string | null;
  sessionCount: number;
  lastUpdated: string;
}

// ---- Paths ----

function motivaDir(cwd: string): string {
  return path.join(cwd, '.motiva');
}

function goalsPath(cwd: string): string {
  return path.join(motivaDir(cwd), 'goals.json');
}

function statePath(cwd: string): string {
  return path.join(motivaDir(cwd), 'state.json');
}

// ---- Init ----

export function initMotiva(cwd: string): void {
  const dir = motivaDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(goalsPath(cwd))) {
    fs.writeFileSync(goalsPath(cwd), JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(statePath(cwd))) {
    const initial: MotivaState = {
      currentGoalId: null,
      sessionCount: 0,
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(statePath(cwd), JSON.stringify(initial, null, 2));
  }
}

// ---- Goals CRUD ----

export function readGoals(cwd: string): Goal[] {
  const p = goalsPath(cwd);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Goal[];
}

export function writeGoals(cwd: string, goals: Goal[]): void {
  fs.writeFileSync(goalsPath(cwd), JSON.stringify(goals, null, 2));
}

export function addGoal(cwd: string, description: string, thresholds: Goal['thresholds'] = {}): Goal {
  const goals = readGoals(cwd);
  const goal: Goal = {
    id: `goal-${Date.now()}`,
    description,
    thresholds,
    status: 'active',
    sessions: [],
  };
  goals.push(goal);
  writeGoals(cwd, goals);
  return goal;
}

export function updateGoal(cwd: string, goal: Goal): void {
  const goals = readGoals(cwd);
  const idx = goals.findIndex(g => g.id === goal.id);
  if (idx === -1) throw new Error(`Goal not found: ${goal.id}`);
  goals[idx] = goal;
  writeGoals(cwd, goals);
}

// ---- State ----

export function readState(cwd: string): MotivaState {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) {
    return { currentGoalId: null, sessionCount: 0, lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as MotivaState;
}

export function writeState(cwd: string, state: MotivaState): void {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(statePath(cwd), JSON.stringify(state, null, 2));
}

// ---- Completion Check ----

export function checkCompletion(goal: Goal, cwd: string): boolean {
  const { thresholds } = goal;

  // If no thresholds are defined, cannot confirm completion
  if (!thresholds.files_exist?.length && !thresholds.tests_pass && !thresholds.build_pass) {
    return false;
  }

  // Check files_exist
  if (thresholds.files_exist && thresholds.files_exist.length > 0) {
    for (const filePath of thresholds.files_exist) {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      if (!fs.existsSync(abs)) {
        return false;
      }
      const stat = fs.statSync(abs);
      if (stat.size === 0) {
        return false;
      }
    }
  }

  // Check tests_pass
  if (thresholds.tests_pass) {
    try {
      execFileSync('npm', ['test'], { cwd, stdio: 'pipe' });
    } catch {
      return false;
    }
  }

  // Check build_pass
  if (thresholds.build_pass) {
    try {
      execFileSync('npm', ['run', 'build'], { cwd, stdio: 'pipe' });
    } catch {
      return false;
    }
  }

  return true;
}

// ---- Stall Detection ----

const STALL_THRESHOLD = 3;

export function detectStall(goal: Goal): boolean {
  const sessions = goal.sessions;
  if (sessions.length < STALL_THRESHOLD) return false;

  // Check if last N sessions all failed
  const recent = sessions.slice(-STALL_THRESHOLD);
  if (recent.every(s => !s.success)) {
    return true;
  }

  // Check if last N sessions all succeeded but goal is still active (no real progress)
  const allSuccessButNotComplete = recent.every(s => s.success);
  if (allSuccessButNotComplete && goal.status === 'active') {
    return true;
  }

  return false;
}
