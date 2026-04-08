import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreatedRunners = vi.hoisted(() => [] as Array<{
  startSession: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  onEvent: unknown;
}>);

const mockInit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockLoadProviderConfig = vi.hoisted(() => vi.fn().mockResolvedValue({ adapter: "openai_api" }));
const mockBuildLLMClient = vi.hoisted(() => vi.fn().mockResolvedValue({ supportsToolCalling: vi.fn().mockReturnValue(true) }));
const mockBuildAdapterRegistry = vi.hoisted(() => vi.fn().mockResolvedValue({
  getAdapter: vi.fn().mockReturnValue({ adapterType: "openai_api" }),
}));
const mockCreateBuiltinTools = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock("pulseed", () => {
  class FakeStateManager {
    init = mockInit;
  }

  class FakeChatRunner {
    onEvent: unknown;
    startSession = vi.fn();
    execute = vi.fn().mockResolvedValue({
      success: true,
      output: "runner-output",
      elapsed_ms: 1,
    });

    constructor(_deps: unknown) {
      mockCreatedRunners.push(this);
    }
  }

  return {
    StateManager: FakeStateManager,
    ChatRunner: FakeChatRunner,
    buildLLMClient: mockBuildLLMClient,
    buildAdapterRegistry: mockBuildAdapterRegistry,
    loadProviderConfig: mockLoadProviderConfig,
    ToolRegistry: class {
      register = vi.fn();
    },
    createBuiltinTools: mockCreateBuiltinTools,
  };
});

import { TelegramChatRunnerProcessor } from "../src/telegram-chat-runner-processor.js";

describe("TelegramChatRunnerProcessor", () => {
  beforeEach(() => {
    mockCreatedRunners.splice(0, mockCreatedRunners.length);
    mockInit.mockClear();
    mockLoadProviderConfig.mockClear();
    mockBuildLLMClient.mockClear();
    mockBuildAdapterRegistry.mockClear();
    mockCreateBuiltinTools.mockClear();
  });

  it("reuses one ChatRunner per chatId", async () => {
    const processor = new TelegramChatRunnerProcessor("/tmp/plugins/telegram-bot");
    const emit = vi.fn();

    await expect(processor.processMessage("first", 101, emit)).resolves.toBe("runner-output");
    await expect(processor.processMessage("second", 101, emit)).resolves.toBe("runner-output");
    await expect(processor.processMessage("other", 202, emit)).resolves.toBe("runner-output");

    expect(mockCreatedRunners).toHaveLength(2);
    expect(mockCreatedRunners[0]!.startSession).toHaveBeenCalledTimes(1);
    expect(mockCreatedRunners[1]!.startSession).toHaveBeenCalledTimes(1);
    expect(mockCreatedRunners[0]!.execute).toHaveBeenCalledTimes(2);
    expect(mockCreatedRunners[1]!.execute).toHaveBeenCalledTimes(1);
  });

  it("defaults the runner workspace to process.cwd()", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace");
    const processor = new TelegramChatRunnerProcessor("/tmp/plugins/telegram-bot");

    await expect(processor.processMessage("first", 101, vi.fn())).resolves.toBe("runner-output");

    expect(mockCreatedRunners[0]!.startSession).toHaveBeenCalledWith("/workspace");
    expect(mockCreatedRunners[0]!.execute).toHaveBeenCalledWith("first", "/workspace");
    cwdSpy.mockRestore();
  });

  it("returns a plain error string when bootstrap fails", async () => {
    mockBuildLLMClient.mockRejectedValueOnce(new Error("missing provider config"));
    const processor = new TelegramChatRunnerProcessor("/tmp/plugins/telegram-bot");

    await expect(processor.processMessage("hello", 101, vi.fn())).resolves.toBe("Error: missing provider config");
    expect(mockCreatedRunners).toHaveLength(0);
  });
});
