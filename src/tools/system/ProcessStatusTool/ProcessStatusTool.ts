import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";

export const ProcessStatusInputSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  processName: z.string().min(1).optional(),
  pid: z.number().int().min(1).optional(),
}).refine(
  (d) => d.port !== undefined || d.processName !== undefined || d.pid !== undefined,
  { message: "At least one of port, processName, or pid is required" }
);

export type ProcessStatusInput = z.infer<typeof ProcessStatusInputSchema>;

export interface ProcessStatusOutput {
  alive: boolean;
  details?: string;
  pid?: number;
}

export class ProcessStatusTool implements ITool<ProcessStatusInput, ProcessStatusOutput> {
  readonly metadata: ToolMetadata = {
    name: "process-status",
    aliases: ["proc-status", "ps-check"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = ProcessStatusInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: ProcessStatusInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      if (input.pid !== undefined) {
        return await this._checkPid(input.pid, startTime);
      }
      if (input.port !== undefined) {
        return await this._checkPort(input.port, startTime);
      }
      if (input.processName !== undefined) {
        return await this._checkProcessName(input.processName, startTime);
      }
      // Unreachable due to Zod refinement, but satisfies TS
      return {
        success: false,
        data: { alive: false },
        summary: "No query parameter provided",
        error: "No query parameter provided",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { alive: false },
        summary: `ProcessStatusTool error: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async _checkPid(pid: number, startTime: number): Promise<ToolResult> {
    // kill -0 checks if process is alive without sending a signal
    const result = await execFileNoThrow("kill", ["-0", String(pid)], { timeoutMs: 5000 });
    const alive = result.exitCode === 0;
    const output: ProcessStatusOutput = { alive, pid };
    return {
      success: true,
      data: output,
      summary: alive ? `PID ${pid} is alive` : `PID ${pid} is not running`,
      durationMs: Date.now() - startTime,
    };
  }

  private async _checkPort(port: number, startTime: number): Promise<ToolResult> {
    const isWindows = process.platform === "win32";
    let result;

    if (isWindows) {
      result = await execFileNoThrow("netstat", ["-ano"], { timeoutMs: 5000 });
      const lines = result.stdout.split("\n").filter((l) => l.includes(`:${port} `));
      const alive = lines.length > 0;
      const output: ProcessStatusOutput = { alive, details: lines.slice(0, 5).join("\n") || undefined };
      return {
        success: true,
        data: output,
        summary: alive ? `Port ${port} is in use` : `Port ${port} is free`,
        durationMs: Date.now() - startTime,
      };
    }

    // macOS / Linux: lsof -i :PORT
    result = await execFileNoThrow("lsof", ["-i", `:${port}`, "-n", "-P"], { timeoutMs: 5000 });
    const alive = result.exitCode === 0 && result.stdout.trim().length > 0;
    const details = result.stdout.trim() || undefined;

    // Extract first PID from lsof output (second column of data rows)
    let pid: number | undefined;
    const lines = result.stdout.split("\n").filter(Boolean);
    if (lines.length > 1) {
      const cols = lines[1].trim().split(/\s+/);
      const parsed = parseInt(cols[1], 10);
      if (!isNaN(parsed)) pid = parsed;
    }

    const output: ProcessStatusOutput = { alive, details, pid };
    return {
      success: true,
      data: output,
      summary: alive ? `Port ${port} is in use${pid ? ` (PID ${pid})` : ""}` : `Port ${port} is free`,
      durationMs: Date.now() - startTime,
    };
  }

  private async _checkProcessName(name: string, startTime: number): Promise<ToolResult> {
    const isWindows = process.platform === "win32";
    let result;

    if (isWindows) {
      result = await execFileNoThrow("tasklist", ["/FI", `IMAGENAME eq ${name}`], { timeoutMs: 5000 });
      const alive = result.stdout.includes(name);
      const output: ProcessStatusOutput = { alive, details: result.stdout.trim() || undefined };
      return {
        success: true,
        data: output,
        summary: alive ? `Process "${name}" is running` : `Process "${name}" is not running`,
        durationMs: Date.now() - startTime,
      };
    }

    // macOS / Linux: pgrep -la <name>
    result = await execFileNoThrow("pgrep", ["-la", name], { timeoutMs: 5000 });
    const alive = result.exitCode === 0 && result.stdout.trim().length > 0;
    const details = result.stdout.trim() || undefined;

    // Extract first PID
    let pid: number | undefined;
    if (details) {
      const firstLine = details.split("\n")[0];
      const parsed = parseInt(firstLine.trim().split(/\s+/)[0], 10);
      if (!isNaN(parsed)) pid = parsed;
    }

    const output: ProcessStatusOutput = { alive, details, pid };
    return {
      success: true,
      data: output,
      summary: alive ? `Process "${name}" is running${pid ? ` (PID ${pid})` : ""}` : `Process "${name}" is not running`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(_input: ProcessStatusInput): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ProcessStatusInput): boolean {
    return true;
  }
}
