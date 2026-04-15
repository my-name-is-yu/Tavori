import { describe, expect, it, vi } from "vitest";
import { attachMouseTracking } from "../flicker/MouseTracking.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "../flicker/dec.js";

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

describe("mouse tracking", () => {
  it("enables mouse tracking on attach and disables it on cleanup", () => {
    const stream = createMockStream();

    const cleanup = attachMouseTracking(stream);

    expect(stream.write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING);
    expect(stream._written).toContain(ENABLE_MOUSE_TRACKING);

    cleanup();

    expect(stream._written.at(-1)).toBe(DISABLE_MOUSE_TRACKING);
  });
});
