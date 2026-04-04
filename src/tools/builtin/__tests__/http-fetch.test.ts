import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpFetchTool } from "../http-fetch.js";
import type { ToolCallContext } from "../../types.js";

const makeContext = (): ToolCallContext => ({
  goalId: "goal-1",
  sessionId: "session-1",
  cwd: "/tmp",
  dryRun: false,
  permissionLevel: "read_only",
});

describe("HttpFetchTool", () => {
  const tool = new HttpFetchTool();

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("http_fetch");
    });

    it("has read_only permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
    });

    it("is read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
    });
  });

  describe("checkPermissions", () => {
    it("allows public URL", async () => {
      const result = await tool.checkPermissions({ url: "https://example.com", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("allowed");
    });

    it("needs_approval for localhost", async () => {
      const result = await tool.checkPermissions({ url: "http://localhost:3000/api", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
      expect(result.reason).toContain("internal address");
    });

    it("needs_approval for 127.0.0.1", async () => {
      const result = await tool.checkPermissions({ url: "http://127.0.0.1:8080", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for 192.168.x.x", async () => {
      const result = await tool.checkPermissions({ url: "http://192.168.1.100", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for 10.x.x.x", async () => {
      const result = await tool.checkPermissions({ url: "http://10.0.0.1", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });
  });

  describe("isConcurrencySafe", () => {
    it("always returns true", () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("call", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns success on 200 response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { entries: () => [["content-type", "application/json"]] },
        text: async () => '{"result": "ok"}',
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await tool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { statusCode: number }).statusCode).toBe(200);
      expect((result.data as { ok: boolean }).ok).toBe(true);
      expect(result.summary).toContain("200");
    });

    it("returns failure on 404 response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { entries: () => [] },
        text: async () => "Not Found",
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await tool.call({ url: "https://api.example.com/missing", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(false);
      expect((result.data as { statusCode: number }).statusCode).toBe(404);
      expect(result.error).toContain("404");
    });

    it("returns failure on network error", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network failure"));
      vi.stubGlobal("fetch", mockFetch);

      const result = await tool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("Network failure");
      expect((result.data as { statusCode: number }).statusCode).toBe(0);
    });

    it("returns empty body for HEAD request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { entries: () => [] },
        text: async () => "should not be called",
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await tool.call({ url: "https://api.example.com/data", method: "HEAD", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { body: string }).body).toBe("");
    });

    it("truncates large responses", async () => {
      const largeBody = "x".repeat(2000);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { entries: () => [] },
        text: async () => largeBody,
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await tool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 100 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { body: string }).body).toContain("[truncated]");
      expect((result.data as { body: string }).body.length).toBeLessThan(largeBody.length);
    });

    it("tracks durationMs", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { entries: () => [] },
        text: async () => "ok",
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await tool.call({ url: "https://api.example.com", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("description", () => {
    it("returns a non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });
});
