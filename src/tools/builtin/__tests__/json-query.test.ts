import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { JsonQueryTool } from "../json-query.js";
import type { ToolCallContext } from "../../types.js";

const makeContext = (cwd: string): ToolCallContext => ({
  goalId: "goal-1",
  sessionId: "session-1",
  cwd,
  dryRun: false,
  permissionLevel: "read_only",
});

describe("JsonQueryTool", () => {
  const tool = new JsonQueryTool();
  let tmpDir: string;
  let jsonFilePath: string;

  const sampleData = {
    name: "seedpulse",
    version: "0.1.0",
    scripts: { build: "tsc", test: "vitest" },
    dependencies: { zod: "^3.0.0", typescript: "^5.3.0" },
    tags: ["alpha", "beta", "gamma"],
    nested: { deep: { value: 42 } },
  };

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "json-query-test-"));
    jsonFilePath = path.join(tmpDir, "package.json");
    await fs.writeFile(jsonFilePath, JSON.stringify(sampleData, null, 2));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("json_query");
    });

    it("has read_only permission level", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ file_path: "any.json", query: "name" });
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("call — successful queries", () => {
    it("queries top-level string key", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "name" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("seedpulse");
    });

    it("queries top-level version", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "version" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("0.1.0");
    });

    it("queries nested key", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "scripts.build" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("tsc");
    });

    it("queries deeply nested key", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "nested.deep.value" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });

    it("queries dependency version", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "dependencies.zod" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("^3.0.0");
    });

    it("queries array element by index", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "tags[0]" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("alpha");
    });

    it("queries second array element", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "tags[1]" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("beta");
    });

    it("returns undefined for missing key", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "nonexistent" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it("returns undefined for missing nested key", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "scripts.missing" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it("resolves relative path from context.cwd", async () => {
      const result = await tool.call({ file_path: "package.json", query: "name" }, makeContext(tmpDir));
      expect(result.success).toBe(true);
      expect(result.data).toBe("seedpulse");
    });

    it("includes query in summary", async () => {
      const result = await tool.call({ file_path: jsonFilePath, query: "name" }, makeContext(tmpDir));
      expect(result.summary).toContain("name");
      expect(result.summary).toContain("seedpulse");
    });
  });

  describe("call — error cases", () => {
    it("returns error for missing file", async () => {
      const result = await tool.call({ file_path: "/nonexistent/path/file.json", query: "name" }, makeContext(tmpDir));
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns error for invalid JSON", async () => {
      const invalidJsonPath = path.join(tmpDir, "invalid.json");
      await fs.writeFile(invalidJsonPath, "{ not valid json ");
      const result = await tool.call({ file_path: invalidJsonPath, query: "name" }, makeContext(tmpDir));
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("description", () => {
    it("returns a non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });
});
