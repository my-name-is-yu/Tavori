import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";
import { defaultHttpFetchTransport, HttpFetchTool } from "../HttpFetchTool.js";
import type { ToolCallContext } from "../../../types.js";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-1",
  dryRun: false,
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
    beforeEach(() => {
      lookupMock.mockReset();
    });

    it("allows public URL", async () => {
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const result = await tool.checkPermissions({ url: "https://example.com", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("allowed");
    });

    it("needs_approval for localhost", async () => {
      lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const result = await tool.checkPermissions({ url: "http://localhost:3000/api", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
      if (result.status === "needs_approval") {
        expect(result.reason).toContain("internal or private address");
      }
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

    it("needs_approval for 172.16.x.x", async () => {
      const result = await tool.checkPermissions({ url: "http://172.16.0.1", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for link-local IPv4", async () => {
      const result = await tool.checkPermissions({ url: "http://169.254.169.254/latest/meta-data", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for encoded loopback IPv4 variants", async () => {
      await expect(tool.checkPermissions({ url: "http://2130706433", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
      await expect(tool.checkPermissions({ url: "http://0x7f000001", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
      await expect(tool.checkPermissions({ url: "http://0177.0.0.1", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
    });

    it("needs_approval for documentation and reserved IPv4 ranges", async () => {
      await expect(tool.checkPermissions({ url: "http://203.0.113.10", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
      await expect(tool.checkPermissions({ url: "http://198.51.100.10", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
      await expect(tool.checkPermissions({ url: "http://192.0.2.10", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
    });

    it("needs_approval for IPv6 loopback", async () => {
      const result = await tool.checkPermissions({ url: "http://[::1]:8080", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for IPv6 private and documentation ranges", async () => {
      await expect(tool.checkPermissions({ url: "http://[fc00::1]", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
      await expect(tool.checkPermissions({ url: "http://[fe80::1]", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
      await expect(tool.checkPermissions({ url: "http://[2001:db8::1]", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 })).resolves.toMatchObject({ status: "needs_approval" });
    });

    it("needs_approval when DNS resolves to IPv4-mapped IPv6 private address", async () => {
      lookupMock.mockResolvedValue([{ address: "::ffff:7f00:1", family: 6 }]);
      const result = await tool.checkPermissions({ url: "https://mapped.example.test", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval for literal IPv4-mapped IPv6 private address", async () => {
      const result = await tool.checkPermissions({ url: "http://[::ffff:7f00:1]", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval when DNS resolves to NAT64 private address", async () => {
      lookupMock.mockResolvedValue([{ address: "64:ff9b::a9fe:a9fe", family: 6 }]);
      const result = await tool.checkPermissions({ url: "https://nat64.example.test", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval when DNS resolves to private address", async () => {
      lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
      const result = await tool.checkPermissions({ url: "https://internal.example.test", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
      expect(result.status).toBe("needs_approval");
    });

    it("needs_approval when DNS lookup fails", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
      const result = await tool.checkPermissions({ url: "https://unresolvable.example.test", method: "GET", timeoutMs: 30_000, maxResponseBytes: 1_048_576 });
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
      lookupMock.mockReset();
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    });

    it("returns success on 200 response", async () => {
      const mockTransport = vi.fn().mockResolvedValue({
        ok: true,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: '{"result": "ok"}',
      });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { statusCode: number }).statusCode).toBe(200);
      expect((result.data as { ok: boolean }).ok).toBe(true);
      expect(result.summary).toContain("200");
      expect(mockTransport).toHaveBeenCalledTimes(1);
    });

    it("returns failure on 404 response", async () => {
      const mockTransport = vi.fn().mockResolvedValue({
        ok: false,
        statusCode: 404,
        headers: {},
        body: "Not Found",
      });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/missing", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(false);
      expect((result.data as { statusCode: number }).statusCode).toBe(404);
      expect(result.error).toContain("404");
    });

    it("returns failure on network error", async () => {
      const mockTransport = vi.fn().mockRejectedValue(new Error("Network failure"));
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("Network failure");
      expect((result.data as { statusCode: number }).statusCode).toBe(0);
    });

    it("returns empty body for HEAD request", async () => {
      const mockTransport = vi.fn().mockResolvedValue({
        ok: true,
        statusCode: 200,
        headers: {},
        body: "",
      });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/data", method: "HEAD", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { body: string }).body).toBe("");
      expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({ method: "HEAD" }));
    });

    it("truncates large responses", async () => {
      const mockTransport = vi.fn().mockResolvedValue({
        ok: true,
        statusCode: 200,
        headers: {},
        body: `${"x".repeat(100)}\n[truncated]`,
      });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 100 }, makeContext());
      expect(result.success).toBe(true);
      expect((result.data as { body: string }).body).toContain("[truncated]");
      expect(mockTransport).toHaveBeenCalledWith(expect.objectContaining({ maxResponseBytes: 100 }));
    });

    it("tracks durationMs", async () => {
      const mockTransport = vi.fn().mockResolvedValue({
        ok: true,
        statusCode: 200,
        headers: {},
        body: "ok",
      });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("follows redirects only after validating the next destination", async () => {
      lookupMock
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
        .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }]);
      const mockTransport = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          statusCode: 302,
          headers: { location: "https://cdn.example.com/data" },
          body: "",
        })
        .mockResolvedValueOnce({
          ok: true,
          statusCode: 200,
          headers: {},
          body: "ok",
        });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());

      expect(result.success).toBe(true);
      expect(mockTransport).toHaveBeenCalledTimes(2);
      expect(mockTransport).toHaveBeenNthCalledWith(2, expect.objectContaining({ url: new URL("https://cdn.example.com/data") }));
    });

    it("blocks redirects to internal addresses", async () => {
      const mockTransport = vi.fn().mockResolvedValueOnce({
        ok: false,
        statusCode: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        body: "",
      });
      const fetchTool = new HttpFetchTool(mockTransport);

      const result = await fetchTool.call({ url: "https://api.example.com/data", method: "GET", timeoutMs: 5_000, maxResponseBytes: 1_048_576 }, makeContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain("internal or private address");
      expect(mockTransport).toHaveBeenCalledTimes(1);
    });

    it("pins the default transport request to the validated address", async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`host=${req.headers.host ?? ""}`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("test server did not bind to a TCP port");
        }

        const result = await defaultHttpFetchTransport({
          url: new URL(`http://example.test:${address.port}/data`),
          method: "GET",
          timeoutMs: 5_000,
          maxResponseBytes: 1_048_576,
          destination: { address: "127.0.0.1", family: 4 },
        });

        expect(result.statusCode).toBe(200);
        expect(result.body).toContain(`host=example.test:${address.port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        });
      }
    });
  });

  describe("description", () => {
    it("returns a non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });
});
