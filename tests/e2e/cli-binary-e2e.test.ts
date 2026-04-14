import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { makeTempDir } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const RUN_BINARY_E2E = process.env["PULSEED_RUN_BINARY_E2E"] === "1";
const CLI_PATH = path.resolve(process.cwd(), "dist", "interface", "cli", "cli-runner.js");

async function runBuiltCli(args: string[], pulseedHome: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        PULSEED_HOME: pulseedHome,
        NO_COLOR: "1",
      },
      timeout: 10_000,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const error = err as Error & {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

describe.skipIf(!RUN_BINARY_E2E)("built CLI binary", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      tmpDir = null;
    }
  });

  it("prints actionable stderr for missing run goal", async () => {
    expect(fs.existsSync(CLI_PATH), `Build first with \`npm run build\`; missing ${CLI_PATH}`).toBe(true);
    tmpDir = makeTempDir("pulseed-cli-binary-");

    const result = await runBuiltCli(["run"], tmpDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: --goal <id> is required for pulseed run.");
    expect(result.stderr).toContain("Usage: pulseed run --goal <id>");
    expect(result.stderr).not.toContain("required for \\.");
  });
});
