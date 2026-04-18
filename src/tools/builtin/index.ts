export { GlobTool } from "../fs/GlobTool/GlobTool.js";
export { GrepTool } from "../fs/GrepTool/GrepTool.js";
export { ReadTool } from "../fs/ReadTool/ReadTool.js";
export { ShellTool } from "../system/ShellTool/ShellTool.js";
export { ShellCommandTool } from "../system/ShellCommandTool/ShellCommandTool.js";
export { UpdatePlanTool } from "../system/UpdatePlanTool/UpdatePlanTool.js";
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
export { TaskListTool } from "../query/TaskListTool/TaskListTool.js";
export { TaskGetTool } from "../query/TaskGetTool/TaskGetTool.js";
export { ConfigTool } from "../query/ConfigTool/ConfigTool.js";
export { PluginStateTool } from "../query/PluginStateTool/PluginStateTool.js";
export { ArchitectureTool } from "../query/ArchitectureTool/ArchitectureTool.js";
export { SoilQueryTool } from "../query/SoilQueryTool/SoilQueryTool.js";
export { SoilDoctorTool } from "../execution/SoilDoctorTool/SoilDoctorTool.js";
export { SoilImportTool } from "../execution/SoilImportTool/SoilImportTool.js";
export { SoilOpenTool } from "../execution/SoilOpenTool/SoilOpenTool.js";
export { SoilPublishTool } from "../execution/SoilPublishTool/SoilPublishTool.js";
export { SoilRebuildTool } from "../execution/SoilRebuildTool/SoilRebuildTool.js";
export { WebSearchTool, createWebSearchClient } from "../network/WebSearchTool/WebSearchTool.js";
export type { ISearchClient, SearchResult } from "../network/WebSearchTool/WebSearchTool.js";
export { GitHubReadTool, GitHubPrCreateTool } from "../network/GitHubCliTool/GitHubCliTool.js";
export { McpListToolsTool, McpCallToolTool } from "../network/McpStdioTool/McpStdioTool.js";
export { ToolSearchTool } from "../query/ToolSearchTool/ToolSearchTool.js";
export { SkillSearchTool } from "../query/SkillSearchTool/SkillSearchTool.js";
export { EnvTool } from "../system/EnvTool/EnvTool.js";
export { SleepTool } from "../system/SleepTool/SleepTool.js";
export { GitDiffTool } from "../system/GitDiffTool/GitDiffTool.js";
export {
  ProcessSessionManager,
  ProcessSessionStartTool,
  ProcessSessionReadTool,
  ProcessSessionWriteTool,
  ProcessSessionStopTool,
  ProcessSessionListTool,
  defaultProcessSessionManager,
} from "../system/ProcessSessionTool/ProcessSessionTool.js";
export { FileWriteTool } from "../fs/FileWriteTool/FileWriteTool.js";
export { FileEditTool } from "../fs/FileEditTool/FileEditTool.js";
export { ApplyPatchTool } from "../fs/ApplyPatchTool/ApplyPatchTool.js";
export { ViewImageTool } from "../media/ViewImageTool/ViewImageTool.js";
export { validateFilePath } from "../fs/FileValidationTool/FileValidationTool.js";
export { SetGoalTool } from "../mutation/SetGoalTool/SetGoalTool.js";
export { TaskCreateTool } from "../mutation/TaskCreateTool/TaskCreateTool.js";
export { TaskOutputTool } from "../mutation/TaskOutputTool/TaskOutputTool.js";
export { TaskStopTool } from "../mutation/TaskStopTool/TaskStopTool.js";
export { TaskUpdateTool } from "../mutation/TaskUpdateTool/TaskUpdateTool.js";
export { UpdateGoalTool } from "../mutation/UpdateGoalTool/UpdateGoalTool.js";
export { ArchiveGoalTool } from "../mutation/ArchiveGoalTool/ArchiveGoalTool.js";
export { DeleteGoalTool } from "../mutation/DeleteGoalTool/DeleteGoalTool.js";
export { TogglePluginTool } from "../mutation/TogglePluginTool/TogglePluginTool.js";
export { UpdateConfigTool } from "../mutation/UpdateConfigTool/UpdateConfigTool.js";
export { ConfigureNotificationRoutingTool } from "../mutation/ConfigureNotificationRoutingTool/ConfigureNotificationRoutingTool.js";
export { ResetTrustTool } from "../mutation/ResetTrustTool/ResetTrustTool.js";
export { RunAdapterTool } from "../execution/RunAdapterTool/RunAdapterTool.js";
export { SpawnSessionTool } from "../execution/SpawnSessionTool/SpawnSessionTool.js";
export { WriteKnowledgeTool } from "../execution/WriteKnowledgeTool/WriteKnowledgeTool.js";
export { MemorySaveTool } from "../execution/MemorySaveTool/MemorySaveTool.js";
export { MemoryConsolidateTool } from "../execution/MemoryConsolidateTool/MemoryConsolidateTool.js";
export { MemoryLintTool } from "../execution/MemoryLintTool/MemoryLintTool.js";
export { MemoryRecallTool } from "../query/MemoryRecallTool/MemoryRecallTool.js";
export { QueryDataSourceTool } from "../execution/QueryDataSourceTool/QueryDataSourceTool.js";
export { ObserveGoalTool } from "../execution/ObserveGoalTool/ObserveGoalTool.js";
export { ReadPulseedFileTool } from "../fs/ReadPulseedFileTool/ReadPulseedFileTool.js";
export { WritePulseedFileTool } from "../fs/WritePulseedFileTool/WritePulseedFileTool.js";
export { AskHumanTool } from "../interaction/AskHumanTool/AskHumanTool.js";
export { CreatePlanTool } from "../interaction/CreatePlanTool/CreatePlanTool.js";
export { ReadPlanTool } from "../interaction/ReadPlanTool/ReadPlanTool.js";
export { CreateScheduleTool } from "../schedule/CreateScheduleTool/CreateScheduleTool.js";
export { GetScheduleTool } from "../schedule/GetScheduleTool/GetScheduleTool.js";
export { ListSchedulesTool } from "../schedule/ListSchedulesTool/ListSchedulesTool.js";
export { PauseScheduleTool } from "../schedule/PauseScheduleTool/PauseScheduleTool.js";
export { RemoveScheduleTool } from "../schedule/RemoveScheduleTool/RemoveScheduleTool.js";
export { ResumeScheduleTool } from "../schedule/ResumeScheduleTool/ResumeScheduleTool.js";
export { RunScheduleTool } from "../schedule/RunScheduleTool/RunScheduleTool.js";
export { UpdateScheduleTool } from "../schedule/UpdateScheduleTool/UpdateScheduleTool.js";
export {
  BrowserGetStateTool,
  BrowserRunWorkflowTool,
  DesktopClickTool,
  DesktopGetAppStateTool,
  DesktopListAppsTool,
  DesktopTypeTextTool,
  ResearchAnswerWithSourcesTool,
  ResearchWebTool,
} from "../automation/index.js";
import type { InteractiveAutomationToolPolicy } from "../automation/index.js";

import { GlobTool } from "../fs/GlobTool/GlobTool.js";
import { GrepTool } from "../fs/GrepTool/GrepTool.js";
import { ReadTool } from "../fs/ReadTool/ReadTool.js";
import { ShellTool } from "../system/ShellTool/ShellTool.js";
import { ShellCommandTool } from "../system/ShellCommandTool/ShellCommandTool.js";
import { UpdatePlanTool } from "../system/UpdatePlanTool/UpdatePlanTool.js";
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
import { TaskListTool } from "../query/TaskListTool/TaskListTool.js";
import { TaskGetTool } from "../query/TaskGetTool/TaskGetTool.js";
import { ConfigTool } from "../query/ConfigTool/ConfigTool.js";
import { PluginStateTool } from "../query/PluginStateTool/PluginStateTool.js";
import { ArchitectureTool } from "../query/ArchitectureTool/ArchitectureTool.js";
import { SoilQueryTool } from "../query/SoilQueryTool/SoilQueryTool.js";
import { SoilDoctorTool } from "../execution/SoilDoctorTool/SoilDoctorTool.js";
import { SoilImportTool } from "../execution/SoilImportTool/SoilImportTool.js";
import { SoilOpenTool } from "../execution/SoilOpenTool/SoilOpenTool.js";
import { SoilPublishTool } from "../execution/SoilPublishTool/SoilPublishTool.js";
import { SoilRebuildTool } from "../execution/SoilRebuildTool/SoilRebuildTool.js";
import { WebSearchTool, createWebSearchClient } from "../network/WebSearchTool/WebSearchTool.js";
import { GitHubReadTool, GitHubPrCreateTool } from "../network/GitHubCliTool/GitHubCliTool.js";
import { McpListToolsTool, McpCallToolTool } from "../network/McpStdioTool/McpStdioTool.js";
import { ToolSearchTool } from "../query/ToolSearchTool/ToolSearchTool.js";
import { SkillSearchTool } from "../query/SkillSearchTool/SkillSearchTool.js";
import { EnvTool } from "../system/EnvTool/EnvTool.js";
import { SleepTool } from "../system/SleepTool/SleepTool.js";
import { GitDiffTool } from "../system/GitDiffTool/GitDiffTool.js";
import {
  ProcessSessionStartTool,
  ProcessSessionReadTool,
  ProcessSessionWriteTool,
  ProcessSessionStopTool,
  ProcessSessionListTool,
  defaultProcessSessionManager,
} from "../system/ProcessSessionTool/ProcessSessionTool.js";
import { FileWriteTool } from "../fs/FileWriteTool/FileWriteTool.js";
import { FileEditTool } from "../fs/FileEditTool/FileEditTool.js";
import { ApplyPatchTool } from "../fs/ApplyPatchTool/ApplyPatchTool.js";
import { ViewImageTool } from "../media/ViewImageTool/ViewImageTool.js";
import { SetGoalTool } from "../mutation/SetGoalTool/SetGoalTool.js";
import { TaskCreateTool } from "../mutation/TaskCreateTool/TaskCreateTool.js";
import { TaskOutputTool } from "../mutation/TaskOutputTool/TaskOutputTool.js";
import { TaskStopTool } from "../mutation/TaskStopTool/TaskStopTool.js";
import { TaskUpdateTool } from "../mutation/TaskUpdateTool/TaskUpdateTool.js";
import { UpdateGoalTool } from "../mutation/UpdateGoalTool/UpdateGoalTool.js";
import { ArchiveGoalTool } from "../mutation/ArchiveGoalTool/ArchiveGoalTool.js";
import { DeleteGoalTool } from "../mutation/DeleteGoalTool/DeleteGoalTool.js";
import { TogglePluginTool } from "../mutation/TogglePluginTool/TogglePluginTool.js";
import { UpdateConfigTool } from "../mutation/UpdateConfigTool/UpdateConfigTool.js";
import { ConfigureNotificationRoutingTool } from "../mutation/ConfigureNotificationRoutingTool/ConfigureNotificationRoutingTool.js";
import { ResetTrustTool } from "../mutation/ResetTrustTool/ResetTrustTool.js";
import { RunAdapterTool } from "../execution/RunAdapterTool/RunAdapterTool.js";
import { SpawnSessionTool } from "../execution/SpawnSessionTool/SpawnSessionTool.js";
import { WriteKnowledgeTool } from "../execution/WriteKnowledgeTool/WriteKnowledgeTool.js";
import { MemorySaveTool } from "../execution/MemorySaveTool/MemorySaveTool.js";
import { MemoryConsolidateTool } from "../execution/MemoryConsolidateTool/MemoryConsolidateTool.js";
import { MemoryLintTool } from "../execution/MemoryLintTool/MemoryLintTool.js";
import { MemoryRecallTool } from "../query/MemoryRecallTool/MemoryRecallTool.js";
import { QueryDataSourceTool } from "../execution/QueryDataSourceTool/QueryDataSourceTool.js";
import { ObserveGoalTool } from "../execution/ObserveGoalTool/ObserveGoalTool.js";
import { ReadPulseedFileTool } from "../fs/ReadPulseedFileTool/ReadPulseedFileTool.js";
import { WritePulseedFileTool } from "../fs/WritePulseedFileTool/WritePulseedFileTool.js";
import { AskHumanTool } from "../interaction/AskHumanTool/AskHumanTool.js";
import { CreatePlanTool } from "../interaction/CreatePlanTool/CreatePlanTool.js";
import { ReadPlanTool } from "../interaction/ReadPlanTool/ReadPlanTool.js";
import { CreateScheduleTool } from "../schedule/CreateScheduleTool/CreateScheduleTool.js";
import { GetScheduleTool } from "../schedule/GetScheduleTool/GetScheduleTool.js";
import { ListSchedulesTool } from "../schedule/ListSchedulesTool/ListSchedulesTool.js";
import { PauseScheduleTool } from "../schedule/PauseScheduleTool/PauseScheduleTool.js";
import { RemoveScheduleTool } from "../schedule/RemoveScheduleTool/RemoveScheduleTool.js";
import { ResumeScheduleTool } from "../schedule/ResumeScheduleTool/ResumeScheduleTool.js";
import { RunScheduleTool } from "../schedule/RunScheduleTool/RunScheduleTool.js";
import { UpdateScheduleTool } from "../schedule/UpdateScheduleTool/UpdateScheduleTool.js";
import {
  BrowserGetStateTool,
  BrowserRunWorkflowTool,
  DesktopClickTool,
  DesktopGetAppStateTool,
  DesktopListAppsTool,
  DesktopTypeTextTool,
  ResearchAnswerWithSourcesTool,
  ResearchWebTool,
} from "../automation/index.js";
import type { AdapterRegistry } from "../../orchestrator/execution/adapter-layer.js";
import type { SessionManager } from "../../orchestrator/execution/session-manager.js";
import type { ObservationEngine } from "../../platform/observation/observation-engine.js";
import type { ITool } from "../types.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import type { ToolRegistry } from "../registry.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";
import type { ScheduleEngine } from "../../runtime/schedule/engine.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";
import type { IEmbeddingClient } from "../../platform/knowledge/embedding-client.js";
import { loadGlobalConfigSync } from "../../base/config/global-config.js";
import {
  createDefaultInteractiveAutomationRegistry,
  type CodexAppComputerUseBridge,
  type InteractiveAutomationRegistry,
} from "../../runtime/interactive-automation/index.js";

export interface BuiltinToolDeps {
  stateManager?: StateManager;
  knowledgeManager?: KnowledgeManager;
  registry?: ToolRegistry;
  pluginLoader?: PluginLoader;
  trustManager?: TrustManager;
  adapterRegistry?: AdapterRegistry;
  sessionManager?: SessionManager;
  observationEngine?: ObservationEngine;
  llmCall?: (prompt: string) => Promise<string>;
  scheduleEngine?: ScheduleEngine;
  embeddingClient?: IEmbeddingClient | null;
  embeddingModel?: string;
  interactiveAutomationRegistry?: InteractiveAutomationRegistry;
  interactiveAutomationPolicy?: InteractiveAutomationToolPolicy;
  codexAppComputerUseBridge?: CodexAppComputerUseBridge;
}

/** All built-in tools, sorted alphabetically by name. */
export function createBuiltinTools(deps?: BuiltinToolDeps): ITool[] {
  const tools: ITool[] = [
    new EnvTool(),
    new ApplyPatchTool(),
    new FileEditTool(),
    new FileWriteTool(),
    new GitDiffTool(),
    new GitLogTool(),
    new GitHubPrCreateTool(),
    new GitHubReadTool(),
    new GlobTool(),
    new GrepTool(),
    new HttpFetchTool(),
    new JsonQueryTool(),
    new ListDirTool(),
    new ProcessStatusTool(),
    new ProcessSessionListTool(defaultProcessSessionManager),
    new ProcessSessionReadTool(defaultProcessSessionManager),
    new ProcessSessionStartTool(defaultProcessSessionManager),
    new ProcessSessionStopTool(defaultProcessSessionManager),
    new ProcessSessionWriteTool(defaultProcessSessionManager),
    new McpCallToolTool(),
    new McpListToolsTool(),
    new ReadTool(),
    new ShellCommandTool(),
    new ShellTool(),
    new SleepTool(),
    new TestRunnerTool(),
    new UpdatePlanTool(),
    new ViewImageTool(),
  ];

  if (deps?.stateManager) {
    tools.push(
      new GoalStateTool(deps.stateManager),
      new TrustStateTool(deps.stateManager),
      new SessionHistoryTool(deps.stateManager),
      new ProgressHistoryTool(deps.stateManager),
      new TaskListTool(deps.stateManager),
      new TaskGetTool(deps.stateManager),
    );
  }

  if (deps?.knowledgeManager) {
    tools.push(new KnowledgeQueryTool(deps.knowledgeManager));
    tools.push(new MemoryRecallTool(deps.knowledgeManager));
  }

  tools.push(
    new ConfigTool(),
    new ArchitectureTool(),
    new SkillSearchTool(),
    new SoilQueryTool(
      deps && "embeddingClient" in deps
        ? { embeddingClient: deps.embeddingClient ?? null, embeddingModel: deps.embeddingModel }
        : {}
    ),
    new SoilDoctorTool(),
    new SoilImportTool(),
    new SoilOpenTool(),
    new SoilPublishTool(),
  );

  if (deps?.pluginLoader) {
    tools.push(new PluginStateTool(deps.pluginLoader));
  }


  // Mutation tools (require stateManager, trustManager, etc.)
  if (deps?.stateManager) {
    tools.push(
      new SetGoalTool(deps.stateManager),
      new TaskCreateTool(deps.stateManager),
      new TaskOutputTool(deps.stateManager),
      new TaskStopTool(deps.stateManager),
      new TaskUpdateTool(deps.stateManager),
      new UpdateGoalTool(deps.stateManager),
      new ArchiveGoalTool(deps.stateManager),
      new DeleteGoalTool(deps.stateManager),
      new SoilRebuildTool(deps.stateManager),
    );
  }

  tools.push(new TogglePluginTool(), new UpdateConfigTool(), new ConfigureNotificationRoutingTool());

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
    tools.push(new MemorySaveTool(deps.knowledgeManager));
    const llmCall = deps.llmCall ?? ((_: string) => Promise.reject(new Error("LLM not configured")));
    tools.push(new MemoryConsolidateTool(deps.knowledgeManager, llmCall));
    tools.push(new MemoryLintTool(deps.knowledgeManager, llmCall));
  }
  if (deps?.observationEngine) {
    tools.push(new QueryDataSourceTool(deps.observationEngine));
    tools.push(new ObserveGoalTool(deps.observationEngine));
  }

  if (deps?.scheduleEngine) {
    tools.push(
      new ListSchedulesTool(deps.scheduleEngine),
      new GetScheduleTool(deps.scheduleEngine),
      new CreateScheduleTool(deps.scheduleEngine),
      new UpdateScheduleTool(deps.scheduleEngine),
      new RemoveScheduleTool(deps.scheduleEngine),
      new PauseScheduleTool(deps.scheduleEngine),
      new ResumeScheduleTool(deps.scheduleEngine),
      new RunScheduleTool(deps.scheduleEngine),
    );
  }

  const interactiveAutomationConfig = loadGlobalConfigSync().interactive_automation;
  const shouldRegisterInteractiveAutomation =
    deps?.interactiveAutomationRegistry !== undefined || interactiveAutomationConfig.enabled;
  const interactiveAutomationRegistry = shouldRegisterInteractiveAutomation
    ? deps?.interactiveAutomationRegistry
      ?? createDefaultInteractiveAutomationRegistry({
        codexAppBridge: deps?.codexAppComputerUseBridge,
        defaultProviders: {
          desktop: interactiveAutomationConfig.default_desktop_provider,
          browser: interactiveAutomationConfig.default_browser_provider,
          research: interactiveAutomationConfig.default_research_provider,
        },
      })
    : undefined;
  const interactiveAutomationPolicy = deps?.interactiveAutomationPolicy ?? {
    requireApproval: interactiveAutomationConfig.require_approval,
    allowedApps: interactiveAutomationConfig.allowed_apps,
    deniedApps: interactiveAutomationConfig.denied_apps,
  };
  if (interactiveAutomationRegistry) {
    tools.push(
      new BrowserGetStateTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new BrowserRunWorkflowTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopClickTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopGetAppStateTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopListAppsTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new DesktopTypeTextTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new ResearchAnswerWithSourcesTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
      new ResearchWebTool(interactiveAutomationRegistry, interactiveAutomationPolicy),
    );
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
