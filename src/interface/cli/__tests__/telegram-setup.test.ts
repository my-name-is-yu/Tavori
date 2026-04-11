import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const readlineState = vi.hoisted(() => ({
  answers: [] as string[],
  close: vi.fn(),
}));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_question: string, callback: (answer: string) => void) => {
      callback(readlineState.answers.shift() ?? "");
    }),
    close: readlineState.close,
  })),
}));

describe("cmdTelegramSetup", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-telegram-setup-test-"));
    process.env["PULSEED_HOME"] = tmpDir;
    fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: { id: 42, first_name: "PulSeed", username: "pulseed_bot" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    readlineState.close.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env["PULSEED_HOME"];
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes optional identity_key for cross-platform continuation", async () => {
    readlineState.answers = ["test-token", "123456", "777,888", "personal"];
    const { cmdTelegramSetup } = await import("../commands/telegram.js");

    const result = await cmdTelegramSetup([]);

    expect(result).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottest-token/getMe");
    expect(readlineState.close).toHaveBeenCalledTimes(1);

    const configPath = path.join(tmpDir, "plugins", "telegram-bot", "config.json");
    const config = JSON.parse(await fsp.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      bot_token: "test-token",
      chat_id: 123456,
      allowed_user_ids: [777, 888],
      polling_timeout: 30,
      identity_key: "personal",
    });
  });
});
