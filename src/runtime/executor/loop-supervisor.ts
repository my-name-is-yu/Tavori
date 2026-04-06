import { writeFileSync, mkdirSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { GoalWorker, type GoalWorkerConfig, type WorkerResult } from './goal-worker.js';
import { createEnvelope } from '../types/envelope.js';
import type { Envelope } from '../types/envelope.js';
import type { EventBus } from '../queue/event-bus.js';
import type { CoreLoop } from '../../orchestrator/loop/core-loop.js';
import type { DriveSystem } from '../../platform/drive/drive-system.js';
import type { StateManager } from '../../base/state/state-manager.js';
import type { Logger } from '../logger.js';

export interface SupervisorConfig {
  concurrency: number;
  iterationsPerCycle: number;
  maxCrashCount: number;
  crashBackoffBaseMs: number;
  stateFilePath: string;
  pollIntervalMs: number;
}

export interface SupervisorDeps {
  coreLoopFactory: () => CoreLoop;
  eventBus: EventBus;
  driveSystem: DriveSystem;
  stateManager: StateManager;
  logger?: Logger;
  onEscalation?: (goalId: string, crashCount: number, lastError: string) => void;
}

export interface SupervisorState {
  workers: Array<{
    workerId: string;
    goalId: string | null;
    startedAt: number;
    iterations: number;
  }>;
  crashCounts: Record<string, number>;
  suspendedGoals: string[];
  updatedAt: number;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  concurrency: 4,
  iterationsPerCycle: 5,
  maxCrashCount: 3,
  crashBackoffBaseMs: 1000,
  stateFilePath: join(homedir(), '.pulseed', 'supervisor-state.json'),
  pollIntervalMs: 100,
};

export class LoopSupervisor {
  private workers: GoalWorker[] = [];
  private activeGoals: Map<string, GoalWorker> = new Map();
  private crashCounts: Map<string, number> = new Map();
  private suspendedGoals: Set<string> = new Set();
  private running: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: SupervisorConfig;
  private readonly deps: SupervisorDeps;
  // Track running executions for graceful shutdown
  private runningExecutions: Promise<void>[] = [];
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(deps: SupervisorDeps, config?: Partial<SupervisorConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(initialGoalIds: string[]): Promise<void> {
    const workerCfg: GoalWorkerConfig = { iterationsPerCycle: this.config.iterationsPerCycle };
    for (let i = 0; i < this.config.concurrency; i++) {
      this.workers.push(new GoalWorker(this.deps.coreLoopFactory(), workerCfg));
    }

    this.running = true;
    this.loadState();

    for (const goalId of initialGoalIds) {
      this.deps.eventBus.push(createEnvelope({
        type: 'event',
        name: 'goal_activated',
        source: 'supervisor',
        goal_id: goalId,
        payload: {},
        priority: 'normal',
      }));
    }

    this.pollTimer = setInterval(() => this.pollAndAssign(), this.config.pollIntervalMs);
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    await Promise.allSettled(this.runningExecutions);
    this.persistState();
  }

  getState(): SupervisorState {
    return {
      workers: this.workers.map(w => ({
        workerId: w.id,
        goalId: w.getCurrentGoalId(),
        startedAt: w.getStartedAt(),
        iterations: 0,
      })),
      crashCounts: Object.fromEntries(this.crashCounts),
      suspendedGoals: [...this.suspendedGoals],
      updatedAt: Date.now(),
    };
  }

  private pollAndAssign(): void {
    if (!this.running) return;

    const idleWorkers = this.workers.filter(w => w.isIdle());
    const requeue: Envelope[] = [];
    for (const worker of idleWorkers) {
      const envelope: Envelope | undefined = this.deps.eventBus.pull();
      if (envelope === undefined) break;

      if (envelope.name !== 'goal_activated') {
        requeue.push(envelope);
        continue;
      }

      const goalId = envelope.goal_id;
      if (!goalId) continue;

      if (this.activeGoals.has(goalId)) {
        this.activeGoals.get(goalId)!.requestExtend();
        continue;
      }

      if (this.suspendedGoals.has(goalId)) continue;

      this.activeGoals.set(goalId, worker);
      const execution = this.executeWorker(worker, goalId);
      this.runningExecutions.push(execution);
      execution.finally(() => {
        const idx = this.runningExecutions.indexOf(execution);
        if (idx !== -1) this.runningExecutions.splice(idx, 1);
      });
    }

    for (const env of requeue) {
      this.deps.eventBus.push(env);
    }
  }

  private async executeWorker(worker: GoalWorker, goalId: string): Promise<void> {
    try {
      const result: WorkerResult = await worker.execute(goalId);

      if (result.status === 'error') {
        const count = (this.crashCounts.get(goalId) ?? 0) + 1;
        this.crashCounts.set(goalId, count);

        if (count >= this.config.maxCrashCount) {
          this.suspendedGoals.add(goalId);
          this.deps.logger?.warn('Goal suspended after max crashes', {
            goalId, crashCount: count,
          });
          this.deps.onEscalation?.(goalId, count, result.error ?? 'unknown error');
        } else {
          const jitter = Math.random() * 0.3;
          const backoffMs = Math.min(
            this.config.crashBackoffBaseMs * Math.pow(2, count - 1) * (1 + jitter),
            30_000
          );
          const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            if (!this.running) return;
            this.deps.eventBus.push(createEnvelope({
              type: 'event',
              name: 'goal_activated',
              source: 'supervisor',
              goal_id: goalId,
              payload: {},
              priority: 'normal',
            }));
          }, backoffMs);
          this.pendingTimers.add(timer);
        }
      }
    } finally {
      this.activeGoals.delete(goalId);
      this.persistState();
    }
  }

  private persistState(): void {
    const state = this.getState();
    const filePath = this.config.stateFilePath;
    const tmpPath = filePath + '.tmp';
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      this.deps.logger?.error('Failed to persist supervisor state', { err: String(err) });
    }
  }

  private loadState(): void {
    const filePath = this.config.stateFilePath;
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf8');
      const state: SupervisorState = JSON.parse(raw);
      for (const [goalId, count] of Object.entries(state.crashCounts)) {
        this.crashCounts.set(goalId, count);
      }
      for (const goalId of state.suspendedGoals) {
        this.suspendedGoals.add(goalId);
      }
    } catch {
      // Corrupt or missing state — start fresh
    }
  }
}
