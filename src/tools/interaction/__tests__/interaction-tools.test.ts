import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreatePlanTool, CreatePlanInputSchema } from "../create-plan.js";
import { ReadPlanTool, ReadPlanInputSchema } from "../read-plan.js";
import type { ToolCallContext } from "../../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We cannot easily intercept homedir() since it is inlined.
// Use the real ~/.pulseed/decisions dir but with isolated plan_ids per test.

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

describe("CreatePlanTool", () => {
  const tool = new CreatePlanTool();
  const planId = `${TEST_PLAN_PREFIX}create-${Date.now()}`;

  afterEach(cleanupTestPlans);

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("create-plan");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("plan");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toBeTruthy();
  });

  it("checkPermissions returns needs_approval", async () => {
    const result = await tool.checkPermissions(
      { plan_id: planId, title: "T", content: "C" },
      makeContext()
    );
    expect(result.status).toBe("needs_approval");
  });

  it("isConcurrencySafe returns false", () => {
    expect(tool.isConcurrencySafe({ plan_id: "x", title: "T", content: "C" })).toBe(false);
  });

  it("writes plan file with frontmatter", async () => {
    const result = await tool.call(
      { plan_id: planId, title: "My Plan", content: "Step 1\nStep 2" },
      makeContext()
    );
    expect(result.success).toBe(true);
    const data = result.data as { plan_id: string; path: string; created_at: string };
    expect(data.plan_id).toBe(planId);
    expect(data.path).toContain(`${planId}.md`);
    const fileContent = await fs.readFile(data.path, "utf8");
    expect(fileContent).toContain("title: My Plan");
    expect(fileContent).toContain("created_at:");
    expect(fileContent).toContain("Step 1");
  });

  it("creates decisions directory if missing", async () => {
    const decDir = path.join(os.homedir(), ".pulseed", "decisions");
    const result = await tool.call(
      { plan_id: `${TEST_PLAN_PREFIX}dir-${Date.now()}`, title: "T", content: "C" },
      makeContext()
    );
    expect(result.success).toBe(true);
    const stat = await fs.stat(decDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("Zod rejects invalid plan_id with path traversal chars", () => {
    const parsed = CreatePlanInputSchema.safeParse({
      plan_id: "../evil",
      title: "T",
      content: "C",
    });
    expect(parsed.success).toBe(false);
  });

  it("Zod rejects plan_id with slashes", () => {
    const parsed = CreatePlanInputSchema.safeParse({
      plan_id: "foo/bar",
      title: "T",
      content: "C",
    });
    expect(parsed.success).toBe(false);
  });

  it("Zod accepts valid plan_id", () => {
    const parsed = CreatePlanInputSchema.safeParse({
      plan_id: "my-plan-123",
      title: "T",
      content: "C",
    });
    expect(parsed.success).toBe(true);
  });
});

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
