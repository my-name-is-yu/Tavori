import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { createPersistentAgentLoopSessionFactory } from "../agent-loop-session-factory.js";
import { JsonAgentLoopSessionStateStore } from "../agent-loop-session-state.js";

describe("createPersistentAgentLoopSessionFactory", () => {
  it("persists trace events to jsonl files under the configured base directory", async () => {
    const baseDir = makeTempDir();
    const createSession = createPersistentAgentLoopSessionFactory({
      traceBaseDir: baseDir,
      kind: "chat",
    });
    const session = createSession();

    await session.traceStore.append({
      type: "started",
      eventId: "event-1",
      sessionId: session.sessionId,
      traceId: session.traceId,
      turnId: "turn-1",
      goalId: "goal-1",
      createdAt: new Date().toISOString(),
    });

    const tracesDir = path.join(baseDir, "traces", "agentloop", "chat");
    const files = await fs.readdir(tracesDir);
    expect(files).toHaveLength(1);

    const content = await fs.readFile(path.join(tracesDir, files[0]!), "utf-8");
    expect(content).toContain("\"type\":\"started\"");
    expect(content).toContain(session.traceId);
  });
});

describe("JsonAgentLoopSessionStateStore", () => {
  it("normalizes legacy state files that predate newer counters", async () => {
    const baseDir = makeTempDir();
    const statePath = path.join(baseDir, "legacy.state.json");
    await fs.writeFile(statePath, JSON.stringify({
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: baseDir,
      modelRef: "openai/gpt-test",
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: "Calling verify",
          toolCalls: [{ id: "call-1", name: "verify", input: { command: "npm test" } }],
        },
      ],
      modelTurns: 2,
      toolCalls: 1,
      compactions: 1,
      status: "running",
    }), "utf-8");

    const state = await new JsonAgentLoopSessionStateStore(statePath).load();

    expect(state).toMatchObject({
      sessionId: "session-1",
      traceId: "trace-1",
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "running",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(state?.messages[1]?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "verify",
      input: { command: "npm test" },
    });
  });

  it("returns null for corrupt or incompatible state files", async () => {
    const baseDir = makeTempDir();
    const corruptPath = path.join(baseDir, "corrupt.state.json");
    const incompatiblePath = path.join(baseDir, "incompatible.state.json");
    await fs.writeFile(corruptPath, "{", "utf-8");
    await fs.writeFile(incompatiblePath, JSON.stringify({
      sessionId: "session-1",
      traceId: "trace-1",
      goalId: "goal-1",
      messages: [{ role: "user", content: "missing turnId/cwd/modelRef" }],
    }), "utf-8");

    await expect(new JsonAgentLoopSessionStateStore(corruptPath).load()).resolves.toBeNull();
    await expect(new JsonAgentLoopSessionStateStore(incompatiblePath).load()).resolves.toBeNull();
  });
});
