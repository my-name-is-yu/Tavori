import { describe, it, expect } from "vitest";
import { parseToolOutput } from "../parse-tool-output.js";

describe("parseToolOutput", () => {
  describe("shell stdout parsing", () => {
    it("parses numeric stdout as number", () => {
      const result = parseToolOutput("shell", { stdout: "42", stderr: "" });
      expect(result.value).toBe(42);
      expect(result.type).toBe("number");
    });

    it("parses float stdout as number", () => {
      const result = parseToolOutput("shell", { stdout: "3.14", stderr: "" });
      expect(result.value).toBe(3.14);
      expect(result.type).toBe("number");
    });

    it("falls back to string when stdout is non-numeric", () => {
      const result = parseToolOutput("shell", { stdout: "hello world", stderr: "" });
      expect(result.value).toBe("hello world");
      expect(result.type).toBe("string");
    });

    it("returns null for empty stdout", () => {
      const result = parseToolOutput("shell", { stdout: "", stderr: "" });
      expect(result.value).toBeNull();
      expect(result.type).toBe("null");
    });

    it("trims whitespace before parsing", () => {
      const result = parseToolOutput("shell", { stdout: "  99  ", stderr: "" });
      expect(result.value).toBe(99);
      expect(result.type).toBe("number");
    });
  });

  describe("glob file list parsing", () => {
    it("returns file count for non-empty array", () => {
      const result = parseToolOutput("glob", ["a.ts", "b.ts", "c.ts"]);
      expect(result.value).toBe(3);
      expect(result.type).toBe("number");
    });

    it("returns 0 for empty array", () => {
      const result = parseToolOutput("glob", []);
      expect(result.value).toBe(0);
      expect(result.type).toBe("number");
    });
  });

  describe("HTTP response parsing", () => {
    it("returns true for 2xx status code", () => {
      const result = parseToolOutput("http_fetch", { statusCode: 200, body: "{}" });
      expect(result.value).toBe(true);
      expect(result.type).toBe("boolean");
    });

    it("returns false for non-2xx status code", () => {
      const result = parseToolOutput("http_fetch", { statusCode: 404, body: "" });
      expect(result.value).toBe(false);
      expect(result.type).toBe("boolean");
    });
  });

  describe("fallback cases", () => {
    it("returns null for null input", () => {
      const result = parseToolOutput("unknown", null);
      expect(result.value).toBeNull();
      expect(result.type).toBe("null");
    });

    it("converts unknown data to string", () => {
      const result = parseToolOutput("unknown", 12345);
      expect(result.value).toBe("12345");
      expect(result.type).toBe("string");
    });
  });
});
