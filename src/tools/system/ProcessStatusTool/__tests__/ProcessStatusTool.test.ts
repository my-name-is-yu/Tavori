import { describe, it, expect, vi, afterEach } from "vitest";
import { ProcessStatusTool, ProcessStatusInputSchema } from "../ProcessStatusTool.js";
import type { ToolCallContext } from "../../../types.js";
import * as execMod from "../../../../base/utils/execFileNoThrow.js";

const makeContext = (cwd = "/tmp"): ToolCallContext => ({
  goalId: "goal-1",
  cwd,
  trustBalance: 0,
  preApproved: false,
  approvalFn: async () => false,
});

describe("ProcessStatusTool", () => {
  const tool = new ProcessStatusTool();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("process-status");
    });

    it("has read_metrics permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("read_metrics");
    });

    it("is read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("inputSchema validation", () => {
    it("accepts port only", () => {
      expect(() => ProcessStatusInputSchema.parse({ port: 3000 })).not.toThrow();
    });

    it("accepts processName only", () => {
      expect(() => ProcessStatusInputSchema.parse({ processName: "node" })).not.toThrow();
    });

    it("accepts pid only", () => {
      expect(() => ProcessStatusInputSchema.parse({ pid: 1234 })).not.toThrow();
    });

    it("rejects empty object (no fields)", () => {
      expect(() => ProcessStatusInputSchema.parse({})).toThrow();
    });

    it("rejects port out of range", () => {
      expect(() => ProcessStatusInputSchema.parse({ port: 0 })).toThrow();
      expect(() => ProcessStatusInputSchema.parse({ port: 65536 })).toThrow();
    });

    it("rejects pid < 1", () => {
      expect(() => ProcessStatusInputSchema.parse({ pid: 0 })).toThrow();
    });
  });

  describe("checkPermissions", () => {
    it("always allows", async () => {
      const result = await tool.checkPermissions({ port: 3000 });
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe({ port: 3000 })).toBe(true);
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("call – pid check", () => {
    it("returns alive=true when kill -0 exits 0", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "", stderr: "", exitCode: 0,
      });
      const result = await tool.call({ pid: 1234 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(1234);
    });

    it("returns alive=false when kill -0 exits non-zero", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "", stderr: "no such process", exitCode: 1,
      });
      const result = await tool.call({ pid: 99999 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });
  });

  describe("call – port check", () => {
    it("returns alive=true when lsof finds output", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "COMMAND  PID  USER\nnode     1234 user  TCP *:3000 (LISTEN)",
        stderr: "",
        exitCode: 0,
      });
      const result = await tool.call({ port: 3000 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(1234);
      expect(result.summary).toContain("3000");
    });

    it("returns alive=false when lsof finds nothing", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "", stderr: "", exitCode: 1,
      });
      const result = await tool.call({ port: 9999 }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });
  });

  describe("call – processName check", () => {
    it("returns alive=true when pgrep finds processes", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "5678 node --inspect",
        stderr: "",
        exitCode: 0,
      });
      const result = await tool.call({ processName: "node" }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean; pid?: number };
      expect(data.alive).toBe(true);
      expect(data.pid).toBe(5678);
    });

    it("returns alive=false when pgrep finds nothing", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
        stdout: "", stderr: "", exitCode: 1,
      });
      const result = await tool.call({ processName: "nonexistent_proc" }, makeContext());
      expect(result.success).toBe(true);
      const data = result.data as { alive: boolean };
      expect(data.alive).toBe(false);
    });
  });

  describe("call – error handling", () => {
    it("returns success=false on unexpected error", async () => {
      vi.spyOn(execMod, "execFileNoThrow").mockRejectedValueOnce(new Error("spawn error"));
      const result = await tool.call({ pid: 1 }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("spawn error");
    });
  });
});
