import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenClawDataSourceAdapter } from "../../src/adapters/openclaw-datasource.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import type { DataSourceConfig } from "../../src/types/data-source.js";

// ─── Helpers ───

function makeConfig(id = "openclaw", extras: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id,
    name: `OpenClawDataSource(${id})`,
    type: "custom",
    connection: {},
    enabled: true,
    created_at: new Date().toISOString(),
    ...extras,
  };
}

function writeJsonl(filePath: string, events: object[]): void {
  fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// ─── Tests ───

describe("OpenClawDataSourceAdapter", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  // ─── connect / disconnect / healthCheck ───

  describe("connect / disconnect / healthCheck", () => {
    it("connect() resolves without throwing", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      await expect(adapter.connect()).resolves.toBeUndefined();
    });

    it("disconnect() resolves without throwing", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });

    it("healthCheck() returns true when sessionDir exists", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      await expect(adapter.healthCheck()).resolves.toBe(true);
    });

    it("healthCheck() returns false when sessionDir does not exist", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), {
        sessionDir: path.join(sessionDir, "nonexistent"),
      });
      await expect(adapter.healthCheck()).resolves.toBe(false);
    });
  });

  // ─── session_count ───

  describe("session_count", () => {
    it("returns 0 for empty directory", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "session_count", timeout_ms: 5000 });
      expect(result.value).toBe(0);
    });

    it("returns 0 when session directory does not exist", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), {
        sessionDir: path.join(sessionDir, "missing"),
      });
      const result = await adapter.query({ dimension_name: "session_count", timeout_ms: 5000 });
      expect(result.value).toBe(0);
    });

    it("counts JSONL files in sessionDir", async () => {
      writeJsonl(path.join(sessionDir, "session-1.jsonl"), [{ type: "message", role: "user" }]);
      writeJsonl(path.join(sessionDir, "session-2.jsonl"), [{ type: "message", role: "user" }]);
      fs.writeFileSync(path.join(sessionDir, "readme.txt"), "ignored"); // non-jsonl

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "session_count", timeout_ms: 5000 });
      expect(result.value).toBe(2);
    });
  });

  // ─── total_messages ───

  describe("total_messages", () => {
    it("returns 0 for empty directory", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "total_messages", timeout_ms: 5000 });
      expect(result.value).toBe(0);
    });

    it("counts message events across multiple sessions", async () => {
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "hi" },
      ]);
      writeJsonl(path.join(sessionDir, "s2.jsonl"), [
        { type: "message", role: "user", content: "test" },
        { type: "tool_call", name: "exec" }, // not a message
      ]);

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "total_messages", timeout_ms: 5000 });
      expect(result.value).toBe(3);
    });
  });

  // ─── tool_call_count ───

  describe("tool_call_count", () => {
    it("returns 0 for empty directory", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "tool_call_count", timeout_ms: 5000 });
      expect(result.value).toBe(0);
    });

    it("counts tool_call events across sessions", async () => {
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "tool_call", name: "exec" },
        { type: "tool_call", name: "read_file" },
        { type: "message", role: "user" },
      ]);
      writeJsonl(path.join(sessionDir, "s2.jsonl"), [
        { type: "tool_call", name: "write_file" },
      ]);

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "tool_call_count", timeout_ms: 5000 });
      expect(result.value).toBe(3);
    });
  });

  // ─── error_count ───

  describe("error_count", () => {
    it("returns 0 when no error events exist", async () => {
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "message", role: "user" },
        { type: "tool_call", name: "exec" },
      ]);

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "error_count", timeout_ms: 5000 });
      expect(result.value).toBe(0);
    });

    it("counts error events across sessions", async () => {
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "error", message: "Command failed" },
        { type: "message", role: "assistant" },
      ]);
      writeJsonl(path.join(sessionDir, "s2.jsonl"), [
        { type: "error", message: "Timeout" },
        { type: "error", message: "Parse error" },
      ]);

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "error_count", timeout_ms: 5000 });
      expect(result.value).toBe(3);
    });
  });

  // ─── last_session_status ───

  describe("last_session_status", () => {
    it("returns null for empty directory", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({
        dimension_name: "last_session_status",
        timeout_ms: 5000,
      });
      expect(result.value).toBeNull();
    });

    it("returns status field of last event in most recent file", async () => {
      // Sorted alphabetically: s1 < s2 — s2 is most recent
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "message", status: "running" },
      ]);
      writeJsonl(path.join(sessionDir, "s2.jsonl"), [
        { type: "message", status: "running" },
        { type: "message", status: "completed" },
      ]);

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({
        dimension_name: "last_session_status",
        timeout_ms: 5000,
      });
      expect(result.value).toBe("completed");
    });

    it("falls back to type when status field is absent", async () => {
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "tool_call", name: "exec" },
      ]);

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({
        dimension_name: "last_session_status",
        timeout_ms: 5000,
      });
      expect(result.value).toBe("tool_call");
    });
  });

  // ─── Malformed JSONL ───

  describe("malformed JSONL lines are skipped", () => {
    it("counts valid events, ignores broken lines", async () => {
      const content = [
        JSON.stringify({ type: "message", role: "user" }),
        "NOT VALID JSON {{{",
        JSON.stringify({ type: "tool_call", name: "exec" }),
        "",
        JSON.stringify({ type: "error", message: "oops" }),
        "also bad",
      ].join("\n");
      fs.writeFileSync(path.join(sessionDir, "mixed.jsonl"), content, "utf-8");

      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });

      const msgResult = await adapter.query({ dimension_name: "total_messages", timeout_ms: 5000 });
      expect(msgResult.value).toBe(1);

      const toolResult = await adapter.query({
        dimension_name: "tool_call_count",
        timeout_ms: 5000,
      });
      expect(toolResult.value).toBe(1);

      const errResult = await adapter.query({ dimension_name: "error_count", timeout_ms: 5000 });
      expect(errResult.value).toBe(1);
    });
  });

  // ─── dimension_mapping ───

  describe("dimension_mapping", () => {
    it("maps custom dimension name to internal dimension", async () => {
      writeJsonl(path.join(sessionDir, "s1.jsonl"), [
        { type: "tool_call", name: "a" },
        { type: "tool_call", name: "b" },
      ]);

      const config = makeConfig("openclaw-mapped", {
        dimension_mapping: { calls: "tool_call_count" },
      });
      const adapter = new OpenClawDataSourceAdapter(config, { sessionDir });

      const result = await adapter.query({ dimension_name: "calls", timeout_ms: 5000 });
      expect(result.value).toBe(2);
    });

    it("returns null for unmapped unknown dimension", async () => {
      const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
      const result = await adapter.query({ dimension_name: "unknown_dim", timeout_ms: 5000 });
      expect(result.value).toBeNull();
    });
  });

  // ─── getSupportedDimensions ───

  it("getSupportedDimensions() returns all 5 known dimensions", () => {
    const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
    const dims = adapter.getSupportedDimensions();
    expect(dims).toContain("session_count");
    expect(dims).toContain("last_session_status");
    expect(dims).toContain("total_messages");
    expect(dims).toContain("tool_call_count");
    expect(dims).toContain("error_count");
    expect(dims).toHaveLength(5);
  });

  // ─── sourceId / sourceType ───

  it("sourceId matches config.id", () => {
    const adapter = new OpenClawDataSourceAdapter(makeConfig("my-openclaw"), { sessionDir });
    expect(adapter.sourceId).toBe("my-openclaw");
  });

  it('sourceType is "custom"', () => {
    const adapter = new OpenClawDataSourceAdapter(makeConfig(), { sessionDir });
    expect(adapter.sourceType).toBe("custom");
  });

  // ─── DataSourceResult shape ───

  it("query result contains source_id and timestamp", async () => {
    const adapter = new OpenClawDataSourceAdapter(makeConfig("oc-shape"), { sessionDir });
    const result = await adapter.query({ dimension_name: "session_count", timeout_ms: 5000 });
    expect(result.source_id).toBe("oc-shape");
    expect(typeof result.timestamp).toBe("string");
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
