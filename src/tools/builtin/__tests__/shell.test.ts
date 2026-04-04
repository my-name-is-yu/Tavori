import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShellTool } from "../shell.js";
import type { ToolCallContext } from "../../types.js";

const makeContext = (cwd = "/tmp"): ToolCallContext => ({
  goalId: "goal-1",
  sessionId: "session-1",
  cwd,
  dryRun: false,
  permissionLevel: "read_metrics",
});

describe("ShellTool", () => {
  const tool = new ShellTool();

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("shell");
    });

    it("has read_metrics permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("read_metrics");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("allows safe command: ls", async () => {
      const result = await tool.checkPermissions({ command: "ls -la", timeoutMs: 120_000 });
      expect(result.status).toBe("allowed");
    });

    it("allows safe command: echo", async () => {
      const result = await tool.checkPermissions({ command: "echo hello", timeoutMs: 120_000 });
      expect(result.status).toBe("allowed");
    });

    it("allows git status", async () => {
      const result = await tool.checkPermissions({ command: "git status", timeoutMs: 120_000 });
      expect(result.status).toBe("allowed");
    });

    it("denies rm command", async () => {
      const result = await tool.checkPermissions({ command: "rm foo.txt", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
      expect(result.reason).toContain("Denied");
    });

    it("denies git push", async () => {
      const result = await tool.checkPermissions({ command: "git push origin main", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
    });

    it("denies compound command with rm", async () => {
      const result = await tool.checkPermissions({ command: "ls && rm foo", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
    });

    it("denies compound command with mkdir", async () => {
      const result = await tool.checkPermissions({ command: "ls ; mkdir newdir", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
    });

    it("needs_approval for unknown command", async () => {
      const result = await tool.checkPermissions({ command: "ps aux", timeoutMs: 120_000 });
      expect(result.status).toBe("needs_approval");
    });

    it("denies redirect operator", async () => {
      const result = await tool.checkPermissions({ command: "echo hello > file.txt", timeoutMs: 120_000 });
      expect(result.status).toBe("denied");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true for ls", () => {
      expect(tool.isConcurrencySafe({ command: "ls", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns true for cat", () => {
      expect(tool.isConcurrencySafe({ command: "cat file.txt", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns true for git status", () => {
      expect(tool.isConcurrencySafe({ command: "git status", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns true for rg pattern", () => {
      expect(tool.isConcurrencySafe({ command: "rg TODO src/", timeoutMs: 120_000 })).toBe(true);
    });

    it("returns false for unknown command", () => {
      expect(tool.isConcurrencySafe({ command: "ps aux", timeoutMs: 120_000 })).toBe(false);
    });

    it("returns false for npm ls (not in readOnly patterns)", () => {
      expect(tool.isConcurrencySafe({ command: "npm ls", timeoutMs: 120_000 })).toBe(false);
    });
  });

  describe("call", () => {
    it("executes echo command successfully", async () => {
      const result = await tool.call({ command: "echo hello", timeoutMs: 5_000 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { stdout: string }).stdout.trim()).toBe("hello");
      expect((result.data as { exitCode: number }).exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns exitCode 0 for pwd", async () => {
      const result = await tool.call({ command: "pwd", timeoutMs: 5_000 }, makeContext("/tmp"));
      expect(result.success).toBe(true);
      expect((result.data as { exitCode: number }).exitCode).toBe(0);
    });

    it("captures stderr and non-zero exit code", async () => {
      const result = await tool.call({ command: "ls /nonexistent_dir_xyz_abc", timeoutMs: 5_000 }, makeContext());
      expect(result.success).toBe(false);
      expect((result.data as { exitCode: number }).exitCode).not.toBe(0);
    });

    it("includes contextModifier on success", async () => {
      const result = await tool.call({ command: "echo test_output", timeoutMs: 5_000 }, makeContext());
      expect(result.contextModifier).toBeDefined();
      expect(result.contextModifier).toContain("Shell output:");
    });

    it("uses cwd from input when provided", async () => {
      const result = await tool.call({ command: "pwd", cwd: "/tmp", timeoutMs: 5_000 }, makeContext("/usr"));
      expect(result.success).toBe(true);
      expect((result.data as { stdout: string }).stdout.trim()).toMatch(/^(\/private)?\/tmp$/);
    });
  });

  describe("description", () => {
    it("returns a non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });
});
