import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignalBridgeClient } from "../src/signal-client.js";
import { SignalBridgePoller } from "../src/poller.js";

describe("SignalBridgePoller", () => {
  const fetchMock = vi.fn();
  const client = new SignalBridgeClient("http://127.0.0.1:7583", "+15551234567", fetchMock as typeof fetch);

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("passes identity_key to the shared manager and replies", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: "msg-1",
            sender: "+15557654321",
            message: "hello",
            timestamp: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const replyHandler = vi.fn().mockResolvedValue("reply text");
    const poller = new SignalBridgePoller(
      {
        bridge_url: "http://127.0.0.1:7583",
        account: "+15551234567",
        recipient_id: "+15557654321",
        identity_key: "signal:alpha",
        poll_interval_ms: 5000,
        receive_timeout_ms: 2000,
      },
      client,
      replyHandler
    );

    await poller.pollOnce();

    expect(replyHandler).toHaveBeenCalledTimes(1);
    expect(replyHandler.mock.calls[0]?.[0]).toMatchObject({
      identity_key: "signal:alpha",
      sender_id: "+15557654321",
      text: "hello",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
