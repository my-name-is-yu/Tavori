import { describe, expect, it, vi } from "vitest";
import { WhatsAppCloudClient } from "../src/whatsapp-client.js";

describe("WhatsAppCloudClient", () => {
  it("posts text messages to the Cloud API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new WhatsAppCloudClient("phone-1", "token-1", fetchMock as typeof fetch);

    await client.sendTextMessage({ to: "15551234567", body: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/phone-1/messages");
    const body = JSON.parse(init.body as string) as { messaging_product: string; to: string };
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.to).toBe("15551234567");
  });
});
