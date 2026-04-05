import { describe, it, expect } from "vitest";
import { EnvTool } from "../EnvTool.js";
import type { ToolCallContext } from "../../../types.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp/test",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

describe("EnvTool", () => {
  let tool: EnvTool;

  beforeEach(() => {
    tool = new EnvTool();
  });

  it("metadata is correct", () => {
    expect(tool.metadata.name).toBe("env_info");
    expect(tool.metadata.permissionLevel).toBe("read_only");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.maxConcurrency).toBe(10);
    expect(tool.metadata.tags).toEqual(expect.arrayContaining(["environment", "system", "config"]));
  });

  it("returns platform info", async () => {
    const result = await tool.call({ query: "platform" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { query: string; result: { platform: string; arch: string; nodeVersion: string } };
    expect(data.result.platform).toBe(process.platform);
    expect(data.result.arch).toBe(process.arch);
    expect(data.result.nodeVersion).toBe(process.version);
  });

  it("returns node version", async () => {
    const result = await tool.call({ query: "node_version" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { query: string; result: string };
    expect(data.result).toBe(process.version);
  });

  it("returns cwd from context", async () => {
    const result = await tool.call({ query: "cwd" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { query: string; result: string };
    expect(data.result).toBe("/tmp/test");
  });

  it("returns memory usage in MB", async () => {
    const result = await tool.call({ query: "memory" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { query: string; result: { rss: number; heapUsed: number; unit: string } };
    expect(data.result.unit).toBe("MB");
    expect(typeof data.result.rss).toBe("number");
    expect(data.result.rss).toBeGreaterThan(0);
  });

  it("returns uptime", async () => {
    const result = await tool.call({ query: "uptime" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { query: string; result: { seconds: number; formatted: string } };
    expect(typeof data.result.seconds).toBe("number");
    expect(data.result.seconds).toBeGreaterThan(0);
    expect(data.result.formatted).toMatch(/\d+h \d+m \d+s/);
  });

  it("returns env var value", async () => {
    process.env["TEST_SAFE_VAR"] = "hello";
    const result = await tool.call({ query: "env_var", varName: "TEST_SAFE_VAR" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { query: string; result: string };
    expect(data.result).toBe("hello");
    delete process.env["TEST_SAFE_VAR"];
  });

  it("blocks sensitive env var names - KEY", async () => {
    const result = await tool.call({ query: "env_var", varName: "API_KEY" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("sensitive");
  });

  it("blocks sensitive env var names - SECRET", async () => {
    const result = await tool.call({ query: "env_var", varName: "MY_SECRET" }, makeContext());
    expect(result.success).toBe(false);
  });

  it("blocks sensitive env var names - TOKEN", async () => {
    const result = await tool.call({ query: "env_var", varName: "AUTH_TOKEN" }, makeContext());
    expect(result.success).toBe(false);
  });

  it("blocks sensitive env var names - PASSWORD", async () => {
    const result = await tool.call({ query: "env_var", varName: "DB_PASSWORD" }, makeContext());
    expect(result.success).toBe(false);
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ query: "platform" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ query: "platform" })).toBe(true);
  });
});
