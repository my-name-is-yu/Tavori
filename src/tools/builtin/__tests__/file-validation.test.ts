import { describe, it, expect } from "vitest";
import { validateFilePath } from "../file-validation.js";

describe("validateFilePath", () => {
  const cwd = "/tmp/test";

  it("accepts valid relative path", () => {
    const result = validateFilePath("output/file.txt", cwd);
    expect(result.valid).toBe(true);
    expect(result.resolved).toBe("/tmp/test/output/file.txt");
  });

  it("rejects path traversal", () => {
    const result = validateFilePath("../../etc/passwd", cwd);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Path traversal");
  });

  it("rejects .env paths", () => {
    const result = validateFilePath(".env", cwd);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(".env");
  });

  it("rejects node_modules paths", () => {
    const result = validateFilePath("node_modules/somelib/index.js", cwd);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("node_modules");
  });

  it("rejects credentials paths", () => {
    const result = validateFilePath("config/credentials.json", cwd);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("credentials");
  });

  it("rejects node_modules path without trailing slash", () => {
    const result = validateFilePath("node_modules", cwd);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("node_modules");
  });
});
