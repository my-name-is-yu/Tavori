import * as path from "node:path";
import {
  ChatRunner,
  StateManager,
  buildAdapterRegistry,
  buildLLMClient,
  loadProviderConfig,
  ToolRegistry,
  ToolExecutor,
  ToolPermissionManager,
  ConcurrencyController,
  createBuiltinTools,
  getGlobalCrossPlatformChatSessionManager,
  buildCliDataSourceRegistry,
  ObservationEngine,
  KnowledgeManager,
  GoalDependencyGraph,
  SessionManager,
  ScheduleEngine,
  PluginLoader,
  NotifierRegistry,
  type ChatEventHandler,
  type IAdapter,
  type ILLMClient,
  type ChatRunnerLike,
  type ChatAgentLoopRunner,
  type ProviderConfig,
  createNativeChatAgentLoopRunner,
  shouldUseNativeTaskAgentLoop,
  resolveChannelRoute,
} from "pulseed";
import { TrustManager } from "pulseed";

interface BootstrapResult {
  stateManager: StateManager;
  llmClient: ILLMClient;
  adapter: IAdapter;
  registry: ToolRegistry;
  toolExecutor: ToolExecutor;
  providerConfig: ProviderConfig;
  chatAgentLoopRunner?: ChatAgentLoopRunner;
}

export type ProcessMessageFn = (
  text: string,
  chatId: number,
  emit: ChatEventHandler,
  fromUserId?: number
) => Promise<string | void> | string | void;

function formatError(message: string): string {
  return `Error: ${message}`;
}

export class TelegramChatRunnerProcessor {
  private readonly workspaceRoot: string;
  private readonly identityKey: string | undefined;
  private readonly runtimeControlAllowedUserIds: Set<number>;
  private readonly chatGoalMap: Record<string, string>;
  private readonly userGoalMap: Record<string, string>;
  private readonly defaultGoalId: string | undefined;
  private bootstrapPromise: Promise<BootstrapResult> | null = null;
  private readonly sessions = new Map<number, ChatRunnerLike>();

  constructor(
    _pluginDir: string,
    workspaceRoot = process.cwd(),
    identityKey?: string,
    runtimeControlAllowedUserIds: number[] = [],
    chatGoalMap: Record<string, string> = {},
    userGoalMap: Record<string, string> = {},
    defaultGoalId?: string
  ) {
    this.workspaceRoot = workspaceRoot;
    this.identityKey = identityKey;
    this.runtimeControlAllowedUserIds = new Set(runtimeControlAllowedUserIds);
    this.chatGoalMap = chatGoalMap;
    this.userGoalMap = userGoalMap;
    this.defaultGoalId = defaultGoalId;
  }

  async processMessage(
    text: string,
    chatId: number,
    emit: ChatEventHandler,
    fromUserId?: number
  ): Promise<string> {
    const shared = await this.getSharedManager();
    if (shared !== null) {
      const senderId = String(fromUserId ?? chatId);
      const route = resolveChannelRoute(
        {
          identityKey: this.identityKey,
          conversationGoalMap: this.chatGoalMap,
          senderGoalMap: this.userGoalMap,
          defaultGoalId: this.defaultGoalId,
        },
        {
          platform: "telegram",
          senderId,
          conversationId: String(chatId),
          channelId: String(chatId),
        }
      );
      return shared.processIncomingMessage({
        text,
        platform: "telegram",
        identity_key: route.identityKey ?? this.identityKey,
        conversation_id: String(chatId),
        sender_id: senderId,
        cwd: this.workspaceRoot,
        onEvent: emit,
        metadata: {
          ...route.metadata,
          chat_id: chatId,
          ...(route.goalId ? { goal_id: route.goalId } : {}),
          ...(fromUserId !== undefined && this.runtimeControlAllowedUserIds.has(fromUserId)
            ? { runtime_control_approved: true }
            : {}),
        },
      });
    }

    try {
      const runner = await this.getRunner(chatId);
      runner.onEvent = emit;
      const result = await runner.execute(text, this.workspaceRoot);
      return result.output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[telegram-bot] chat runner unavailable for chat ${chatId}: ${message}`);
      return formatError(message);
    }
  }

  private async getSharedManager(): Promise<{
    processIncomingMessage(input: {
      text: string;
      platform: string;
      identity_key?: string;
      conversation_id: string;
      sender_id: string;
      cwd: string;
      onEvent: ChatEventHandler;
      metadata: Record<string, unknown>;
    }): Promise<string>;
  } | null> {
    try {
      const manager = await getGlobalCrossPlatformChatSessionManager();
      return typeof manager.processIncomingMessage === "function" ? manager : null;
    } catch {
      return null;
    }
  }

  private async getRunner(chatId: number): Promise<ChatRunnerLike> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const bootstrap = await this.bootstrap();
    const runner = new ChatRunner({
      stateManager: bootstrap.stateManager,
      adapter: bootstrap.adapter,
      llmClient: bootstrap.llmClient,
      registry: bootstrap.registry,
      toolExecutor: bootstrap.toolExecutor,
      chatAgentLoopRunner: bootstrap.chatAgentLoopRunner,
    });
    runner.startSession(this.workspaceRoot);
    this.sessions.set(chatId, runner);
    return runner;
  }

  private async bootstrap(): Promise<BootstrapResult> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.createBootstrap().catch((err) => {
        this.bootstrapPromise = null;
        throw err;
      });
    }
    return this.bootstrapPromise;
  }

  private async createBootstrap(): Promise<BootstrapResult> {
    const providerConfig = await loadProviderConfig();
    const stateManager = new StateManager();
    await stateManager.init();

    const llmClient = await buildLLMClient();
    const registry = await buildAdapterRegistry(llmClient, providerConfig);
    const adapter = registry.getAdapter(providerConfig.adapter);
    const toolRegistry = new ToolRegistry();
    const trustManager = new TrustManager(stateManager);
    const dataSourceRegistry = await buildCliDataSourceRegistry(this.workspaceRoot);
    const observationEngine = new ObservationEngine(stateManager, dataSourceRegistry.getAllSources(), llmClient);
    const knowledgeManager = new KnowledgeManager(stateManager, llmClient);
    const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);
    await goalDependencyGraph.init();
    const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
    const scheduleEngine = new ScheduleEngine({
      baseDir: stateManager.getBaseDir(),
      dataSourceRegistry,
      llmClient,
      stateManager,
      knowledgeManager,
    });
    await scheduleEngine.loadEntries();
    const pluginLoader = new PluginLoader(
      registry,
      dataSourceRegistry,
      new NotifierRegistry(),
      undefined,
      undefined,
      (dataSource) => {
        if (!observationEngine.getDataSources().some((source) => source.sourceId === dataSource.sourceId)) {
          observationEngine.addDataSource(dataSource);
        }
      }
    );
    await pluginLoader.loadAll().catch(() => []);
    await scheduleEngine.syncExternalSources(pluginLoader.getScheduleSources()).catch(() => undefined);

    for (const tool of createBuiltinTools({
      stateManager,
      trustManager,
      registry: toolRegistry,
      adapterRegistry: registry,
      knowledgeManager,
      observationEngine,
      sessionManager,
      scheduleEngine,
      pluginLoader,
    })) {
      toolRegistry.register(tool);
    }
    const permissionManager = new ToolPermissionManager({
      trustManager,
    });
    const toolExecutor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager,
      concurrency: new ConcurrencyController(),
    });
    const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeChatAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: this.workspaceRoot,
          traceBaseDir: stateManager.getBaseDir(),
        })
      : undefined;

    return {
      stateManager,
      llmClient,
      adapter,
      registry: toolRegistry,
      toolExecutor,
      providerConfig,
      chatAgentLoopRunner,
    };
  }
}
