import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { StateManager } from '../../base/state/state-manager.js';
import {
  Checkpoint,
  CheckpointSchema,
  CheckpointIndex,
  CheckpointIndexSchema,
} from '../../base/types/checkpoint.js';
import type { IPromptGateway } from '../../prompt/gateway.js';

interface LLMClient {
  chat(messages: Array<{ role: string; content: string }>): Promise<{ content: string }>;
}

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const CheckpointAdaptResponseSchema = z.object({
  adapted_context: z.string(),
});

interface CheckpointManagerDeps {
  stateManager: StateManager;
  llmClient?: LLMClient;
  logger?: Logger;
  gateway?: IPromptGateway;
}

export class CheckpointManager {
  constructor(private readonly deps: CheckpointManagerDeps) {}

  private indexPath = (goalId: string) => `checkpoints/${goalId}/index.json`;
  private checkpointPath = (goalId: string, checkpointId: string) =>
    `checkpoints/${goalId}/${checkpointId}.json`;

  private async readIndex(goalId: string): Promise<CheckpointIndex> {
    const raw = await this.deps.stateManager.readRaw(this.indexPath(goalId));
    if (!raw) return { goal_id: goalId, checkpoints: [] };
    try {
      return CheckpointIndexSchema.parse(raw);
    } catch {
      this.deps.logger?.warn('checkpoint index parse failed, resetting', { goalId });
      return { goal_id: goalId, checkpoints: [] };
    }
  }

  private async writeIndex(index: CheckpointIndex): Promise<void> {
    await this.deps.stateManager.writeRaw(this.indexPath(index.goal_id), index);
  }

  async saveCheckpoint(params: {
    goalId: string;
    taskId: string;
    agentId: string;
    sessionContextSnapshot: string;
    intermediateResults?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Checkpoint> {
    const checkpoint = CheckpointSchema.parse({
      checkpoint_id: randomUUID(),
      goal_id: params.goalId,
      task_id: params.taskId,
      agent_id: params.agentId,
      session_context_snapshot: params.sessionContextSnapshot,
      intermediate_results: params.intermediateResults ?? [],
      created_at: new Date().toISOString(),
      metadata: params.metadata ?? {},
    });

    await this.deps.stateManager.writeRaw(
      this.checkpointPath(params.goalId, checkpoint.checkpoint_id),
      checkpoint,
    );

    const index = await this.readIndex(params.goalId);
    index.checkpoints.push({
      checkpoint_id: checkpoint.checkpoint_id,
      task_id: checkpoint.task_id,
      agent_id: checkpoint.agent_id,
      created_at: checkpoint.created_at,
    });
    await this.writeIndex(index);

    this.deps.logger?.info('checkpoint saved', {
      checkpointId: checkpoint.checkpoint_id,
      goalId: params.goalId,
    });

    return checkpoint;
  }

  async loadCheckpoint(goalId: string, taskId?: string): Promise<Checkpoint | null> {
    const index = await this.readIndex(goalId);
    let entries = index.checkpoints;
    if (taskId) entries = entries.filter((e) => e.task_id === taskId);
    if (entries.length === 0) return null;

    const latest = entries.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    const raw = await this.deps.stateManager.readRaw(
      this.checkpointPath(goalId, latest.checkpoint_id),
    );
    if (!raw) return null;

    try {
      return CheckpointSchema.parse(raw);
    } catch {
      this.deps.logger?.warn('checkpoint parse failed', {
        checkpointId: latest.checkpoint_id,
      });
      return null;
    }
  }

  async loadAndAdaptCheckpoint(
    goalId: string,
    currentAgentId: string,
    taskId?: string,
  ): Promise<{ checkpoint: Checkpoint; adaptedContext: string; wasAdapted: boolean } | null> {
    const checkpoint = await this.loadCheckpoint(goalId, taskId);
    if (!checkpoint) return null;

    if (checkpoint.agent_id === currentAgentId) {
      return { checkpoint, adaptedContext: checkpoint.session_context_snapshot, wasAdapted: false };
    }

    if (!this.deps.llmClient && !this.deps.gateway) {
      return { checkpoint, adaptedContext: checkpoint.session_context_snapshot, wasAdapted: false };
    }

    const prompt =
      `You are helping transfer context from agent '${checkpoint.agent_id}' to agent '${currentAgentId}'. ` +
      `Summarize and adapt the following session context and intermediate results for the new agent to continue the work.\n\n` +
      `Context:\n${checkpoint.session_context_snapshot}\n\n` +
      `Intermediate Results:\n${checkpoint.intermediate_results.join('\n')}`;

    try {
      if (this.deps.gateway) {
        const result = await this.deps.gateway.execute({
          purpose: "checkpoint_adapt",
          goalId,
          additionalContext: { adapt_prompt: prompt },
          responseSchema: CheckpointAdaptResponseSchema,
        });
        return { checkpoint, adaptedContext: result.adapted_context, wasAdapted: true };
      } else {
        const response = await this.deps.llmClient!.chat([{ role: 'user', content: prompt }]);
        return { checkpoint, adaptedContext: response.content, wasAdapted: true };
      }
    } catch (err) {
      this.deps.logger?.error('context adaptation failed', { error: String(err) });
      return { checkpoint, adaptedContext: checkpoint.session_context_snapshot, wasAdapted: false };
    }
  }

  async listCheckpoints(goalId: string): Promise<CheckpointIndex['checkpoints']> {
    const index = await this.readIndex(goalId);
    return index.checkpoints;
  }

  async deleteCheckpoint(goalId: string, checkpointId: string): Promise<void> {
    const filePath = path.join(
      this.deps.stateManager.getBaseDir(),
      this.checkpointPath(goalId, checkpointId),
    );
    await fsp.unlink(filePath).catch((err) => {
      console.error("[CheckpointManager] failed to delete checkpoint file:", err instanceof Error ? err.message : err);
    });
    const index = await this.readIndex(goalId);
    index.checkpoints = index.checkpoints.filter((e) => e.checkpoint_id !== checkpointId);
    await this.writeIndex(index);
    this.deps.logger?.info('checkpoint deleted', { checkpointId, goalId });
  }

  async garbageCollect(goalId: string, maxAgeDays = 7): Promise<number> {
    const index = await this.readIndex(goalId);
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const toDelete = index.checkpoints.filter(
      (e) => new Date(e.created_at).getTime() < cutoff,
    );

    for (const entry of toDelete) {
      const filePath = path.join(
        this.deps.stateManager.getBaseDir(),
        this.checkpointPath(goalId, entry.checkpoint_id),
      );
      await fsp.unlink(filePath).catch((err) => {
        console.error("[CheckpointManager] failed to delete checkpoint file during GC:", err instanceof Error ? err.message : err);
      });
    }

    const deletedIds = new Set(toDelete.map((e) => e.checkpoint_id));
    index.checkpoints = index.checkpoints.filter((e) => !deletedIds.has(e.checkpoint_id));
    await this.writeIndex(index);

    this.deps.logger?.info('garbage collected checkpoints', { goalId, count: toDelete.length });
    return toDelete.length;
  }
}
