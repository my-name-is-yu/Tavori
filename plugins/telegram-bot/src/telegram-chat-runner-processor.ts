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
  type ChatEventHandler,
  type IAdapter,
  type ILLMClient,
  type ChatRunnerLike,
  type ChatAgentLoopRunner,
  type ProviderConfig,
  createNativeChatAgentLoopRunner,
  shouldUseNativeTaskAgentLoop,
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
  private bootstrapPromise: Promise<BootstrapResult> | null = null;
  private readonly sessions = new Map<number, ChatRunnerLike>();

  constructor(
    _pluginDir: string,
    workspaceRoot = process.cwd(),
    identityKey?: string,
    runtimeControlAllowedUserIds: number[] = []
  ) {
    this.workspaceRoot = workspaceRoot;
    this.identityKey = identityKey;
    this.runtimeControlAllowedUserIds = new Set(runtimeControlAllowedUserIds);
  }

  async processMessage(
    text: string,
    chatId: number,
    emit: ChatEventHandler,
    fromUserId?: number
  ): Promise<string> {
    const shared = await this.getSharedManager();
    if (shared !== null) {
      return shared.processIncomingMessage({
        text,
        platform: "telegram",
        identity_key: this.identityKey,
        conversation_id: String(chatId),
        sender_id: String(chatId),
        cwd: this.workspaceRoot,
        onEvent: emit,
        metadata: {
          chat_id: chatId,
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
    for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry })) {
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

export type { ProcessMessageFn };
