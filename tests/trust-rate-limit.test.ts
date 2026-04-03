import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateManager } from "../src/state/state-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { TRUST_SUCCESS_DELTA } from "../src/types/trust.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

describe("TrustManager — rate limit (§3.1)", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: TrustManager;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-trust-rate-");
    stateManager = new StateManager(tmpDir);
    manager = new TrustManager(stateManager);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupTempDir(tmpDir);
  });

  it("allows up to 3 success calls within 1 hour and applies delta each time", async () => {
    const domain = "test-domain";

    const r1 = await manager.recordSuccess(domain);
    expect(r1.balance).toBe(TRUST_SUCCESS_DELTA); // +3

    const r2 = await manager.recordSuccess(domain);
    expect(r2.balance).toBe(TRUST_SUCCESS_DELTA * 2); // +6

    const r3 = await manager.recordSuccess(domain);
    expect(r3.balance).toBe(TRUST_SUCCESS_DELTA * 3); // +9
  });

  it("skips the 4th success call within 1 hour (rate limit triggered)", async () => {
    const domain = "rate-limited-domain";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.recordSuccess(domain); // call 1 → +3
    await manager.recordSuccess(domain); // call 2 → +6
    await manager.recordSuccess(domain); // call 3 → +9

    const r4 = await manager.recordSuccess(domain); // call 4 → rate limited, no delta
    expect(r4.balance).toBe(TRUST_SUCCESS_DELTA * 3); // still +9

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("trust rate limit triggered")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`domain: ${domain}`)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("window: 1h")
    );

    warnSpy.mockRestore();
  });

  it("rate limit is domain-specific — different domains are tracked independently", async () => {
    const domainA = "domain-a";
    const domainB = "domain-b";

    // Fill up domain-a
    await manager.recordSuccess(domainA);
    await manager.recordSuccess(domainA);
    await manager.recordSuccess(domainA);

    // domain-b should not be affected
    const r = await manager.recordSuccess(domainB);
    expect(r.balance).toBe(TRUST_SUCCESS_DELTA); // +3
  });

  it("allows new success calls after the 1-hour window expires", async () => {
    const domain = "expiry-domain";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Use up the 3-call budget
    await manager.recordSuccess(domain); // t=0
    await manager.recordSuccess(domain); // t=0
    await manager.recordSuccess(domain); // t=0

    // 4th call is rate limited
    const r4 = await manager.recordSuccess(domain);
    expect(r4.balance).toBe(TRUST_SUCCESS_DELTA * 3);

    // Advance time by just over 1 hour
    vi.advanceTimersByTime(3_600_001);

    // Now a new call should succeed (old timestamps are outside the window)
    // Need a fresh manager to reset the in-memory timestamp cache
    const manager2 = new TrustManager(stateManager);
    vi.useRealTimers(); // real timers needed for Date.now() to advance
    // Re-enable fake timers after advancing time
    vi.useFakeTimers({ now: Date.now() + 3_600_001 });

    const manager3 = new TrustManager(stateManager);
    const r5 = await manager3.recordSuccess(domain);
    // Balance should have increased (no longer rate limited)
    expect(r5.balance).toBe(TRUST_SUCCESS_DELTA * 4); // +12

    warnSpy.mockRestore();
  });

  it("does NOT rate limit recordFailure — failure penalty always applies", async () => {
    const domain = "failure-domain";

    // Fill up the success rate limit
    await manager.recordSuccess(domain);
    await manager.recordSuccess(domain);
    await manager.recordSuccess(domain);

    // recordFailure should still apply delta (-10) even after 3 successes
    const rf = await manager.recordFailure(domain);
    // 9 (from 3 successes) - 10 = -1
    expect(rf.balance).toBe(TRUST_SUCCESS_DELTA * 3 + (-10));
  });

  it("logs warn message with count when rate limited", async () => {
    const domain = "log-domain";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.recordSuccess(domain);
    await manager.recordSuccess(domain);
    await manager.recordSuccess(domain);
    await manager.recordSuccess(domain); // triggers rate limit, count=3

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("count: 3")
    );

    warnSpy.mockRestore();
  });
});
