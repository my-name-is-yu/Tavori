// ─── MCP Server Entry Point ───

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { StateManager } from "../state/state-manager.js";
import type { MCPServerDeps } from "./tools.js";
import {
  toolGoalList,
  toolGoalStatus,
  toolGoalCreate,
  toolObserve,
  toolTaskList,
  toolKnowledgeSearch,
  toolTrigger,
} from "./tools.js";

export { MCPServerDeps };

// ─── Server factory ───

export async function startMCPServer(deps: MCPServerDeps): Promise<void> {
  const server = new McpServer({
    name: "pulseed",
    version: "0.1.2",
  });

  // pulseed_goal_list
  server.tool("pulseed_goal_list", "List all PulSeed goals", async () => {
    return toolGoalList(deps);
  });

  // pulseed_goal_status
  server.tool(
    "pulseed_goal_status",
    "Get status and latest gap vector for a goal",
    { goal_id: z.string().describe("The goal ID") },
    async (args: { goal_id: string }) => {
      return toolGoalStatus(deps, args);
    }
  );

  // pulseed_goal_create
  server.tool(
    "pulseed_goal_create",
    "Create a new PulSeed goal",
    {
      title: z.string().describe("Goal title"),
      description: z.string().describe("Goal description"),
    },
    async (args: { title: string; description: string }) => {
      return toolGoalCreate(deps, args);
    }
  );

  // pulseed_observe
  server.tool(
    "pulseed_observe",
    "Get latest observations for a goal",
    { goal_id: z.string().describe("The goal ID") },
    async (args: { goal_id: string }) => {
      return toolObserve(deps, args);
    }
  );

  // pulseed_task_list
  server.tool(
    "pulseed_task_list",
    "List tasks for a goal",
    { goal_id: z.string().describe("The goal ID") },
    async (args: { goal_id: string }) => {
      return toolTaskList(deps, args);
    }
  );

  // pulseed_knowledge_search
  server.tool(
    "pulseed_knowledge_search",
    "Search the PulSeed knowledge base",
    { query: z.string().describe("Search query") },
    async (args: { query: string }) => {
      return toolKnowledgeSearch(deps, args);
    }
  );

  // pulseed_trigger
  server.tool(
    "pulseed_trigger",
    "Create an event in the PulSeed event queue",
    {
      source: z.string().describe("Event source identifier"),
      event_type: z.string().describe("Type of event"),
      data: z.record(z.unknown()).describe("Event payload"),
    },
    async (args: { source: string; event_type: string; data: Record<string, unknown> }) => {
      return toolTrigger(deps, args);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Create deps from environment ───

function createDepsFromEnv(): MCPServerDeps {
  const baseDir = process.env["PULSEED_DIR"] ?? `${process.env["HOME"]}/.pulseed`;
  const stateManager = new StateManager(baseDir);
  return { stateManager, baseDir };
}

// ─── Standalone entry point ───

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deps = createDepsFromEnv();
  startMCPServer(deps).catch((err) => {
    process.stderr.write(`MCP server error: ${String(err)}\n`);
    process.exit(1);
  });
}
