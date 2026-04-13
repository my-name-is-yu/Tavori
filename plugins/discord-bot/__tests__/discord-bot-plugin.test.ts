import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatchChatInput = vi.hoisted(() => vi.fn());
const mockServerStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendChannelMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendFollowUp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("pulseed", () => ({
  getGlobalCrossPlatformChatSessionManager: vi.fn().mockResolvedValue({
    processIncomingMessage: mockDispatchChatInput,
  }),
}));

vi.mock("../src/discord-api.js", () => ({
  DiscordAPI: class {
    sendChannelMessage = mockSendChannelMessage;
    sendInteractionFollowUp = mockSendFollowUp;
  },
}));

vi.mock("../src/webhook-server.js", () => ({
  DiscordWebhookServer: class {
    start = mockServerStart;
    stop = vi.fn().mockResolvedValue(undefined);
    constructor(_config: unknown, _api: unknown) {}
  },
}));

import { DiscordBotPlugin } from "../src/index.js";

describe("DiscordBotPlugin", () => {
  beforeEach(() => {
    mockDispatchChatInput.mockReset();
    mockServerStart.mockClear();
    mockSendChannelMessage.mockClear();
    mockSendFollowUp.mockClear();
  });

  it("passes identity_key into the shared manager payload", async () => {
    mockDispatchChatInput.mockResolvedValue("reply text");
    const plugin = new DiscordBotPlugin("/tmp/discord-plugin");

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 204,
    } as Response);

    vi.spyOn(
      await import("../src/config.js"),
      "loadConfig"
    ).mockReturnValue({
      application_id: "app-1",
      bot_token: "bot-1",
      channel_id: "channel-1",
      identity_key: "discord:alpha",
      runtime_control_allowed_sender_ids: [],
      command_name: "pulseed",
      host: "127.0.0.1",
      port: 8787,
      ephemeral: false,
    });

    await plugin.init();

    expect(mockServerStart).toHaveBeenCalledTimes(1);
    await plugin.notify({
      type: "goal_complete",
      goal_id: "goal-1",
      timestamp: "2026-04-11T00:00:00.000Z",
      summary: "Goal reached",
      details: {},
      severity: "info",
    });

    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
  });
});
