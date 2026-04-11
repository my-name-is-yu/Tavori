import { randomUUID } from "node:crypto";
import { ChatRunner } from "./chat-runner.js";
import type { ChatRunResult, ChatRunnerDeps } from "./chat-runner.js";
import type { ChatEvent, ChatEventHandler } from "./chat-events.js";
import { StateManager } from "../../base/state/state-manager.js";
import { buildAdapterRegistry, buildLLMClient } from "../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TrustManager } from "../../platform/traits/trust-manager.js";
import {
  ConcurrencyController,
  createBuiltinTools,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
} from "../../tools/index.js";

export interface CrossPlatformChatSessionOptions {
  /**
   * Stable cross-platform join key.
   * When present, sessions with the same identity_key share one ChatRunner session.
   */
  identity_key?: string;
  /** Platform or transport name, e.g. "slack", "discord", "web". */
  platform?: string;
  /** Conversation/thread identifier on the transport. */
  conversation_id?: string;
  /** Human-readable conversation title or thread name. */
  conversation_name?: string;
  /** User identifier on the transport. */
  user_id?: string;
  /** Human-readable user name. */
  user_name?: string;
  /** Workspace root or working directory used when the session is created. */
  cwd?: string;
  /** Per-turn timeout forwarded to ChatRunner. */
  timeoutMs?: number;
  /** Extra transport metadata for plugins to retain alongside the session. */
  metadata?: Record<string, unknown>;
  /** Optional streaming callback for ChatEvent updates. */
  onEvent?: ChatEventHandler;
}

export interface CrossPlatformIncomingChatMessage {
  text: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  sender_id?: string;
  user_id?: string;
  user_name?: string;
  message_id?: string;
  cwd?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  onEvent?: ChatEventHandler;
}

export interface CrossPlatformChatSessionInfo {
  session_key: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  cwd: string;
  created_at: string;
  last_used_at: string;
  metadata: Record<string, unknown>;
}

interface ManagedChatSession {
  runner: ChatRunner;
  info: CrossPlatformChatSessionInfo;
  queue: Promise<void>;
}

function normalizeIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePlatform(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function buildSessionKey(options: CrossPlatformChatSessionOptions): string {
  const identityKey = normalizeIdentity(options.identity_key);
  if (identityKey) {
    return `identity:${identityKey}`;
  }

  const platform = normalizePlatform(options.platform);
  const conversationId = normalizeIdentity(options.conversation_id);
  if (platform && conversationId) {
    return `platform:${platform}:conversation:${conversationId}`;
  }

  const userId = normalizeIdentity(options.user_id);
  if (platform && userId) {
    return `platform:${platform}:user:${userId}`;
  }

  return `ephemeral:${randomUUID()}`;
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return metadata ? { ...metadata } : {};
}

function buildSessionMetadata(options: CrossPlatformChatSessionOptions): Record<string, unknown> {
  return {
    ...(options.metadata ?? {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.conversation_id ? { conversation_id: options.conversation_id } : {}),
    ...(options.conversation_name ? { conversation_name: options.conversation_name } : {}),
    ...(options.user_id ? { user_id: options.user_id } : {}),
    ...(options.user_name ? { user_name: options.user_name } : {}),
  };
}

function safeInvoke(handler: ChatEventHandler | undefined, event: ChatEvent): void {
  if (!handler) return;
  try {
    const result = handler(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Event streaming should not break chat delivery.
  }
}

export class CrossPlatformChatSessionManager {
  private readonly sessions = new Map<string, ManagedChatSession>();

  constructor(private readonly deps: ChatRunnerDeps) {}

  /**
   * Execute a chat turn through a session keyed by identity_key.
   * If identity_key is absent, the manager falls back to a deterministic platform-scoped key when possible,
   * otherwise it creates an isolated one-shot session.
   */
  async execute(input: string, options: CrossPlatformChatSessionOptions = {}): Promise<ChatRunResult> {
    const session = this.getOrCreateSession(options);
    const queueEntry = session.queue.then(() => this.executeInSession(session, input, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  async processIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    const result = await this.execute(input.text, {
      identity_key: input.identity_key,
      platform: input.platform,
      conversation_id: input.conversation_id,
      conversation_name: input.conversation_name,
      user_id: input.user_id ?? input.sender_id,
      user_name: input.user_name,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.sender_id ? { sender_id: input.sender_id } : {}),
        ...(input.message_id ? { message_id: input.message_id } : {}),
      },
      onEvent: input.onEvent,
    });
    return result.output;
  }

  handleIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  continueConversation(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  processMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  /**
   * Returns the active session info if a matching session is already loaded.
   */
  getSessionInfo(options: CrossPlatformChatSessionOptions): CrossPlatformChatSessionInfo | null {
    const sessionKey = buildSessionKey(options);
    const session = this.sessions.get(sessionKey);
    return session ? { ...session.info, metadata: cloneMetadata(session.info.metadata) } : null;
  }

  private getOrCreateSession(options: CrossPlatformChatSessionOptions): ManagedChatSession {
    const sessionKey = buildSessionKey(options);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const cwd = options.cwd?.trim() || process.cwd();
    const runner = new ChatRunner(this.deps);
    runner.startSession(cwd);

    const now = new Date().toISOString();
    const info: CrossPlatformChatSessionInfo = {
      session_key: sessionKey,
      identity_key: normalizeIdentity(options.identity_key) ?? undefined,
      platform: options.platform?.trim() || undefined,
      conversation_id: options.conversation_id?.trim() || undefined,
      conversation_name: options.conversation_name?.trim() || undefined,
      user_id: options.user_id?.trim() || undefined,
      user_name: options.user_name?.trim() || undefined,
      cwd,
      created_at: now,
      last_used_at: now,
      metadata: cloneMetadata(buildSessionMetadata(options)),
    };

    const created: ManagedChatSession = {
      runner,
      info,
      queue: Promise.resolve(),
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private async executeInSession(
    session: ManagedChatSession,
    input: string,
    options: CrossPlatformChatSessionOptions
  ): Promise<ChatRunResult> {
    session.info.last_used_at = new Date().toISOString();
    session.info.metadata = cloneMetadata(buildSessionMetadata(options));

    const previousOnEvent = session.runner.onEvent;
    if (options.onEvent) {
      const handler = options.onEvent;
      const upstream = this.deps.onEvent;
      session.runner.onEvent = (event: ChatEvent) => {
        safeInvoke(handler, event);
        if (upstream && upstream !== handler) {
          safeInvoke(upstream, event);
        }
      };
    } else {
      session.runner.onEvent = undefined;
    }

    try {
      return await session.runner.execute(input, session.info.cwd, options.timeoutMs);
    } finally {
      session.runner.onEvent = previousOnEvent;
    }
  }
}

let globalManagerPromise: Promise<CrossPlatformChatSessionManager> | null = null;

export function getGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  if (globalManagerPromise === null) {
    globalManagerPromise = createGlobalCrossPlatformChatSessionManager().catch((err) => {
      globalManagerPromise = null;
      throw err;
    });
  }
  return globalManagerPromise;
}

async function createGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  const providerConfig = await loadProviderConfig();
  const stateManager = new StateManager();
  await stateManager.init();

  const llmClient = await buildLLMClient();
  const adapterRegistry = await buildAdapterRegistry(llmClient, providerConfig);
  const adapter = adapterRegistry.getAdapter(providerConfig.adapter);
  const toolRegistry = new ToolRegistry();
  const trustManager = new TrustManager(stateManager);
  for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry })) {
    toolRegistry.register(tool);
  }

  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager: new ToolPermissionManager({ trustManager }),
    concurrency: new ConcurrencyController(),
  });

  return new CrossPlatformChatSessionManager({
    stateManager,
    adapter,
    llmClient,
    registry: toolRegistry,
    toolExecutor,
  });
}
