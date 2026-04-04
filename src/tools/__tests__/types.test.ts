import { describe, it, expect } from "vitest";
import {
  ToolResultSchema,
  ToolPermissionLevelSchema,
  ToolMetadataSchema,
  PermissionCheckResultSchema,
} from "../types.js";

describe("ToolResultSchema", () => {
  const validResult = {
    success: true,
    data: { count: 42 },
    summary: "Found 42 files",
    durationMs: 150,
  };

  it("parses a valid minimal result", () => {
    const result = ToolResultSchema.parse(validResult);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("Found 42 files");
    expect(result.durationMs).toBe(150);
    expect(result.error).toBeUndefined();
    expect(result.contextModifier).toBeUndefined();
    expect(result.artifacts).toBeUndefined();
  });

  it("parses a full result with optional fields", () => {
    const full = {
      ...validResult,
      error: "partial failure",
      contextModifier: "Focus on TypeScript files",
      artifacts: ["/tmp/foo.ts", "/tmp/bar.ts"],
    };
    const result = ToolResultSchema.parse(full);
    expect(result.error).toBe("partial failure");
    expect(result.contextModifier).toBe("Focus on TypeScript files");
    expect(result.artifacts).toEqual(["/tmp/foo.ts", "/tmp/bar.ts"]);
  });

  it("rejects when success is missing", () => {
    const { success: _s, ...rest } = validResult;
    expect(() => ToolResultSchema.parse(rest)).toThrow();
  });

  it("rejects when summary is missing", () => {
    const { summary: _s, ...rest } = validResult;
    expect(() => ToolResultSchema.parse(rest)).toThrow();
  });

  it("rejects when durationMs is missing", () => {
    const { durationMs: _d, ...rest } = validResult;
    expect(() => ToolResultSchema.parse(rest)).toThrow();
  });

  it("accepts unknown data shapes", () => {
    const result = ToolResultSchema.parse({ ...validResult, data: [1, 2, 3] });
    expect(result.data).toEqual([1, 2, 3]);
  });
});

describe("ToolPermissionLevelSchema", () => {
  const validLevels = [
    "read_only",
    "read_metrics",
    "write_local",
    "execute",
    "write_remote",
  ] as const;

  it.each(validLevels)("parses valid level: %s", (level) => {
    expect(ToolPermissionLevelSchema.parse(level)).toBe(level);
  });

  it("rejects an invalid permission level", () => {
    expect(() => ToolPermissionLevelSchema.parse("superuser")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => ToolPermissionLevelSchema.parse("")).toThrow();
  });
});

describe("ToolMetadataSchema", () => {
  const validMeta = {
    name: "glob",
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
  };

  it("parses valid metadata with defaults applied", () => {
    const result = ToolMetadataSchema.parse(validMeta);
    expect(result.name).toBe("glob");
    expect(result.aliases).toEqual([]);
    expect(result.permissionLevel).toBe("read_only");
    expect(result.isReadOnly).toBe(true);
    expect(result.isDestructive).toBe(false);
    expect(result.shouldDefer).toBe(false);
    expect(result.alwaysLoad).toBe(false);
    expect(result.maxConcurrency).toBe(0);
    expect(result.maxOutputChars).toBe(8000);
    expect(result.tags).toEqual([]);
  });

  it("parses metadata with explicit overrides", () => {
    const meta = {
      ...validMeta,
      aliases: ["find", "search"],
      shouldDefer: true,
      alwaysLoad: false,
      maxConcurrency: 5,
      maxOutputChars: 4000,
      tags: ["file", "search"],
    };
    const result = ToolMetadataSchema.parse(meta);
    expect(result.aliases).toEqual(["find", "search"]);
    expect(result.shouldDefer).toBe(true);
    expect(result.maxConcurrency).toBe(5);
    expect(result.maxOutputChars).toBe(4000);
    expect(result.tags).toEqual(["file", "search"]);
  });

  it("rejects when name is missing", () => {
    const { name: _n, ...rest } = validMeta;
    expect(() => ToolMetadataSchema.parse(rest)).toThrow();
  });

  it("rejects when permissionLevel is invalid", () => {
    expect(() =>
      ToolMetadataSchema.parse({ ...validMeta, permissionLevel: "root" })
    ).toThrow();
  });

  it("rejects when isReadOnly is missing", () => {
    const { isReadOnly: _r, ...rest } = validMeta;
    expect(() => ToolMetadataSchema.parse(rest)).toThrow();
  });
});

describe("PermissionCheckResultSchema", () => {
  it("parses the allowed variant", () => {
    const result = PermissionCheckResultSchema.parse({ status: "allowed" });
    expect(result.status).toBe("allowed");
  });

  it("parses the denied variant with reason", () => {
    const result = PermissionCheckResultSchema.parse({
      status: "denied",
      reason: "Insufficient trust",
    });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("Insufficient trust");
    }
  });

  it("parses the needs_approval variant with reason", () => {
    const result = PermissionCheckResultSchema.parse({
      status: "needs_approval",
      reason: "Destructive operation requires confirmation",
    });
    expect(result.status).toBe("needs_approval");
    if (result.status === "needs_approval") {
      expect(result.reason).toBe("Destructive operation requires confirmation");
    }
  });

  it("rejects an unknown status", () => {
    expect(() =>
      PermissionCheckResultSchema.parse({ status: "maybe", reason: "unsure" })
    ).toThrow();
  });

  it("rejects denied without reason", () => {
    expect(() =>
      PermissionCheckResultSchema.parse({ status: "denied" })
    ).toThrow();
  });

  it("rejects needs_approval without reason", () => {
    expect(() =>
      PermissionCheckResultSchema.parse({ status: "needs_approval" })
    ).toThrow();
  });
});
