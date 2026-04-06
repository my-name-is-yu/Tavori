import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { KnowledgeManager } from "../knowledge-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";

// ─── Helpers ───

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `pulseed-auto-consolidate-test-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMockLLM(): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        key: "consolidated_key",
        value: "Consolidated value",
        summary: "A short summary",
        tags: ["tag1"],
      }),
    }),
    countTokens: vi.fn().mockResolvedValue(0),
  } as unknown as ILLMClient;
}

// ─── Setup / Teardown ───

let tempDir: string;
let stateManager: StateManager;
let manager: KnowledgeManager;
let mockLLM: ILLMClient;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  mockLLM = makeMockLLM();
  manager = new KnowledgeManager(stateManager, mockLLM);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ─── Tests ───

describe("autoConsolidate", () => {
  it("returns { consolidated: false } when raw count is below threshold", async () => {
    // Add 5 raw entries — below default threshold of 20
    for (let i = 0; i < 5; i++) {
      await manager.saveAgentMemory({ key: `fact_${i}`, value: `value ${i}`, memory_type: "fact" });
    }

    const result = await manager.autoConsolidate();
    expect(result.consolidated).toBe(false);
    expect(result.compiled).toBeUndefined();
    expect(result.archived).toBeUndefined();
  });

  it("returns { consolidated: false } when raw count is below custom threshold", async () => {
    for (let i = 0; i < 3; i++) {
      await manager.saveAgentMemory({ key: `fact_${i}`, value: `value ${i}`, memory_type: "fact" });
    }

    const result = await manager.autoConsolidate({ rawThreshold: 5 });
    expect(result.consolidated).toBe(false);
  });

  it("calls consolidateAgentMemory and returns results when raw count meets threshold", async () => {
    // Add enough entries in the same group so consolidation produces at least one compiled entry
    for (let i = 0; i < 3; i++) {
      await manager.saveAgentMemory({
        key: `fact_${i}`,
        value: `value ${i}`,
        category: "coding",
        memory_type: "fact",
      });
    }

    const result = await manager.autoConsolidate({ rawThreshold: 3 });
    expect(result.consolidated).toBe(true);
    expect(typeof result.compiled).toBe("number");
    expect(typeof result.archived).toBe("number");
    // LLM should have been called for consolidation
    expect((mockLLM.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("catches errors and returns { consolidated: false } without throwing", async () => {
    // Make stateManager.readRaw throw to force the outer try/catch in autoConsolidate
    vi.spyOn(stateManager, "readRaw").mockRejectedValue(new Error("Storage failure"));

    const result = await manager.autoConsolidate({ rawThreshold: 5 });
    expect(result.consolidated).toBe(false);
  });

  it("uses default threshold of 20 when no opts provided", async () => {
    // 19 raw entries — just below default threshold
    for (let i = 0; i < 19; i++) {
      await manager.saveAgentMemory({ key: `fact_${i}`, value: `value ${i}`, memory_type: "fact" });
    }
    const below = await manager.autoConsolidate();
    expect(below.consolidated).toBe(false);

    // Add one more to reach threshold
    await manager.saveAgentMemory({ key: "fact_19", value: "value 19", category: "c", memory_type: "fact" });
    const above = await manager.autoConsolidate();
    expect(above.consolidated).toBe(true);
  });
});
