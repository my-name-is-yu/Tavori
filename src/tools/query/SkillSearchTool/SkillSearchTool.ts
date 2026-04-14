import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { SkillRegistry } from "../../../runtime/skills/skill-registry.js";

export const SkillSearchInputSchema = z.object({
  query: z.string().min(1),
});
export type SkillSearchInput = z.infer<typeof SkillSearchInputSchema>;

export class SkillSearchTool implements ITool<SkillSearchInput> {
  readonly metadata: ToolMetadata = {
    name: "skill_search",
    aliases: ["skills", "find_skill"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 10,
    maxOutputChars: 8000,
    tags: ["skills", "query"],
  };
  readonly inputSchema = SkillSearchInputSchema;

  constructor(private readonly registry = new SkillRegistry({ workspaceRoot: process.cwd() })) {}

  description(): string {
    return "Search installed PulSeed skills by name, id, description, or path.";
  }

  async call(input: SkillSearchInput, _context: ToolCallContext): Promise<ToolResult> {
    const start = Date.now();
    const results = await this.registry.search(input.query);
    return {
      success: true,
      data: results,
      summary: `Found ${results.length} skill(s) matching "${input.query}"`,
      durationMs: Date.now() - start,
    };
  }

  async checkPermissions(_input: SkillSearchInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: SkillSearchInput): boolean {
    return true;
  }
}
