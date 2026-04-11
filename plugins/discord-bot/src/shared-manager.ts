export interface ChatContinuationInput {
  platform: "discord";
  identity_key: string;
  conversation_id: string;
  sender_id: string;
  message_id?: string;
  text: string;
  metadata: Record<string, unknown>;
}

type SessionManagerMethod = (input: ChatContinuationInput) => Promise<unknown> | unknown;
type SessionManagerProvider = () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

interface PulseedRuntimeGlobal {
  __pulseedGetGlobalCrossPlatformChatSessionManager?: SessionManagerProvider;
}

export async function getGlobalCrossPlatformChatSessionManager(): Promise<Record<string, unknown> | null> {
  const getter = (globalThis as typeof globalThis & PulseedRuntimeGlobal)
    .__pulseedGetGlobalCrossPlatformChatSessionManager;
  if (typeof getter !== "function") {
    return null;
  }

  try {
    return await getter();
  } catch {
    return null;
  }
}

export async function dispatchChatInput(input: ChatContinuationInput): Promise<string | null> {
  const manager = await getGlobalCrossPlatformChatSessionManager();
  if (manager === null) {
    return null;
  }

  const methodNames = [
    "processIncomingMessage",
    "handleIncomingMessage",
    "continueConversation",
    "resumeConversation",
    "routeIncomingMessage",
    "processMessage",
    "handleMessage",
  ] as const;

  for (const methodName of methodNames) {
    const method = manager[methodName];
    if (typeof method !== "function") {
      continue;
    }

    const result = await (method as SessionManagerMethod).call(manager, input);
    return normalizeManagerResult(result);
  }

  return null;
}

function normalizeManagerResult(result: unknown): string | null {
  if (typeof result === "string" && result.trim().length > 0) {
    return result;
  }
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const text = record["text"];
    if (typeof text === "string" && text.trim().length > 0) {
      return text;
    }
    const message = record["message"];
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return null;
}
