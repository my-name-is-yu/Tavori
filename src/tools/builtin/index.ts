export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";
export { ReadTool } from "./read.js";
export { ShellTool } from "./shell.js";
export { HttpFetchTool } from "./http-fetch.js";
export { JsonQueryTool } from "./json-query.js";
export { GitLogTool } from "./git-log.js";
export { ListDirTool } from "./list-dir.js";
export { ProcessStatusTool } from "./process-status.js";
export { TestRunnerTool } from "./test-runner.js";
export { GoalStateTool } from "./goal-state.js";
export { TrustStateTool } from "./trust-state.js";
export { SessionHistoryTool } from "./session-history.js";
export { KnowledgeQueryTool } from "./knowledge-query.js";
export { ProgressHistoryTool } from "./progress-history.js";
export { WebSearchTool, createWebSearchClient } from "./web-search.js";
export type { ISearchClient, SearchResult } from "./web-search.js";
export { ToolSearchTool } from "./tool-search.js";

import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { ReadTool } from "./read.js";
import { ShellTool } from "./shell.js";
import { HttpFetchTool } from "./http-fetch.js";
import { JsonQueryTool } from "./json-query.js";
import { GitLogTool } from "./git-log.js";
import { ListDirTool } from "./list-dir.js";
import { ProcessStatusTool } from "./process-status.js";
import { TestRunnerTool } from "./test-runner.js";
import { GoalStateTool } from "./goal-state.js";
import { TrustStateTool } from "./trust-state.js";
import { SessionHistoryTool } from "./session-history.js";
import { KnowledgeQueryTool } from "./knowledge-query.js";
import { ProgressHistoryTool } from "./progress-history.js";
import { WebSearchTool, createWebSearchClient } from "./web-search.js";
import { ToolSearchTool } from "./tool-search.js";
import type { ITool } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import type { ToolRegistry } from "../registry.js";

export interface BuiltinToolDeps {
  stateManager?: StateManager;
  knowledgeManager?: KnowledgeManager;
  registry?: ToolRegistry;
}

/** All built-in tools, sorted alphabetically by name. */
export function createBuiltinTools(deps?: BuiltinToolDeps): ITool[] {
  const tools: ITool[] = [
    new EnvTool(),
    new GitDiffTool(),
    new GitLogTool(),
    new GlobTool(),
    new GrepTool(),
    new HttpFetchTool(),
    new JsonQueryTool(),
    new ListDirTool(),
    new ProcessStatusTool(),
    new ReadTool(),
    new ShellTool(),
    new TestRunnerTool(),
  ];

  if (deps?.stateManager) {
    tools.push(
      new GoalStateTool(deps.stateManager),
      new TrustStateTool(deps.stateManager),
      new SessionHistoryTool(deps.stateManager),
      new ProgressHistoryTool(deps.stateManager),
    );
  }

  if (deps?.knowledgeManager) {
    tools.push(new KnowledgeQueryTool(deps.knowledgeManager));
  }

  const searchClient = createWebSearchClient();
  if (searchClient) {
    tools.push(new WebSearchTool(searchClient));
  }

  if (deps?.registry) {
    tools.push(new ToolSearchTool(deps.registry));
  }

  return tools;
}
