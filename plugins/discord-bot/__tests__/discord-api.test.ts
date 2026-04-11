import { describe, expect, it, vi } from "vitest";
import { DiscordAPI } from "../src/discord-api.js";

describe("DiscordAPI", () => {
  it("sends channel messages with the bot token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const api = new DiscordAPI("bot-token", fetchMock as typeof fetch);

    await api.sendChannelMessage("channel-1", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/channels/channel-1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bot bot-token");
  });
});
