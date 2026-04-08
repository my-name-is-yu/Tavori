import * as path from "node:path";
import {
  ChatRunner,
  StateManager,
  buildAdapterRegistry,
  buildLLMClient,
  loadProviderConfig,
  ToolRegistry,
  createBuiltinTools,
  type ChatEventHandler,
  type IAdapter,
  type ILLMClient,
  type ChatRunnerLike,
  type ProviderConfig,
} from "pulseed";

interface BootstrapResult {
  stateManager: StateManager;
  llmClient: ILLMClient;
  adapter: IAdapter;
  registry: ToolRegistry;
  providerConfig: ProviderConfig;
}

type ProcessMessageFn = (text: string, chatId: number, emit: ChatEventHandler) => Promise<string | void> | string | void;

function formatError(message: string): string {
  return `Error: ${message}`;
}

export class TelegramChatRunnerProcessor {
  private readonly workspaceRoot: string;
  private bootstrapPromise: Promise<BootstrapResult> | null = null;
  private readonly sessions = new Map<number, ChatRunnerLike>();

  constructor(_pluginDir: string, workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  async processMessage(text: string, chatId: number, emit: ChatEventHandler): Promise<string> {
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

  private async getRunner(chatId: number): Promise<ChatRunnerLike> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const bootstrap = await this.bootstrap();
    const runner = new ChatRunner({
      stateManager: bootstrap.stateManager,
      adapter: bootstrap.adapter,
      llmClient: bootstrap.llmClient,
      registry: bootstrap.registry,
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
    for (const tool of createBuiltinTools({ stateManager })) {
      toolRegistry.register(tool);
    }

    return {
      stateManager,
      llmClient,
      adapter,
      registry: toolRegistry,
      providerConfig,
    };
  }
}

export type { ProcessMessageFn };
