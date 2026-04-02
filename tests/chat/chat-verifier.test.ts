import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyChatAction } from "../../src/chat/chat-verifier.js";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";

// We mock execFile at the module level
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Helper to simulate promisified execFile resolving or rejecting
function mockExecFile(responses: Array<{ stdout: string; stderr: string } | Error>) {
  let callIndex = 0;
  vi.mocked(childProcess.execFile).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (err: Error | null, stdout: string, stderr: string) => void;
      const response = responses[callIndex++] ?? responses[responses.length - 1];
      if (response instanceof Error) {
        cb(response, "", "");
      } else {
        cb(null, response.stdout, response.stderr);
      }
      return {} as ReturnType<typeof childProcess.execFile>;
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyChatAction", () => {
  it("returns passed=true when tests pass after changes", async () => {
    mockExecFile([
      { stdout: " 1 file changed, 2 insertions(+)", stderr: "" }, // git diff
      { stdout: "✓ 42 tests passed\n", stderr: "" },              // vitest
    ]);

    const result = await verifyChatAction("/fake/cwd");
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=false with testOutput when tests fail", async () => {
    const vitestOutput = "FAIL src/foo.test.ts\n3 failed | 0 passed\n";
    mockExecFile([
      { stdout: " 1 file changed", stderr: "" }, // git diff
      { stdout: vitestOutput, stderr: "" },        // vitest
    ]);

    const result = await verifyChatAction("/fake/cwd");
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.testOutput).toBeTruthy();
  });

  it("returns passed=true when git is unavailable (skip verification)", async () => {
    mockExecFile([new Error("git: command not found")]);

    const result = await verifyChatAction("/fake/cwd");
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=true when vitest times out (graceful degradation)", async () => {
    mockExecFile([
      { stdout: " 1 file changed", stderr: "" },     // git diff — has changes
      new Error("Command timed out"),                  // vitest times out
    ]);

    const result = await verifyChatAction("/fake/cwd");
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=true when there are no git changes", async () => {
    mockExecFile([
      { stdout: "", stderr: "" }, // git diff — empty = no changes
    ]);

    const result = await verifyChatAction("/fake/cwd");
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
