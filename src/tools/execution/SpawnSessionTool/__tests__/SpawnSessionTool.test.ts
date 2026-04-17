import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpawnSessionTool, resolveSpawnSessionType } from "../SpawnSessionTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { SessionManager } from "../../../../orchestrator/execution/session-manager.js";
import { DEFAULT_CONTEXT_BUDGET } from "../../../../orchestrator/execution/session-manager.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

const mockSession = {
  id: "session-abc",
  session_type: "task_execution",
  goal_id: "goal-1",
  task_id: null,
  context_slots: [],
  context_budget: 4096,
  started_at: new Date().toISOString(),
  ended_at: null,
  result_summary: null,
};

describe("SpawnSessionTool", () => {
  let sessionManager: SessionManager;
  let tool: SpawnSessionTool;

  beforeEach(() => {
    sessionManager = {
      createSession: vi.fn(),
    } as unknown as SessionManager;
    tool = new SpawnSessionTool(sessionManager);
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("spawn-session");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("session");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("session");
  });

  it("checkPermissions returns needs_approval", async () => {
    const result = await tool.checkPermissions(
      { session_type: "task_execution", goal_id: "goal-1" },
      makeContext(),
    );
    expect(result.status).toBe("needs_approval");
  });

  it("isConcurrencySafe returns false", () => {
    expect(tool.isConcurrencySafe({ session_type: "observation", goal_id: "goal-1" })).toBe(false);
  });

  it("creates session successfully", async () => {
    vi.mocked(sessionManager.createSession).mockResolvedValue(mockSession as any);

    const result = await tool.call(
      { session_type: "task_execution", goal_id: "goal-1" },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { sessionId: string };
    expect(data.sessionId).toBe("session-abc");
    expect(result.summary).toContain("session-abc");
  });

  it("passes task_id and context_budget when provided", async () => {
    vi.mocked(sessionManager.createSession).mockResolvedValue(mockSession as any);

    await tool.call(
      { session_type: "observation", goal_id: "goal-1", task_id: "task-x", context_budget: 2048 },
      makeContext(),
    );
    expect(sessionManager.createSession).toHaveBeenCalledWith("observation", "goal-1", "task-x", 2048);
  });

  it("maps explorer role to observation session", async () => {
    expect(resolveSpawnSessionType({ role: "explorer" } as any)).toBe("observation");
    expect(resolveSpawnSessionType({ role: "worker" } as any)).toBe("task_execution");
    expect(resolveSpawnSessionType({ role: "reviewer" } as any)).toBe("task_review");
  });

  it("creates a role-based session when role is provided without session_type", async () => {
    vi.mocked(sessionManager.createSession).mockResolvedValue({ ...mockSession, session_type: "task_review" } as any);

    const result = await tool.call(
      { role: "reviewer", goal_id: "goal-1" } as any,
      makeContext(),
    );

    expect(sessionManager.createSession).toHaveBeenCalledWith("task_review", "goal-1", null, DEFAULT_CONTEXT_BUDGET);
    expect(result.summary).toContain("role=reviewer");
  });

  it("handles sessionManager error gracefully", async () => {
    vi.mocked(sessionManager.createSession).mockRejectedValue(new Error("disk full"));

    const result = await tool.call(
      { session_type: "task_execution", goal_id: "goal-1" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("disk full");
  });

  it("rejects missing required params via Zod schema", () => {
    const parsed = tool.inputSchema.safeParse({ session_type: "task_execution" });
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid session_type", () => {
    const parsed = tool.inputSchema.safeParse({ session_type: "invalid_type", goal_id: "goal-1" });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing both session_type and role", () => {
    const parsed = tool.inputSchema.safeParse({ goal_id: "goal-1" });
    expect(parsed.success).toBe(false);
  });
});
