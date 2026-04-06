import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { LintFinding } from "../../../platform/knowledge/types/agent-memory.js";
import { lintAgentMemory } from "../../../platform/knowledge/knowledge-manager-lint.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL, TOOL_NAME, ALIASES } from "./constants.js";

export const MemoryLintInputSchema = z.object({
  auto_repair: z.boolean().optional().describe("Automatically repair detected issues"),
  categories: z
    .array(z.string())
    .optional()
    .describe("Only lint entries in these categories"),
});
export type MemoryLintInput = z.infer<typeof MemoryLintInputSchema>;

export interface MemoryLintOutput {
  findings: LintFinding[];
  repairs_applied: number;
  entries_flagged: number;
  summary: string;
}

export class MemoryLintTool implements ITool<MemoryLintInput, MemoryLintOutput> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 2000,
    tags: [...TAGS],
  };

  readonly inputSchema = MemoryLintInputSchema;

  constructor(
    private readonly km: KnowledgeManager,
    private readonly llmCall: (prompt: string) => Promise<string>
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: MemoryLintInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const result = await lintAgentMemory({
        km: this.km,
        llmCall: this.llmCall,
        autoRepair: input.auto_repair,
        categories: input.categories,
      });

      const counts: Record<string, number> = {};
      for (const finding of result.findings) {
        counts[finding.type] = (counts[finding.type] ?? 0) + 1;
      }

      const issueBreakdown = Object.entries(counts)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");

      const summary =
        result.findings.length === 0
          ? "No issues found."
          : `Found ${result.findings.length} issue${result.findings.length !== 1 ? "s" : ""}${issueBreakdown ? ` (${issueBreakdown})` : ""}. ${result.repairs_applied} repair${result.repairs_applied !== 1 ? "s" : ""} applied.`;

      const output: MemoryLintOutput = {
        findings: result.findings,
        repairs_applied: result.repairs_applied,
        entries_flagged: result.entries_flagged,
        summary,
      };

      return {
        success: true,
        data: output,
        summary,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "MemoryLintTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: MemoryLintInput,
    _context: ToolCallContext
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: MemoryLintInput): boolean {
    return false;
  }
}
