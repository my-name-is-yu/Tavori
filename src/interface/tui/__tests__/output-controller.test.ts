import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoFlickerOutputController } from "../output-controller.js";
import { setActiveCursorEscape } from "../cursor-tracker.js";
import { HIDE_CURSOR } from "../flicker/dec.js";

function createMockStream(): NodeJS.WriteStream & { _written: string[] } {
  const written: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    _written: written,
  } as unknown as NodeJS.WriteStream & { _written: string[] };
}

describe("no-flicker output controller", () => {
  afterEach(() => {
    setActiveCursorEscape(null);
    vi.restoreAllMocks();
  });

  it("suppresses foreign stdout writes while preserving trusted terminal writes", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const originalWrite = stdout.write as ReturnType<typeof vi.fn>;
    const controller = createNoFlickerOutputController(stdout, stderr);

    controller.install();

    controller.writeTerminal("trusted");
    expect(originalWrite).toHaveBeenCalledWith("trusted");

    const before = originalWrite.mock.calls.length;
    expect(stdout.write("foreign")).toBe(true);
    expect(originalWrite.mock.calls.length).toBe(before);

    controller.destroy();
  });

  it("renders frames through the trusted stdout stream", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const controller = createNoFlickerOutputController(stdout, stderr);

    controller.renderStdout.write("\u001b[2K\u001b[1Ahello world");

    expect(stdout._written.join("")).toBe(`\u001b[2K\u001b[1Ahello world${HIDE_CURSOR}`);
 
    controller.destroy();
  });

  it("uses the active hidden cursor escape when one is set", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const controller = createNoFlickerOutputController(stdout, stderr);

    setActiveCursorEscape("\u001b[10;4H\u001b[?25l");
    controller.renderStdout.write("frame");

    expect(stdout._written.join("")).toBe("frame\u001b[10;4H\u001b[?25l");
 
    controller.destroy();
  });

  it("forwards Ink stderr output without suppression", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const controller = createNoFlickerOutputController(stdout, stderr);

    controller.renderStderr.write("render error");

    expect(stderr._written.join("")).toBe("render error");

    controller.destroy();
  });
});
