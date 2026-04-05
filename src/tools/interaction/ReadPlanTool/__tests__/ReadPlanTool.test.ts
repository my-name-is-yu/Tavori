import { describe, it, expect, afterEach } from "vitest";
import { ReadPlanTool, ReadPlanInputSchema } from "../ReadPlanTool.js";
import type { ToolCallContext } from "../../../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

const TEST_PLAN_PREFIX = "vitest-test-";

async function cleanupTestPlans() {
  const decDir = path.join(os.homedir(), ".pulseed", "decisions");
  try {
    const files = await fs.readdir(decDir);
    for (const f of files) {
      if (f.startsWith(TEST_PLAN_PREFIX)) {
        await fs.rm(path.join(decDir, f), { force: true });
      }
    }
  } catch {
    // directory may not exist, ignore
  }
}

describe("ReadPlanTool", () => {
  const tool = new ReadPlanTool();
  const planId = `${TEST_PLAN_PREFIX}read-${Date.now()}`;

  afterEach(cleanupTestPlans);

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("read-plan");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("plan");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ plan_id: "x" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ plan_id: "x" })).toBe(true);
  });

  it("reads existing plan file", async () => {
    const decDir = path.join(os.homedir(), ".pulseed", "decisions");
    await fs.mkdir(decDir, { recursive: true });
    await fs.writeFile(
      path.join(decDir, `${planId}.md`),
      "---\ntitle: T\n---\n\nHello",
      "utf8"
    );

    const result = await tool.call({ plan_id: planId }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { plan_id: string; content: string };
    expect(data.plan_id).toBe(planId);
    expect(data.content).toContain("Hello");
  });

  it("returns failure when plan not found", async () => {
    const result = await tool.call({ plan_id: `${TEST_PLAN_PREFIX}missing-xyz` }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("Zod rejects invalid plan_id", () => {
    const parsed = ReadPlanInputSchema.safeParse({ plan_id: "foo/bar" });
    expect(parsed.success).toBe(false);
  });

  it("Zod accepts valid plan_id", () => {
    const parsed = ReadPlanInputSchema.safeParse({ plan_id: "my-plan-123" });
    expect(parsed.success).toBe(true);
  });
});
