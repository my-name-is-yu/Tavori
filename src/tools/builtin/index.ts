export { GlobTool } from "../fs/GlobTool/GlobTool.js";
export { GrepTool } from "../fs/GrepTool/GrepTool.js";
export { ReadTool } from "../fs/ReadTool/ReadTool.js";
export { ShellTool } from "../system/ShellTool/ShellTool.js";
export { HttpFetchTool } from "../network/HttpFetchTool/HttpFetchTool.js";
export { JsonQueryTool } from "../fs/JsonQueryTool/JsonQueryTool.js";
export { GitLogTool } from "../system/GitLogTool/GitLogTool.js";
export { ListDirTool } from "../fs/ListDirTool/ListDirTool.js";
export { ProcessStatusTool } from "../system/ProcessStatusTool/ProcessStatusTool.js";
export { TestRunnerTool } from "../system/TestRunnerTool/TestRunnerTool.js";
export { GoalStateTool } from "../query/GoalStateTool/GoalStateTool.js";
export { TrustStateTool } from "../query/TrustStateTool/TrustStateTool.js";
export { SessionHistoryTool } from "../query/SessionHistoryTool/SessionHistoryTool.js";
export { KnowledgeQueryTool } from "../query/KnowledgeQueryTool/KnowledgeQueryTool.js";
export { ProgressHistoryTool } from "../query/ProgressHistoryTool/ProgressHistoryTool.js";
export { ConfigTool } from "../query/ConfigTool/ConfigTool.js";
export { PluginStateTool } from "../query/PluginStateTool/PluginStateTool.js";
export { ArchitectureTool } from "../query/ArchitectureTool/ArchitectureTool.js";
export { WebSearchTool, createWebSearchClient } from "../network/WebSearchTool/WebSearchTool.js";
export type { ISearchClient, SearchResult } from "../network/WebSearchTool/WebSearchTool.js";
export { ToolSearchTool } from "../query/ToolSearchTool/ToolSearchTool.js";
export { EnvTool } from "../system/EnvTool/EnvTool.js";
export { SleepTool } from "../system/SleepTool/SleepTool.js";
export { GitDiffTool } from "../system/GitDiffTool/GitDiffTool.js";
export { FileWriteTool } from "../fs/FileWriteTool/FileWriteTool.js";
export { FileEditTool } from "../fs/FileEditTool/FileEditTool.js";
export { validateFilePath } from "../fs/FileValidationTool/FileValidationTool.js";
export { SetGoalTool } from "../mutation/SetGoalTool/SetGoalTool.js";
export { UpdateGoalTool } from "../mutation/UpdateGoalTool/UpdateGoalTool.js";
export { ArchiveGoalTool } from "../mutation/ArchiveGoalTool/ArchiveGoalTool.js";
export { DeleteGoalTool } from "../mutation/DeleteGoalTool/DeleteGoalTool.js";
export { TogglePluginTool } from "../mutation/TogglePluginTool/TogglePluginTool.js";
export { UpdateConfigTool } from "../mutation/UpdateConfigTool/UpdateConfigTool.js";
export { ResetTrustTool } from "../mutation/ResetTrustTool/ResetTrustTool.js";
export { RunAdapterTool } from "../execution/RunAdapterTool/RunAdapterTool.js";
export { SpawnSessionTool } from "../execution/SpawnSessionTool/SpawnSessionTool.js";
export { WriteKnowledgeTool } from "../execution/WriteKnowledgeTool/WriteKnowledgeTool.js";
export { QueryDataSourceTool } from "../execution/QueryDataSourceTool/QueryDataSourceTool.js";
export { ObserveGoalTool } from "../execution/ObserveGoalTool/ObserveGoalTool.js";
export { ReadPulseedFileTool } from "../fs/ReadPulseedFileTool/ReadPulseedFileTool.js";
export { WritePulseedFileTool } from "../fs/WritePulseedFileTool/WritePulseedFileTool.js";
export { AskHumanTool } from "../interaction/AskHumanTool/AskHumanTool.js";
export { CreatePlanTool } from "../interaction/CreatePlanTool/CreatePlanTool.js";
export { ReadPlanTool } from "../interaction/ReadPlanTool/ReadPlanTool.js";

import { GlobTool } from "../fs/GlobTool/GlobTool.js";
import { GrepTool } from "../fs/GrepTool/GrepTool.js";
import { ReadTool } from "../fs/ReadTool/ReadTool.js";
import { ShellTool } from "../system/ShellTool/ShellTool.js";
import { HttpFetchTool } from "../network/HttpFetchTool/HttpFetchTool.js";
import { JsonQueryTool } from "../fs/JsonQueryTool/JsonQueryTool.js";
import { GitLogTool } from "../system/GitLogTool/GitLogTool.js";
import { ListDirTool } from "../fs/ListDirTool/ListDirTool.js";
import { ProcessStatusTool } from "../system/ProcessStatusTool/ProcessStatusTool.js";
import { TestRunnerTool } from "../system/TestRunnerTool/TestRunnerTool.js";
import { GoalStateTool } from "../query/GoalStateTool/GoalStateTool.js";
import { TrustStateTool } from "../query/TrustStateTool/TrustStateTool.js";
import { SessionHistoryTool } from "../query/SessionHistoryTool/SessionHistoryTool.js";
import { KnowledgeQueryTool } from "../query/KnowledgeQueryTool/KnowledgeQueryTool.js";
import { ProgressHistoryTool } from "../query/ProgressHistoryTool/ProgressHistoryTool.js";
import { ConfigTool } from "../query/ConfigTool/ConfigTool.js";
import { PluginStateTool } from "../query/PluginStateTool/PluginStateTool.js";
import { ArchitectureTool } from "../query/ArchitectureTool/ArchitectureTool.js";
import { WebSearchTool, createWebSearchClient } from "../network/WebSearchTool/WebSearchTool.js";
import { ToolSearchTool } from "../query/ToolSearchTool/ToolSearchTool.js";
import { EnvTool } from "../system/EnvTool/EnvTool.js";
import { SleepTool } from "../system/SleepTool/SleepTool.js";
import { GitDiffTool } from "../system/GitDiffTool/GitDiffTool.js";
import { FileWriteTool } from "../fs/FileWriteTool/FileWriteTool.js";
import { FileEditTool } from "../fs/FileEditTool/FileEditTool.js";
import { SetGoalTool } from "../mutation/SetGoalTool/SetGoalTool.js";
import { UpdateGoalTool } from "../mutation/UpdateGoalTool/UpdateGoalTool.js";
import { ArchiveGoalTool } from "../mutation/ArchiveGoalTool/ArchiveGoalTool.js";
import { DeleteGoalTool } from "../mutation/DeleteGoalTool/DeleteGoalTool.js";
import { TogglePluginTool } from "../mutation/TogglePluginTool/TogglePluginTool.js";
import { UpdateConfigTool } from "../mutation/UpdateConfigTool/UpdateConfigTool.js";
import { ResetTrustTool } from "../mutation/ResetTrustTool/ResetTrustTool.js";
import { RunAdapterTool } from "../execution/RunAdapterTool/RunAdapterTool.js";
import { SpawnSessionTool } from "../execution/SpawnSessionTool/SpawnSessionTool.js";
import { WriteKnowledgeTool } from "../execution/WriteKnowledgeTool/WriteKnowledgeTool.js";
import { QueryDataSourceTool } from "../execution/QueryDataSourceTool/QueryDataSourceTool.js";
import { ObserveGoalTool } from "../execution/ObserveGoalTool/ObserveGoalTool.js";
import { ReadPulseedFileTool } from "../fs/ReadPulseedFileTool/ReadPulseedFileTool.js";
import { WritePulseedFileTool } from "../fs/WritePulseedFileTool/WritePulseedFileTool.js";
import { AskHumanTool } from "../interaction/AskHumanTool/AskHumanTool.js";
import { CreatePlanTool } from "../interaction/CreatePlanTool/CreatePlanTool.js";
import { ReadPlanTool } from "../interaction/ReadPlanTool/ReadPlanTool.js";
import type { AdapterRegistry } from "../../orchestrator/execution/adapter-layer.js";
import type { SessionManager } from "../../orchestrator/execution/session-manager.js";
import type { ObservationEngine } from "../../platform/observation/observation-engine.js";
import type { ITool } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import type { ToolRegistry } from "../registry.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";

export interface BuiltinToolDeps {
  stateManager?: StateManager;
  knowledgeManager?: KnowledgeManager;
  registry?: ToolRegistry;
  pluginLoader?: PluginLoader;
  trustManager?: TrustManager;
  adapterRegistry?: AdapterRegistry;
  sessionManager?: SessionManager;
  observationEngine?: ObservationEngine;
}

/** All built-in tools, sorted alphabetically by name. */
export function createBuiltinTools(deps?: BuiltinToolDeps): ITool[] {
  const tools: ITool[] = [
    new EnvTool(),
    new FileEditTool(),
    new FileWriteTool(),
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
    new SleepTool(),
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

  tools.push(new ConfigTool(), new ArchitectureTool());

  if (deps?.pluginLoader) {
    tools.push(new PluginStateTool(deps.pluginLoader));
  }


  // Mutation tools (require stateManager, trustManager, etc.)
  if (deps?.stateManager) {
    tools.push(
      new SetGoalTool(deps.stateManager),
      new UpdateGoalTool(deps.stateManager),
      new ArchiveGoalTool(deps.stateManager),
      new DeleteGoalTool(deps.stateManager),
    );
  }

  tools.push(new TogglePluginTool(), new UpdateConfigTool());

  if (deps?.trustManager) {
    tools.push(new ResetTrustTool(deps.trustManager));
  }

  const searchClient = createWebSearchClient();
  if (searchClient) {
    tools.push(new WebSearchTool(searchClient));
  }

  if (deps?.registry) {
    tools.push(new ToolSearchTool(deps.registry));
  }

  // Execution tools (require deps)
  if (deps?.adapterRegistry) {
    tools.push(new RunAdapterTool(deps.adapterRegistry));
  }
  if (deps?.sessionManager) {
    tools.push(new SpawnSessionTool(deps.sessionManager));
  }

  // Knowledge tools (require deps)
  if (deps?.knowledgeManager) {
    tools.push(new WriteKnowledgeTool(deps.knowledgeManager));
  }
  if (deps?.observationEngine) {
    tools.push(new QueryDataSourceTool(deps.observationEngine));
    tools.push(new ObserveGoalTool(deps.observationEngine));
  }

  // File and interaction tools (no deps)
  tools.push(
    new ReadPulseedFileTool(),
    new WritePulseedFileTool(),
    new AskHumanTool(),
    new CreatePlanTool(),
    new ReadPlanTool(),
  );

  return tools;
}
