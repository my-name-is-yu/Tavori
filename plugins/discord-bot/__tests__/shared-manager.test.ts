import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchChatInput } from "../src/shared-manager.js";

interface PulseedRuntimeGlobal {
  __pulseedGetGlobalCrossPlatformChatSessionManager?: () => Promise<Record<string, unknown> | null>;
}

describe("discord-bot shared manager bridge", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & PulseedRuntimeGlobal)
      .__pulseedGetGlobalCrossPlatformChatSessionManager;
  });

  it("dispatches through the PulSeed runtime manager injected by PluginLoader", async () => {
    const processIncomingMessage = vi.fn().mockResolvedValue({ text: "discord reply" });
    (globalThis as typeof globalThis & PulseedRuntimeGlobal)
      .__pulseedGetGlobalCrossPlatformChatSessionManager = vi.fn().mockResolvedValue({
        processIncomingMessage,
      });

    const input = {
      platform: "discord" as const,
      identity_key: "person-a",
      conversation_id: "channel-1",
      sender_id: "user-1",
      text: "hello",
      metadata: {},
    };

    await expect(dispatchChatInput(input)).resolves.toBe("discord reply");
    expect(processIncomingMessage).toHaveBeenCalledWith(input);
  });
});
