import { describe, it, expect, vi, afterEach } from "vitest";
import { TestRunnerTool, TestRunnerInputSchema } from "../test-runner.js";
import type { ToolCallContext } from "../../types.js";
import * as execMod from "../../../base/utils/execFileNoThrow.js";

const makeContext = (cwd = "/tmp"): ToolCallContext => ({
  goalId: "goal-1",
  cwd,
  trustBalance: 0,
  preApproved: false,
  approvalFn: async () => false,
});

// Minimal vitest-like output
const VITEST_PASS = `
 RUN  v1.0.0

 ✓ src/foo.test.ts (3)

 Tests  3 passed (3)
 Duration  0.45s
`.trim();

const VITEST_FAIL = `
 RUN  v1.0.0

 ✗ src/bar.test.ts (2)
   × should work
   × another test

 Tests  1 passed | 2 failed (3)
 Duration  0.60s
`.trim();

const JEST_PASS = `
Tests: 5 passed, 5 total
Time: 1.23s
`.trim();

const MOCHA_PASS = `
  5 passing (200ms)
`.trim();

const MOCHA_FAIL = `
  3 passing (150ms)
  2 failing
`.trim();

describe("TestRunnerTool", () => {
  const tool = new TestRunnerTool();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("test-runner");
    });

    it("has execute permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("execute");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });

    it("maxConcurrency is 1", () => {
      expect(tool.metadata.maxConcurrency).toBe(1);
    });
  });

  describe("inputSchema", () => {
    it("defaults command to npx vitest run", () => {
      const parsed = TestRunnerInputSchema.parse({});
      expect(parsed.command).toBe("npx vitest run");
    });

    it("defaults timeout to 60000", () => {
      const parsed = TestRunnerInputSchema.parse({});
      expect(parsed.timeout).toBe(60_000);
    });

    it("accepts custom command", () => {
      const parsed = TestRunnerInputSchema.parse({ command: "npx jest --ci" });
      expect(parsed.command).toBe("npx jest --ci");
    });

    it("accepts pattern", () => {
      const parsed = TestRunnerInputSchema.parse({ pattern: "foo.test.ts" });
      expect(parsed.pattern).toBe("foo.test.ts");
    });
  });

  describe("checkPermissions", () => {
    it("allows npx vitest run", async () => {
      const result = await tool.checkPermissions({ command: "npx vitest run", timeout: 60000 });
      expect(result.status).toBe("allowed");
    });

    it("allows npx jest", async () => {
      const result = await tool.checkPermissions({ command: "npx jest --ci", timeout: 60000 });
      expect(result.status).toBe("allowed");
    });

    it("allows npm test", async () => {
      const result = await tool.checkPermissions({ command: "npm test", timeout: 60000 });
      expect(result.status).toBe("allowed");
    });

    it("allows mocha", async () => {
      const result = await tool.checkPermissions({ command: "mocha --recursive", timeout: 60000 });
      expect(result.status).toBe("allowed");
    });

    it("needs_approval for unknown command", async () => {
      const result = await tool.checkPermissions({ command: "bash run-tests.sh", timeout: 60000 });
      expect(result.status).toBe("needs_approval");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns false (test runs are not concurrent-safe)", () => {
      expect(tool.isConcurrencySafe({ command: "npx vitest run", timeout: 60000 })).toBe(false);
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("call – vitest output parsing", () => {
    it("parses passing vitest output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: VITEST_PASS, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { passed: number; failed: number; total: number; success: boolean };
      expect(data.passed).toBe(3);
      expect(data.failed).toBe(0);
      expect(data.total).toBe(3);
      expect(data.success).toBe(true);
    });

    it("parses failing vitest output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: VITEST_FAIL, stderr: "", exitCode: 1,
      });
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      expect(result.success).toBe(false);
      const data = result.data as { passed: number; failed: number; failedTests?: string[] };
      expect(data.passed).toBe(1);
      expect(data.failed).toBe(2);
      expect(data.failedTests).toHaveLength(2);
      expect(data.failedTests![0]).toContain("should work");
    });

    it("includes duration", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: VITEST_PASS, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      const data = result.data as { duration?: number };
      expect(data.duration).toBe(450);
    });
  });

  describe("call – jest output parsing", () => {
    it("parses passing jest output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: JEST_PASS, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "npx jest", timeout: 60000 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { passed: number; total: number };
      expect(data.passed).toBe(5);
      expect(data.total).toBe(5);
    });
  });

  describe("call – mocha output parsing", () => {
    it("parses passing mocha output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: MOCHA_PASS, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "mocha", timeout: 60000 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { passed: number; failed: number };
      expect(data.passed).toBe(5);
      expect(data.failed).toBe(0);
    });

    it("parses failing mocha output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: MOCHA_FAIL, stderr: "", exitCode: 1,
      });
      const result = await tool.call({ command: "mocha", timeout: 60000 }, makeContext());
      expect(result.success).toBe(false);
      const data = result.data as { passed: number; failed: number };
      expect(data.passed).toBe(3);
      expect(data.failed).toBe(2);
    });
  });

  describe("call – rawOutput truncation", () => {
    it("truncates rawOutput over 10000 chars", async () => {
      const longOutput = "x".repeat(15000);
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: longOutput, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      const data = result.data as { rawOutput: string };
      expect(data.rawOutput.length).toBeLessThanOrEqual(10100); // 10000 + truncation marker
      expect(data.rawOutput).toContain("[truncated]");
    });

    it("does not truncate output under 10000 chars", async () => {
      const shortOutput = VITEST_PASS;
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: shortOutput, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      const data = result.data as { rawOutput: string };
      expect(data.rawOutput).not.toContain("[truncated]");
    });
  });

  describe("call – pattern appended to command", () => {
    it("passes pattern as extra argument", async () => {
      const spy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: VITEST_PASS, stderr: "", exitCode: 0,
      });
      await tool.call({ command: "npx vitest run", pattern: "foo.test.ts", timeout: 60000 }, makeContext());
      expect(spy).toHaveBeenCalledWith(
        "npx",
        expect.arrayContaining(["foo.test.ts"]),
        expect.anything()
      );
    });
  });

  describe("call – uses cwd from input over context", () => {
    it("prefers input.cwd", async () => {
      const spy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: VITEST_PASS, stderr: "", exitCode: 0,
      });
      await tool.call({ command: "npx vitest run", cwd: "/custom/path", timeout: 60000 }, makeContext("/other"));
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cwd: "/custom/path" })
      );
    });
  });

  describe("call – contextModifier", () => {
    it("includes test summary in contextModifier", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: VITEST_PASS, stderr: "", exitCode: 0,
      });
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      expect(result.contextModifier).toContain("3 passed");
    });
  });

  describe("call – error handling", () => {
    it("returns success=false on unexpected error", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockRejectedValueOnce(new Error("spawn failed"));
      const result = await tool.call({ command: "npx vitest run", timeout: 60000 }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("spawn failed");
    });
  });
});
