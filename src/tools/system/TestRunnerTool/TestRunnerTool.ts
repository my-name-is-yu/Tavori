import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";

export const TestRunnerInputSchema = z.object({
  command: z.string().default("npx vitest run"),
  cwd: z.string().optional(),
  pattern: z.string().optional(),
  timeout: z.number().default(60_000),
});

export type TestRunnerInput = z.infer<typeof TestRunnerInputSchema>;

export interface TestRunnerOutput {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  success: boolean;
  duration?: number;
  failedTests?: string[];
  rawOutput: string;
}

const MAX_RAW_OUTPUT = 10_000;

/** Parse vitest summary: "Tests  5 passed | 2 failed | 1 skipped (8)" */
function parseVitest(output: string): Partial<TestRunnerOutput> {
  const result: Partial<TestRunnerOutput> = {};

  // vitest "Tests  X passed (Y)" or "Tests  X passed | Z failed (N)"
  const testsLine = output.match(/Tests\s+(.+)/);
  if (testsLine) {
    const passedM = testsLine[1].match(/(\d+)\s+passed/);
    const failedM = testsLine[1].match(/(\d+)\s+failed/);
    const skippedM = testsLine[1].match(/(\d+)\s+skipped/);
    const totalM = testsLine[1].match(/\((\d+)\)/);
    if (passedM) result.passed = parseInt(passedM[1], 10);
    if (failedM) result.failed = parseInt(failedM[1], 10);
    if (skippedM) result.skipped = parseInt(skippedM[1], 10);
    if (totalM) result.total = parseInt(totalM[1], 10);
  }

  // Duration: "Duration  1.23s"
  const durM = output.match(/Duration\s+([\d.]+)s/);
  if (durM) result.duration = Math.round(parseFloat(durM[1]) * 1000);

  // Collect failed test names from vitest output: " FAIL src/..." or "× test name"
  const failedTests: string[] = [];
  for (const line of output.split("\n")) {
    if (/^\s*×\s/.test(line)) {
      failedTests.push(line.replace(/^\s*×\s*/, "").trim());
    }
  }
  if (failedTests.length > 0) result.failedTests = failedTests;

  return result;
}

/** Parse jest summary: "Tests: 5 passed, 2 failed, 7 total" */
function parseJest(output: string): Partial<TestRunnerOutput> {
  const result: Partial<TestRunnerOutput> = {};
  const testsLine = output.match(/Tests:\s+(.+)/);
  if (testsLine) {
    const passedM = testsLine[1].match(/(\d+)\s+passed/);
    const failedM = testsLine[1].match(/(\d+)\s+failed/);
    const skippedM = testsLine[1].match(/(\d+)\s+skipped/);
    const totalM = testsLine[1].match(/(\d+)\s+total/);
    if (passedM) result.passed = parseInt(passedM[1], 10);
    if (failedM) result.failed = parseInt(failedM[1], 10);
    if (skippedM) result.skipped = parseInt(skippedM[1], 10);
    if (totalM) result.total = parseInt(totalM[1], 10);
  }
  const timeM = output.match(/Time:\s+([\d.]+)\s*s/);
  if (timeM) result.duration = Math.round(parseFloat(timeM[1]) * 1000);
  return result;
}

/** Parse mocha summary: "5 passing (200ms)" / "2 failing" */
function parseMocha(output: string): Partial<TestRunnerOutput> {
  const result: Partial<TestRunnerOutput> = {};
  const passM = output.match(/(\d+)\s+passing/);
  const failM = output.match(/(\d+)\s+failing/);
  const pendM = output.match(/(\d+)\s+pending/);
  if (passM) result.passed = parseInt(passM[1], 10);
  if (failM) result.failed = parseInt(failM[1], 10);
  if (pendM) result.skipped = parseInt(pendM[1], 10);
  if (result.passed !== undefined || result.failed !== undefined) {
    result.total = (result.passed ?? 0) + (result.failed ?? 0) + (result.skipped ?? 0);
  }
  const timeM = output.match(/passing\s+\((\d+)ms\)/);
  if (timeM) result.duration = parseInt(timeM[1], 10);
  return result;
}

function parseOutput(output: string): Partial<TestRunnerOutput> {
  if (/Tests\s+\d+/.test(output)) return parseVitest(output);
  if (/Tests:\s+\d+/.test(output)) return parseJest(output);
  if (/\d+\s+passing/.test(output)) return parseMocha(output);
  return {};
}

function buildTestCommand(command: string, pattern?: string): { cmd: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  if (pattern) args.push(pattern);
  return { cmd, args };
}

export class TestRunnerTool implements ITool<TestRunnerInput, TestRunnerOutput> {
  readonly metadata: ToolMetadata = {
    name: "test-runner",
    aliases: ["run-tests", "vitest", "jest"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = TestRunnerInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: TestRunnerInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwd = input.cwd ?? context.cwd;
    const { cmd, args } = buildTestCommand(input.command, input.pattern);

    try {
      const result = await execFileNoThrow(cmd, args, { cwd, timeoutMs: input.timeout });
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const rawOutput = combined.length > MAX_RAW_OUTPUT ? combined.slice(0, MAX_RAW_OUTPUT) + "\n...[truncated]" : combined;

      const parsed = parseOutput(combined);
      const passed = parsed.passed ?? 0;
      const failed = parsed.failed ?? 0;
      const skipped = parsed.skipped ?? 0;
      const total = parsed.total ?? (passed + failed + skipped);
      const success = result.exitCode === 0 && failed === 0;

      const output: TestRunnerOutput = {
        passed,
        failed,
        skipped,
        total,
        success,
        duration: parsed.duration,
        failedTests: parsed.failedTests,
        rawOutput,
      };

      return {
        success,
        data: output,
        summary: success
          ? `Tests passed: ${passed}/${total}${parsed.duration ? ` in ${parsed.duration}ms` : ""}`
          : `Tests failed: ${failed} failed, ${passed} passed (${total} total)`,
        error: success ? undefined : `${failed} test(s) failed`,
        durationMs: Date.now() - startTime,
        contextModifier: `Test results: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${total} total`,
      };
    } catch (err) {
      return {
        success: false,
        data: { passed: 0, failed: 0, skipped: 0, total: 0, success: false, rawOutput: (err as Error).message },
        summary: `Test runner error: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: TestRunnerInput): Promise<PermissionCheckResult> {
    // Only allow safe test runners — validate first token to prevent bypass (e.g., "jest; rm -rf /")
    const ALLOWED_BINARIES = ["npx", "npm", "node", "mocha", "jest", "vitest"];
    const parts = input.command.trim().split(/\s+/);
    const allowed = ALLOWED_BINARIES.includes(parts[0]);
    if (!allowed) {
      return { status: "needs_approval", reason: `Custom test command requires approval: ${input.command.trim()}` };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: TestRunnerInput): boolean {
    // Test runs may write to shared output files; not safe to run concurrently
    return false;
  }
}
