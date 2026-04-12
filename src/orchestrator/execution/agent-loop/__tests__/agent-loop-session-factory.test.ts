import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { createPersistentAgentLoopSessionFactory } from "../agent-loop-session-factory.js";

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
