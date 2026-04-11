import { describe, expect, it, vi } from "vitest";
import { SignalBridgeClient } from "../src/signal-client.js";

describe("SignalBridgeClient", () => {
  it("posts outbound messages to the bridge", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new SignalBridgeClient("http://127.0.0.1:7583", "+15551234567", fetchMock as typeof fetch);

    await client.sendTextMessage({ recipient: "+15557654321", body: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v2/send");
    const body = JSON.parse(init.body as string) as { number: string; recipients: string[] };
    expect(body.number).toBe("+15551234567");
    expect(body.recipients).toEqual(["+15557654321"]);
  });
});
