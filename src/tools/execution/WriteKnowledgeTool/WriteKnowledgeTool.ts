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
import { KnowledgeEntrySchema } from "../../../base/types/knowledge.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const WriteKnowledgeInputSchema = z.object({
  key: z.string().min(1, "key is required"),
  content: z.string().min(1, "content is required"),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type WriteKnowledgeInput = z.infer<typeof WriteKnowledgeInputSchema>;

export class WriteKnowledgeTool implements ITool<WriteKnowledgeInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "write-knowledge",
    aliases: ["store_knowledge", "save_knowledge"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 2000,
    tags: [...TAGS],
  };
  readonly inputSchema = WriteKnowledgeInputSchema;

  constructor(private readonly knowledgeManager: KnowledgeManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: WriteKnowledgeInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const now = new Date().toISOString();
      const entry = KnowledgeEntrySchema.parse({
        entry_id: crypto.randomUUID(),
        question: input.key,
        answer: input.content,
        sources: [],
        confidence: 1.0,
        acquired_at: now,
        acquisition_task_id: context.sessionId ?? "manual",
        superseded_by: null,
        tags: input.tags ?? (input.category ? [input.category] : []),
        embedding_id: null,
      });
      await this.knowledgeManager.saveKnowledge(context.goalId, entry);
      return {
        success: true,
        data: { entryId: entry.entry_id, key: input.key },
        summary: `Knowledge stored: ${input.key}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "WriteKnowledgeTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: WriteKnowledgeInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: WriteKnowledgeInput): boolean {
    return false;
  }
}
