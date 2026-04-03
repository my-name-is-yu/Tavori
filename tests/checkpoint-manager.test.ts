import { describe, it, expect, vi, beforeEach } from "vitest";
import { CheckpointManager } from "../src/execution/checkpoint-manager.js";
import type { StateManager } from "../src/state/state-manager.js";
import type { CheckpointIndex } from "../src/types/checkpoint.js";

// ─── Helpers ───

function makeStoreBacked() {
  const stored: Record<string, unknown> = {};
  const stateManager = {
    readRaw: vi.fn(async (path: string) => stored[path] ?? null),
    writeRaw: vi.fn(async (path: string, data: unknown) => {
      stored[path] = data;
    }),
    getBaseDir: vi.fn(() => "/tmp/test-pulseed"),
  } as unknown as StateManager;
  return { stored, stateManager };
}

function makeLlmClient(responseContent = "adapted context") {
  return {
    chat: vi.fn(async (_messages: Array<{ role: string; content: string }>) => ({
      content: responseContent,
    })),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeIndexWithEntries(
  goalId: string,
  entries: Array<{ checkpoint_id: string; task_id: string; agent_id: string; created_at: string }>,
): CheckpointIndex {
  return { goal_id: goalId, checkpoints: entries };
}

function indexPath(goalId: string) {
  return `checkpoints/${goalId}/index.json`;
}

function checkpointPath(goalId: string, checkpointId: string) {
  return `checkpoints/${goalId}/${checkpointId}.json`;
}

const GOAL_ID = "goal-abc";
const TASK_ID = "task-001";
const AGENT_ID = "claude-code-cli";

// ─── Tests ───

describe("CheckpointManager", () => {
  let stored: Record<string, unknown>;
  let stateManager: StateManager;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    ({ stored, stateManager } = makeStoreBacked());
    logger = makeLogger();
  });

  // ─── saveCheckpoint ───

  describe("saveCheckpoint", () => {
    it("saves checkpoint and updates index", async () => {
      const manager = new CheckpointManager({ stateManager, logger });

      const checkpoint = await manager.saveCheckpoint({
        goalId: GOAL_ID,
        taskId: TASK_ID,
        agentId: AGENT_ID,
        sessionContextSnapshot: "context snapshot text",
      });

      expect(checkpoint.goal_id).toBe(GOAL_ID);
      expect(checkpoint.task_id).toBe(TASK_ID);
      expect(checkpoint.agent_id).toBe(AGENT_ID);
      expect(checkpoint.session_context_snapshot).toBe("context snapshot text");
      expect(checkpoint.intermediate_results).toEqual([]);
      expect(checkpoint.checkpoint_id).toBeTruthy();
      expect(checkpoint.created_at).toBeTruthy();

      // writeRaw called twice: checkpoint file + index
      expect(stateManager.writeRaw).toHaveBeenCalledTimes(2);

      // Index should contain the new entry
      const savedIndex = stored[indexPath(GOAL_ID)] as CheckpointIndex;
      expect(savedIndex.checkpoints).toHaveLength(1);
      expect(savedIndex.checkpoints[0].checkpoint_id).toBe(checkpoint.checkpoint_id);
      expect(savedIndex.checkpoints[0].task_id).toBe(TASK_ID);
      expect(savedIndex.checkpoints[0].agent_id).toBe(AGENT_ID);
    });

    it("appends to existing index", async () => {
      const existingId = "existing-checkpoint-id";
      const existingIndex = makeIndexWithEntries(GOAL_ID, [
        {
          checkpoint_id: existingId,
          task_id: TASK_ID,
          agent_id: AGENT_ID,
          created_at: new Date(Date.now() - 10_000).toISOString(),
        },
      ]);
      stored[indexPath(GOAL_ID)] = existingIndex;

      const manager = new CheckpointManager({ stateManager, logger });
      const newCheckpoint = await manager.saveCheckpoint({
        goalId: GOAL_ID,
        taskId: TASK_ID,
        agentId: AGENT_ID,
        sessionContextSnapshot: "new context",
      });

      const savedIndex = stored[indexPath(GOAL_ID)] as CheckpointIndex;
      expect(savedIndex.checkpoints).toHaveLength(2);
      const ids = savedIndex.checkpoints.map((c) => c.checkpoint_id);
      expect(ids).toContain(existingId);
      expect(ids).toContain(newCheckpoint.checkpoint_id);
    });

    it("includes intermediate results when provided", async () => {
      const manager = new CheckpointManager({ stateManager, logger });

      const checkpoint = await manager.saveCheckpoint({
        goalId: GOAL_ID,
        taskId: TASK_ID,
        agentId: AGENT_ID,
        sessionContextSnapshot: "snapshot",
        intermediateResults: ["result1", "result2"],
      });

      expect(checkpoint.intermediate_results).toEqual(["result1", "result2"]);
    });
  });

  // ─── loadCheckpoint ───

  describe("loadCheckpoint", () => {
    it("loads latest checkpoint for goal", async () => {
      const olderAt = new Date(Date.now() - 60_000).toISOString();
      const newerAt = new Date().toISOString();
      const oldId = "checkpoint-old";
      const newId = "checkpoint-new";

      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: oldId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: olderAt },
        { checkpoint_id: newId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: newerAt },
      ]);
      stored[indexPath(GOAL_ID)] = index;

      const newCheckpointData = {
        checkpoint_id: newId,
        goal_id: GOAL_ID,
        task_id: TASK_ID,
        agent_id: AGENT_ID,
        session_context_snapshot: "latest snapshot",
        intermediate_results: [],
        created_at: newerAt,
        metadata: {},
      };
      stored[checkpointPath(GOAL_ID, newId)] = newCheckpointData;

      const manager = new CheckpointManager({ stateManager, logger });
      const result = await manager.loadCheckpoint(GOAL_ID);

      expect(result).not.toBeNull();
      expect(result?.checkpoint_id).toBe(newId);
      expect(result?.session_context_snapshot).toBe("latest snapshot");
    });

    it("filters by taskId when provided", async () => {
      const task1At = new Date().toISOString();
      const task2At = new Date().toISOString();
      const task1Id = "cp-task1";
      const task2Id = "cp-task2";

      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: task1Id, task_id: "task-001", agent_id: AGENT_ID, created_at: task1At },
        { checkpoint_id: task2Id, task_id: "task-002", agent_id: AGENT_ID, created_at: task2At },
      ]);
      stored[indexPath(GOAL_ID)] = index;

      const task1Data = {
        checkpoint_id: task1Id,
        goal_id: GOAL_ID,
        task_id: "task-001",
        agent_id: AGENT_ID,
        session_context_snapshot: "task1 snapshot",
        intermediate_results: [],
        created_at: task1At,
        metadata: {},
      };
      stored[checkpointPath(GOAL_ID, task1Id)] = task1Data;

      const manager = new CheckpointManager({ stateManager, logger });
      const result = await manager.loadCheckpoint(GOAL_ID, "task-001");

      expect(result).not.toBeNull();
      expect(result?.checkpoint_id).toBe(task1Id);
      expect(result?.task_id).toBe("task-001");
    });

    it("returns null when no checkpoints exist", async () => {
      // readRaw returns null for index (default in makeStoreBacked)
      const manager = new CheckpointManager({ stateManager, logger });
      const result = await manager.loadCheckpoint(GOAL_ID);
      expect(result).toBeNull();
    });

    it("returns null when checkpoint file is missing", async () => {
      const cpId = "missing-file-cp";
      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: cpId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: new Date().toISOString() },
      ]);
      stored[indexPath(GOAL_ID)] = index;
      // Checkpoint file is NOT stored — readRaw will return null

      const manager = new CheckpointManager({ stateManager, logger });
      const result = await manager.loadCheckpoint(GOAL_ID);
      expect(result).toBeNull();
    });
  });

  // ─── loadAndAdaptCheckpoint ───

  describe("loadAndAdaptCheckpoint", () => {
    function seedCheckpoint(agentId: string, cpId = "cp-1") {
      const createdAt = new Date().toISOString();
      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: cpId, task_id: TASK_ID, agent_id: agentId, created_at: createdAt },
      ]);
      stored[indexPath(GOAL_ID)] = index;
      stored[checkpointPath(GOAL_ID, cpId)] = {
        checkpoint_id: cpId,
        goal_id: GOAL_ID,
        task_id: TASK_ID,
        agent_id: agentId,
        session_context_snapshot: "original snapshot",
        intermediate_results: ["step1", "step2"],
        created_at: createdAt,
        metadata: {},
      };
    }

    it("returns unadapted context when agent matches", async () => {
      seedCheckpoint(AGENT_ID);
      const llmClient = makeLlmClient();

      const manager = new CheckpointManager({ stateManager, llmClient, logger });
      const result = await manager.loadAndAdaptCheckpoint(GOAL_ID, AGENT_ID);

      expect(result).not.toBeNull();
      expect(result?.wasAdapted).toBe(false);
      expect(result?.adaptedContext).toBe("original snapshot");
      expect(llmClient.chat).not.toHaveBeenCalled();
    });

    it("adapts context via LLM when agent differs", async () => {
      seedCheckpoint("agent-old");
      const llmClient = makeLlmClient("adapted context for new agent");

      const manager = new CheckpointManager({ stateManager, llmClient, logger });
      const result = await manager.loadAndAdaptCheckpoint(GOAL_ID, "agent-new");

      expect(result).not.toBeNull();
      expect(result?.wasAdapted).toBe(true);
      expect(result?.adaptedContext).toBe("adapted context for new agent");

      // Verify LLM prompt includes both agent IDs
      const call = llmClient.chat.mock.calls[0];
      const prompt = call[0][0].content as string;
      expect(prompt).toContain("agent-old");
      expect(prompt).toContain("agent-new");
    });

    it("returns unadapted when no llmClient and agent differs", async () => {
      seedCheckpoint("agent-original");

      const manager = new CheckpointManager({ stateManager, logger }); // no llmClient
      const result = await manager.loadAndAdaptCheckpoint(GOAL_ID, "agent-different");

      expect(result).not.toBeNull();
      expect(result?.wasAdapted).toBe(false);
      expect(result?.adaptedContext).toBe("original snapshot");
    });

    it("returns null when no checkpoint exists", async () => {
      // No data seeded — index is empty
      const manager = new CheckpointManager({ stateManager, logger });
      const result = await manager.loadAndAdaptCheckpoint(GOAL_ID, AGENT_ID);
      expect(result).toBeNull();
    });
  });

  // ─── deleteCheckpoint ───

  describe("deleteCheckpoint", () => {
    it("removes checkpoint file and updates index", async () => {
      const cpId = "cp-to-delete";
      const keepId = "cp-to-keep";
      const now = new Date().toISOString();

      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: cpId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: now },
        { checkpoint_id: keepId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: now },
      ]);
      stored[indexPath(GOAL_ID)] = index;
      stored[checkpointPath(GOAL_ID, cpId)] = { checkpoint_id: cpId };
      stored[checkpointPath(GOAL_ID, keepId)] = { checkpoint_id: keepId };

      const manager = new CheckpointManager({ stateManager, logger });
      await manager.deleteCheckpoint(GOAL_ID, cpId);

      // Index no longer contains deleted entry
      const updatedIndex = stored[indexPath(GOAL_ID)] as CheckpointIndex;
      const ids = updatedIndex.checkpoints.map((c) => c.checkpoint_id);
      expect(ids).not.toContain(cpId);
      expect(ids).toContain(keepId);
    });
  });

  // ─── garbageCollect ───

  describe("garbageCollect", () => {
    it("deletes checkpoints older than maxAgeDays and returns count", async () => {
      const oldAt = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 days ago
      const newAt = new Date(Date.now() - 1 * 86_400_000).toISOString(); // 1 day ago
      const oldId = "cp-old";
      const newId = "cp-new";

      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: oldId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: oldAt },
        { checkpoint_id: newId, task_id: TASK_ID, agent_id: AGENT_ID, created_at: newAt },
      ]);
      stored[indexPath(GOAL_ID)] = index;

      const manager = new CheckpointManager({ stateManager, logger });
      const count = await manager.garbageCollect(GOAL_ID, 7);

      expect(count).toBe(1);

      // Index should only contain the new checkpoint
      const updatedIndex = stored[indexPath(GOAL_ID)] as CheckpointIndex;
      expect(updatedIndex.checkpoints).toHaveLength(1);
      expect(updatedIndex.checkpoints[0].checkpoint_id).toBe(newId);
    });

    it("returns 0 when no old checkpoints", async () => {
      const recentAt = new Date(Date.now() - 1 * 86_400_000).toISOString();
      const index = makeIndexWithEntries(GOAL_ID, [
        { checkpoint_id: "cp-recent", task_id: TASK_ID, agent_id: AGENT_ID, created_at: recentAt },
      ]);
      stored[indexPath(GOAL_ID)] = index;

      const manager = new CheckpointManager({ stateManager, logger });
      const count = await manager.garbageCollect(GOAL_ID, 7);

      expect(count).toBe(0);
    });

    it("handles empty index", async () => {
      // No index stored — readRaw returns null, defaults to empty
      const manager = new CheckpointManager({ stateManager, logger });
      const count = await manager.garbageCollect(GOAL_ID, 7);

      expect(count).toBe(0);
    });
  });
});
