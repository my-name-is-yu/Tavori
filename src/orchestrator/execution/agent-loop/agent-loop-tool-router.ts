import type { ToolDefinition } from "../../../base/llm/llm-client.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import { toToolDefinition } from "../../../tools/tool-definition-adapter.js";
import type { ITool } from "../../../tools/types.js";
import type { AgentLoopTurnContext } from "./agent-loop-turn-context.js";

export interface AgentLoopToolRouter {
  modelVisibleTools(turn: AgentLoopTurnContext<unknown>): ToolDefinition[];
  resolveTool(name: string): ITool | null;
  isToolAllowed(name: string, turn: AgentLoopTurnContext<unknown>): boolean;
  supportsParallel(name: string, input: unknown): boolean;
}

export class ToolRegistryAgentLoopToolRouter implements AgentLoopToolRouter {
  constructor(private readonly registry: ToolRegistry) {}

  modelVisibleTools(turn: AgentLoopTurnContext<unknown>): ToolDefinition[] {
    return this.registry.listAll()
      .filter((tool) => this.isToolAllowed(tool.metadata.name, turn))
      .filter((tool) => turn.toolPolicy.includeDeferred || !tool.metadata.shouldDefer)
      .map((tool) => {
        const definition = toToolDefinition(tool);
        definition.function.description = tool.description({ cwd: turn.cwd, goalId: turn.goalId });
        return definition;
      });
  }

  resolveTool(name: string): ITool | null {
    return this.registry.get(name) ?? null;
  }

  isToolAllowed(name: string, turn: AgentLoopTurnContext<unknown>): boolean {
    if (turn.toolPolicy.deniedTools?.includes(name)) return false;
    const isRequired = turn.toolPolicy.requiredTools?.includes(name) ?? false;
    if (turn.toolPolicy.allowedTools && !turn.toolPolicy.allowedTools.includes(name) && !isRequired) return false;
    return this.resolveTool(name) !== null;
  }

  supportsParallel(name: string, input: unknown): boolean {
    return this.resolveTool(name)?.isConcurrencySafe(input) ?? false;
  }
}
