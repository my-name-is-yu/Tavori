import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { SessionManager } from "../../../orchestrator/execution/session-manager.js";
import type { SessionType } from "../../../orchestrator/execution/types/session.js";
import { DEFAULT_CONTEXT_BUDGET } from "../../../orchestrator/execution/session-manager.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const SpawnSessionInputSchema = z.object({
  session_type: z.enum(["task_execution", "observation", "task_review", "goal_review", "chat_execution"]).optional(),
  role: z.enum(["default", "explorer", "worker", "reviewer"]).optional(),
  goal_id: z.string().min(1, "goal_id is required"),
  task_id: z.string().optional(),
  context_budget: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  if (!value.session_type && !value.role) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["session_type"],
      message: "session_type or role is required",
    });
  }
});
export type SpawnSessionInput = z.infer<typeof SpawnSessionInputSchema>;

export function resolveSpawnSessionType(input: Pick<SpawnSessionInput, "session_type" | "role">): SessionType {
  if (input.session_type) return input.session_type;
  switch (input.role) {
    case "explorer": return "observation";
    case "reviewer": return "task_review";
    case "worker": return "task_execution";
    default: return "chat_execution";
  }
}

export class SpawnSessionTool implements ITool<SpawnSessionInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "spawn-session",
    aliases: ["create_session"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = SpawnSessionInputSchema;

  constructor(private readonly sessionManager: SessionManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SpawnSessionInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const session = await this.sessionManager.createSession(
        resolveSpawnSessionType(input),
        input.goal_id,
        input.task_id ?? null,
        input.context_budget ?? DEFAULT_CONTEXT_BUDGET,
      );
      return {
        success: true,
        data: {
          sessionId: session.id,
          session_type: session.session_type,
          goal_id: session.goal_id,
          role: input.role ?? "default",
        },
        summary: `Session ${session.id} created (type=${session.session_type}, role=${input.role ?? "default"})`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "SpawnSessionTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: SpawnSessionInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "SpawnSessionTool creates a new agent session and requires approval." };
  }

  isConcurrencySafe(_input: SpawnSessionInput): boolean {
    return false;
  }
}
