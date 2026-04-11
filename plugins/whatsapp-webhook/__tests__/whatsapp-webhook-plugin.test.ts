import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatchChatInput = vi.hoisted(() => vi.fn());
const mockServerStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendTextMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("pulseed", () => ({
  getGlobalCrossPlatformChatSessionManager: vi.fn().mockResolvedValue({
    processIncomingMessage: mockDispatchChatInput,
  }),
}));

vi.mock("../src/whatsapp-client.js", () => ({
  WhatsAppCloudClient: class {
    sendTextMessage = mockSendTextMessage;
  },
}));

vi.mock("../src/webhook-server.js", () => ({
  WhatsAppWebhookServer: class {
    start = mockServerStart;
    stop = vi.fn().mockResolvedValue(undefined);
    constructor(_config: unknown, _client: unknown) {}
  },
}));

import { WhatsAppWebhookPlugin } from "../src/index.js";

describe("WhatsAppWebhookPlugin", () => {
  beforeEach(() => {
    mockDispatchChatInput.mockReset();
    mockServerStart.mockClear();
    mockSendTextMessage.mockClear();
  });

  it("sends notifications through the Cloud API client", async () => {
    vi.spyOn(await import("../src/config.js"), "loadConfig").mockReturnValue({
      phone_number_id: "phone-1",
      access_token: "token-1",
      verify_token: "verify-1",
      recipient_id: "15551234567",
      identity_key: "whatsapp:alpha",
      host: "127.0.0.1",
      port: 8788,
      path: "/webhook",
      app_secret: undefined,
    });

    const plugin = new WhatsAppWebhookPlugin("/tmp/whatsapp-plugin");
    await plugin.init();
    await plugin.notify({
      type: "goal_complete",
      goal_id: "goal-1",
      timestamp: "2026-04-11T00:00:00.000Z",
      summary: "Goal reached",
      details: {},
      severity: "info",
    });

    expect(mockServerStart).toHaveBeenCalledTimes(1);
    expect(mockSendTextMessage).toHaveBeenCalledTimes(1);
  });
});
