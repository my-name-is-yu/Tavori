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
import { GoalLeaseManager } from '../goal-lease-manager.js';
import { JournalBackedQueue, type JournalBackedQueueClaim } from '../queue/journal-backed-queue.js';
import { StateFenceError } from '../../base/utils/errors.js';

export interface SupervisorConfig {
  concurrency: number;
  iterationsPerCycle: number;
  maxCrashCount: number;
  crashBackoffBaseMs: number;
  stateFilePath: string;
  pollIntervalMs: number;
  claimLeaseMs: number;
  leaseRenewIntervalMs: number;
}

export interface SupervisorDeps {
  coreLoopFactory: () => CoreLoop;
  eventBus?: EventBus;
  journalQueue?: JournalBackedQueue;
  goalLeaseManager?: GoalLeaseManager;
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

interface DurableGoalActivation {
  mode: 'journal';
  goalId: string;
  claim: JournalBackedQueueClaim;
  ownerToken: string;
  attemptId: string;
}

interface LegacyGoalActivation {
  mode: 'eventBus';
  goalId: string;
}

interface LegacyNonGoalEnvelope {
  mode: 'legacy_non_goal';
  envelope: Envelope;
}

type GoalActivation = DurableGoalActivation | LegacyGoalActivation;
type ClaimedDispatch = GoalActivation | LegacyNonGoalEnvelope;

const DEFAULT_CONFIG: SupervisorConfig = {
  concurrency: 4,
  iterationsPerCycle: 5,
  maxCrashCount: 3,
  crashBackoffBaseMs: 1000,
  stateFilePath: join(homedir(), '.pulseed', 'supervisor-state.json'),
  pollIntervalMs: 100,
  claimLeaseMs: 30_000,
  leaseRenewIntervalMs: 10_000,
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
  private readonly durableExecutionEnabled: boolean;
  private polling: boolean = false;
  private runningExecutions: Promise<void>[] = [];
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(deps: SupervisorDeps, config?: Partial<SupervisorConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.durableExecutionEnabled = Boolean(this.deps.journalQueue && this.deps.goalLeaseManager);
  }

  async start(initialGoalIds: string[]): Promise<void> {
    if (!this.deps.eventBus && !this.durableExecutionEnabled) {
      throw new Error('LoopSupervisor requires eventBus or durable runtime queue dependencies');
    }

    const workerCfg: GoalWorkerConfig = { iterationsPerCycle: this.config.iterationsPerCycle };
    for (let i = 0; i < this.config.concurrency; i++) {
      this.workers.push(new GoalWorker(this.deps.coreLoopFactory(), workerCfg));
    }

    this.running = true;
    this.loadState();

    for (const goalId of initialGoalIds) {
      this.enqueueGoalActivation(goalId);
    }

    this.pollTimer = setInterval(() => {
      void this.pollAndAssign();
    }, this.config.pollIntervalMs);
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

  private enqueueGoalActivation(goalId: string): void {
    const envelope = createEnvelope({
      type: 'event',
      name: 'goal_activated',
      source: 'supervisor',
      goal_id: goalId,
      payload: {},
      priority: 'normal',
      dedupe_key: `goal_activated:${goalId}`,
    });

    if (this.durableExecutionEnabled) {
      const accepted = this.deps.journalQueue!.accept(envelope);
      if (!accepted.accepted && !accepted.duplicate) {
        this.deps.logger?.warn('Failed to enqueue durable goal activation', {
          goalId,
          envelopeId: envelope.id,
        });
      }
      return;
    }

    this.deps.eventBus!.push(envelope);
  }

  private async pollAndAssign(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;

    const idleWorkers = this.workers.filter(w => w.isIdle());
    const requeue: Envelope[] = [];

    try {
      for (const worker of idleWorkers) {
        const dispatch = await this.claimNextDispatch(worker.id);
        if (!dispatch) break;

        if (dispatch.mode === 'legacy_non_goal') {
          requeue.push(dispatch.envelope);
          continue;
        }

        const goalId = dispatch.goalId;
        if (this.activeGoals.has(goalId)) {
          this.activeGoals.get(goalId)!.requestExtend();
          await this.completeClaim(dispatch);
          continue;
        }

        if (this.suspendedGoals.has(goalId)) {
          await this.failClaim(dispatch, 'goal suspended', false);
          continue;
        }

        if (!(await this.acquireExecutionLease(worker, dispatch))) {
          await this.failClaim(dispatch, 'goal lease unavailable', true);
          continue;
        }

        this.activeGoals.set(goalId, worker);
        const execution = this.executeWorker(worker, dispatch);
        this.runningExecutions.push(execution);
        execution.finally(() => {
          const idx = this.runningExecutions.indexOf(execution);
          if (idx !== -1) this.runningExecutions.splice(idx, 1);
        });
      }
    } finally {
      for (const env of requeue) {
        this.deps.eventBus?.push(env);
      }
      this.polling = false;
    }
  }

  private async claimNextDispatch(workerId: string): Promise<ClaimedDispatch | null> {
    if (this.durableExecutionEnabled) {
      const claim = this.deps.journalQueue!.claim(
        workerId,
        this.config.claimLeaseMs,
        (envelope) => envelope.type === 'event' && envelope.name === 'goal_activated' && Boolean(envelope.goal_id)
      );
      if (!claim || !claim.envelope.goal_id) {
        return null;
      }
      return {
        mode: 'journal',
        goalId: claim.envelope.goal_id,
        claim,
        ownerToken: claim.claimToken,
        attemptId: claim.claimToken,
      };
    }

    const envelope = this.deps.eventBus?.pull();
    if (envelope === undefined) {
      return null;
    }
    if (envelope.name !== 'goal_activated' || !envelope.goal_id) {
      return { mode: 'legacy_non_goal', envelope };
    }
    return {
      mode: 'eventBus',
      goalId: envelope.goal_id,
    };
  }

  private async acquireExecutionLease(worker: GoalWorker, activation: GoalActivation): Promise<boolean> {
    if (activation.mode !== 'journal') {
      return true;
    }

    const lease = await this.deps.goalLeaseManager!.acquire(activation.goalId, {
      workerId: worker.id,
      ownerToken: activation.ownerToken,
      attemptId: activation.attemptId,
      leaseMs: this.config.claimLeaseMs,
    });
    return lease !== null;
  }

  private startLeaseRenewLoop(activation: GoalActivation, onLeaseLost: () => void): () => void {
    if (activation.mode !== 'journal') {
      return () => {};
    }

    let stopped = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (stopped || renewing) return;

      renewing = true;
      void (async () => {
        try {
          const renewedClaim = this.deps.journalQueue!.renew(
            activation.claim.claimToken,
            this.config.claimLeaseMs
          );
          const renewedLease = await this.deps.goalLeaseManager!.renew(
            activation.goalId,
            activation.ownerToken,
            { leaseMs: this.config.claimLeaseMs }
          );

          if (!renewedClaim || !renewedLease) {
            stopped = true;
            clearInterval(timer);
            this.deps.logger?.warn('Lost durable execution ownership during renewal', {
              goalId: activation.goalId,
              claimToken: activation.claim.claimToken,
            });
            onLeaseLost();
          }
        } catch (err) {
          this.deps.logger?.warn('Failed to renew durable execution ownership', {
            goalId: activation.goalId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          renewing = false;
        }
      })();
    }, this.config.leaseRenewIntervalMs);

    timer.unref?.();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async executeWorker(worker: GoalWorker, activation: GoalActivation): Promise<void> {
    const { goalId } = activation;
    let ownershipLost = false;
    this.installWriteFence(activation);
    const stopRenewal = this.startLeaseRenewLoop(activation, () => {
      ownershipLost = true;
    });

    try {
      const result: WorkerResult = await worker.execute(goalId);

      if (result.status === 'error') {
        const count = (this.crashCounts.get(goalId) ?? 0) + 1;
        this.crashCounts.set(goalId, count);

        if (count >= this.config.maxCrashCount) {
          this.suspendedGoals.add(goalId);
          this.deps.logger?.warn('Goal suspended after max crashes', {
            goalId,
            crashCount: count,
          });
          this.deps.onEscalation?.(goalId, count, result.error ?? 'unknown error');
          await this.failClaim(
            activation,
            result.error ?? 'goal suspended after max crashes',
            false,
            ownershipLost
          );
        } else {
          const backoffMs = this.calculateCrashBackoff(count);
          if (activation.mode === 'journal') {
            await this.deferDurableRetry(
              activation,
              result.error ?? 'goal execution failed',
              backoffMs,
              ownershipLost
            );
          } else {
            const timer = setTimeout(() => {
              this.pendingTimers.delete(timer);
              if (!this.running) return;
              this.enqueueGoalActivation(goalId);
            }, backoffMs);
            this.pendingTimers.add(timer);
          }
        }

        return;
      }

      await this.completeClaim(activation, ownershipLost);
    } finally {
      stopRenewal();
      this.clearWriteFence(goalId);
      await this.releaseExecutionLease(activation);
      this.activeGoals.delete(goalId);
      this.persistState();
    }
  }

  private async completeClaim(activation: GoalActivation, ownershipLost = false): Promise<void> {
    if (activation.mode !== 'journal' || ownershipLost) {
      if (activation.mode === 'journal' && ownershipLost) {
        this.deps.logger?.warn('Skipping ack because durable execution ownership was lost', {
          goalId: activation.goalId,
          claimToken: activation.claim.claimToken,
        });
      }
      return;
    }

    const acked = this.deps.journalQueue!.ack(activation.claim.claimToken);
    if (!acked) {
      this.deps.logger?.warn('Failed to ack durable goal activation claim', {
        goalId: activation.goalId,
        claimToken: activation.claim.claimToken,
      });
    }
  }

  private async failClaim(
    activation: GoalActivation,
    reason: string,
    requeue: boolean,
    ownershipLost = false
  ): Promise<void> {
    if (activation.mode !== 'journal' || ownershipLost) {
      return;
    }

    const settled = this.deps.journalQueue!.nack(activation.claim.claimToken, reason, requeue);
    if (!settled) {
      this.deps.logger?.warn('Failed to nack durable goal activation claim', {
        goalId: activation.goalId,
        claimToken: activation.claim.claimToken,
        reason,
        requeue,
      });
    }
  }

  private async releaseExecutionLease(activation: GoalActivation): Promise<void> {
    if (activation.mode !== 'journal') {
      return;
    }

    try {
      await this.deps.goalLeaseManager!.release(activation.goalId, activation.ownerToken);
    } catch (err) {
      this.deps.logger?.warn('Failed to release goal execution lease', {
        goalId: activation.goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private calculateCrashBackoff(crashCount: number): number {
    const jitter = Math.random() * 0.3;
    return Math.min(
      this.config.crashBackoffBaseMs * Math.pow(2, crashCount - 1) * (1 + jitter),
      30_000
    );
  }

  private async deferDurableRetry(
    activation: DurableGoalActivation,
    reason: string,
    backoffMs: number,
    ownershipLost: boolean
  ): Promise<void> {
    if (ownershipLost) {
      return;
    }

    const leaseMs = backoffMs + Math.max(this.config.pollIntervalMs, 100);
    const renewedClaim = this.deps.journalQueue!.renew(activation.claim.claimToken, leaseMs);
    if (!renewedClaim) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (!this.running) return;
      void this.failClaim(activation, reason, true, false);
    }, backoffMs);
    this.pendingTimers.add(timer);
  }

  private installWriteFence(activation: GoalActivation): void {
    if (activation.mode !== 'journal') {
      return;
    }

    this.deps.stateManager.setWriteFence?.(activation.goalId, async () => {
      const current = await this.deps.goalLeaseManager!.read(activation.goalId);
      if (
        !current ||
        current.owner_token !== activation.ownerToken ||
        current.attempt_id !== activation.attemptId ||
        current.lease_until <= Date.now()
      ) {
        throw new StateFenceError(
          `Write fence rejected commit for goal "${activation.goalId}" because execution ownership is stale`
        );
      }
    });
  }

  private clearWriteFence(goalId: string): void {
    this.deps.stateManager.clearWriteFence?.(goalId);
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
