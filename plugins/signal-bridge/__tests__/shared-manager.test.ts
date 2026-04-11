import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchChatInput } from "../src/shared-manager.js";

interface PulseedRuntimeGlobal {
  __pulseedGetGlobalCrossPlatformChatSessionManager?: () => Promise<Record<string, unknown> | null>;
}

describe("signal-bridge shared manager bridge", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & PulseedRuntimeGlobal)
      .__pulseedGetGlobalCrossPlatformChatSessionManager;
  });

  it("dispatches through the PulSeed runtime manager injected by PluginLoader", async () => {
    const processIncomingMessage = vi.fn().mockResolvedValue("signal reply");
    (globalThis as typeof globalThis & PulseedRuntimeGlobal)
      .__pulseedGetGlobalCrossPlatformChatSessionManager = vi.fn().mockResolvedValue({
        processIncomingMessage,
      });

    const input = {
      platform: "signal" as const,
      identity_key: "person-a",
      conversation_id: "+15551234567",
      sender_id: "+15551234567",
      text: "hello",
      metadata: {},
    };

    await expect(dispatchChatInput(input)).resolves.toBe("signal reply");
    expect(processIncomingMessage).toHaveBeenCalledWith(input);
  });
});
