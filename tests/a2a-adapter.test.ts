import { describe, it, expect, beforeEach, vi } from "vitest";
import { A2AAdapter } from "../src/adapters/a2a-adapter.js";
import { A2AClient } from "../src/adapters/a2a-client.js";
import { AdapterRegistry } from "../src/execution/adapter-layer.js";
import type { AgentTask } from "../src/execution/adapter-layer.js";
import type { A2ATask, A2AAgentCard } from "../src/types/a2a.js";

// ─── Mock A2AClient ───

vi.mock("../src/adapters/a2a-client.js", () => {
  const A2AClient = vi.fn();
  A2AClient.prototype.fetchAgentCard = vi.fn();
  A2AClient.prototype.sendMessage = vi.fn();
  A2AClient.prototype.sendMessageStream = vi.fn();
  A2AClient.prototype.getTask = vi.fn();
  A2AClient.prototype.cancelTask = vi.fn();
  A2AClient.prototype.waitForCompletion = vi.fn();
  return { A2AClient };
});

// ─── Helpers ───

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "Do something useful",
    timeout_ms: 5000,
    adapter_type: "a2a",
    ...overrides,
  };
}

function a2aTask(
  state: string,
  opts?: { output?: string; message?: string; history?: boolean }
): A2ATask {
  const task: A2ATask = {
    id: "task-1",
    status: {
      state: state as A2ATask["status"]["state"],
      timestamp: new Date().toISOString(),
      ...(opts?.message ? { message: opts.message } : {}),
    },
  };
  if (opts?.output) {
    task.artifacts = [
      { parts: [{ kind: "text", text: opts.output }] },
    ];
  }
  if (opts?.history) {
    task.history = [
      {
        role: "user",
        parts: [{ kind: "text", text: "user msg" }],
      },
      {
        role: "agent",
        parts: [{ kind: "text", text: "agent response from history" }],
      },
    ];
  }
  return task;
}

function agentCard(
  overrides: Partial<A2AAgentCard> = {}
): A2AAgentCard {
  return {
    name: "Test Agent",
    url: "https://agent.example.com",
    capabilities: { streaming: false },
    skills: [
      {
        id: "code_gen",
        name: "Code Generation",
        tags: ["coding", "typescript"],
      },
      { id: "analysis", name: "Analysis" },
    ],
    ...overrides,
  };
}

function getMockedClient(): {
  fetchAgentCard: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageStream: ReturnType<typeof vi.fn>;
  waitForCompletion: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
} {
  return A2AClient.prototype as unknown as ReturnType<typeof getMockedClient>;
}

// ─── Tests ───

describe("A2AAdapter", () => {
  let adapter: A2AAdapter;
  let mocked: ReturnType<typeof getMockedClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new A2AAdapter({
      baseUrl: "https://agent.example.com",
    });
    mocked = getMockedClient();
  });

  // ─── Constructor defaults ───

  describe("constructor", () => {
    it("adapterType defaults to 'a2a'", () => {
      expect(adapter.adapterType).toBe("a2a");
    });

    it("adapterType accepts custom name", () => {
      const custom = new A2AAdapter({
        baseUrl: "https://agent.example.com",
        adapterType: "a2a_research_agent",
      });
      expect(custom.adapterType).toBe("a2a_research_agent");
    });
  });

  // ─── Capabilities ───

  describe("capabilities", () => {
    it("derived from Agent Card skills", async () => {
      mocked.fetchAgentCard.mockResolvedValueOnce(agentCard());

      await adapter.discoverCapabilities();

      // Skills: code_gen has tags ["coding", "typescript"], analysis has no tags -> falls back to id
      expect(adapter.capabilities).toEqual([
        "coding",
        "typescript",
        "analysis",
      ]);
    });

    it("fallback to ['general_purpose'] when Agent Card fetch fails", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("Network error"));

      await adapter.discoverCapabilities();
      expect([...adapter.capabilities]).toEqual(["general_purpose"]);
    });

    it("uses config capabilities when provided", () => {
      const withCaps = new A2AAdapter({
        baseUrl: "https://agent.example.com",
        capabilities: ["search", "code"],
      });
      expect([...withCaps.capabilities]).toEqual(["search", "code"]);
    });
  });

  // ─── execute: success ───

  describe("execute", () => {
    it("returns success for completed task", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(
        a2aTask("completed", { output: "task result" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(true);
      expect(result.output).toBe("task result");
      expect(result.stopped_reason).toBe("completed");
      expect(result.error).toBeNull();
    });

    it("returns error for failed task", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(
        a2aTask("failed", { message: "Something went wrong" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(false);
      expect(result.error).toBe("Something went wrong");
      expect(result.stopped_reason).toBe("error");
    });

    it("returns error for rejected task", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(
        a2aTask("rejected", { message: "Not allowed" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(false);
      expect(result.error).toBe("Not allowed");
      expect(result.stopped_reason).toBe("error");
    });

    it("returns error for input-required task", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      // input-required is not a terminal state, so sendMessage returns it,
      // then waitForCompletion also returns it (simulating the remote agent stuck)
      mocked.sendMessage.mockResolvedValueOnce(
        a2aTask("input-required", { message: "Need more info" })
      );
      mocked.waitForCompletion.mockResolvedValueOnce(
        a2aTask("input-required", { message: "Need more info" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(false);
      expect(result.error).toContain("input-required");
      expect(result.error).toContain("PulSeed does not support interactive input");
      expect(result.stopped_reason).toBe("error");
    });

    it("returns timeout on AbortController abort", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      // Simulate a request that hangs longer than the timeout.
      // The adapter's setTimeout calls controller.abort() at timeout_ms,
      // which won't cancel our mock, but when the mock finally rejects,
      // the catch block sees controller.signal.aborted === true.
      mocked.sendMessage.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("still running")),
              200
            );
          })
      );

      const result = await adapter.execute(makeTask({ timeout_ms: 50 }));
      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("timeout");
      expect(result.error).toContain("Timed out");
    }, 10_000);

    // ─── Streaming vs polling ───

    it("uses streaming when agent advertises it", async () => {
      mocked.fetchAgentCard.mockResolvedValueOnce(
        agentCard({ capabilities: { streaming: true } })
      );
      mocked.sendMessageStream.mockResolvedValueOnce(
        a2aTask("completed", { output: "streamed" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(true);
      expect(result.output).toBe("streamed");
      expect(mocked.sendMessageStream).toHaveBeenCalled();
      expect(mocked.sendMessage).not.toHaveBeenCalled();
    });

    it("falls back to polling when streaming not supported", async () => {
      mocked.fetchAgentCard.mockResolvedValueOnce(
        agentCard({ capabilities: { streaming: false } })
      );
      mocked.sendMessage.mockResolvedValueOnce(
        a2aTask("completed", { output: "polled" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(true);
      expect(result.output).toBe("polled");
      expect(mocked.sendMessage).toHaveBeenCalled();
      expect(mocked.sendMessageStream).not.toHaveBeenCalled();
    });

    it("polls via waitForCompletion when initial task is not terminal", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(a2aTask("working"));
      mocked.waitForCompletion.mockResolvedValueOnce(
        a2aTask("completed", { output: "after polling" })
      );

      const result = await adapter.execute(makeTask());
      expect(result.success).toBe(true);
      expect(result.output).toBe("after polling");
      expect(mocked.waitForCompletion).toHaveBeenCalledWith(
        "task-1",
        expect.any(AbortSignal)
      );
    });
  });

  // ─── extractTextOutput ───

  describe("extractTextOutput", () => {
    it("prefers artifacts over history", async () => {
      const task: A2ATask = {
        id: "task-1",
        status: { state: "completed" },
        artifacts: [
          { parts: [{ kind: "text", text: "artifact text" }] },
        ],
        history: [
          {
            role: "agent",
            parts: [{ kind: "text", text: "history text" }],
          },
        ],
      };
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(task);

      const result = await adapter.execute(makeTask());
      expect(result.output).toBe("artifact text");
    });

    it("falls back to last agent message when no artifacts", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(
        a2aTask("completed", { history: true })
      );

      const result = await adapter.execute(makeTask());
      expect(result.output).toBe("agent response from history");
    });

    it("returns empty string when no artifacts and no history", async () => {
      mocked.fetchAgentCard.mockRejectedValueOnce(new Error("no card"));
      mocked.sendMessage.mockResolvedValueOnce(a2aTask("completed"));

      const result = await adapter.execute(makeTask());
      expect(result.output).toBe("");
    });
  });

  // ─── AdapterRegistry integration ───

  describe("AdapterRegistry integration", () => {
    it("can be registered in AdapterRegistry", () => {
      const registry = new AdapterRegistry();
      registry.register(adapter);
      expect(registry.getAdapter("a2a")).toBe(adapter);
      expect(registry.listAdapters()).toContain("a2a");
    });

    it("multiple A2A adapters can coexist in registry", () => {
      const registry = new AdapterRegistry();
      const research = new A2AAdapter({
        baseUrl: "https://research.example.com",
        adapterType: "a2a_research",
      });
      const codeGen = new A2AAdapter({
        baseUrl: "https://codegen.example.com",
        adapterType: "a2a_code_gen",
      });

      registry.register(research);
      registry.register(codeGen);

      expect(registry.getAdapter("a2a_research")).toBe(research);
      expect(registry.getAdapter("a2a_code_gen")).toBe(codeGen);
      expect(registry.listAdapters()).toContain("a2a_research");
      expect(registry.listAdapters()).toContain("a2a_code_gen");
    });
  });
});
