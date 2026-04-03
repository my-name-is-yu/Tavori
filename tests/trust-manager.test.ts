import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state/state-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import {
  HIGH_TRUST_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  TRUST_SUCCESS_DELTA,
  TRUST_FAILURE_DELTA,
} from "../src/types/trust.js";
import { PluginManifestSchema, PluginStateSchema } from "../src/types/plugin.js";
import type { PluginState, PluginMatchResult } from "../src/types/plugin.js";
import type { PluginLoader } from "../src/runtime/plugin-loader.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("TrustManager", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: TrustManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    manager = new TrustManager(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── getBalance ───

  describe("getBalance", () => {
    it("returns default balance (score=0) for unknown domain", async () => {
      const balance = await manager.getBalance("unknown-domain");
      expect(balance.domain).toBe("unknown-domain");
      expect(balance.balance).toBe(0);
      expect(balance.success_delta).toBe(TRUST_SUCCESS_DELTA);
      expect(balance.failure_delta).toBe(TRUST_FAILURE_DELTA);
    });

    it("returns persisted balance for known domain", async () => {
      await manager.recordSuccess("my-domain");
      const balance = await manager.getBalance("my-domain");
      expect(balance.balance).toBe(TRUST_SUCCESS_DELTA);
    });

    it("does not persist the default balance on access", async () => {
      await manager.getBalance("ghost-domain");
      // A second manager (fresh cache) should still return default
      const manager2 = new TrustManager(stateManager);
      const balance = await manager2.getBalance("ghost-domain");
      expect(balance.balance).toBe(0);
    });
  });

  // ─── recordSuccess ───

  describe("recordSuccess", () => {
    it("increments balance by TRUST_SUCCESS_DELTA (+3)", async () => {
      const result = await manager.recordSuccess("domain-a");
      expect(result.balance).toBe(TRUST_SUCCESS_DELTA); // 0 + 3 = 3
    });

    it("accumulates multiple successes", async () => {
      await manager.recordSuccess("domain-a");
      await manager.recordSuccess("domain-a");
      const balance = await manager.getBalance("domain-a");
      expect(balance.balance).toBe(TRUST_SUCCESS_DELTA * 2); // 6
    });

    it("returns the updated TrustBalance", async () => {
      const result = await manager.recordSuccess("domain-b");
      expect(result.domain).toBe("domain-b");
      expect(result.balance).toBe(TRUST_SUCCESS_DELTA);
    });
  });

  // ─── recordFailure ───

  describe("recordFailure", () => {
    it("decrements balance by TRUST_FAILURE_DELTA (-10)", async () => {
      const result = await manager.recordFailure("domain-a");
      expect(result.balance).toBe(TRUST_FAILURE_DELTA); // 0 + (-10) = -10
    });

    it("accumulates multiple failures", async () => {
      await manager.recordFailure("domain-a");
      await manager.recordFailure("domain-a");
      const balance = await manager.getBalance("domain-a");
      expect(balance.balance).toBe(TRUST_FAILURE_DELTA * 2); // -20
    });

    it("returns the updated TrustBalance", async () => {
      const result = await manager.recordFailure("domain-b");
      expect(result.domain).toBe("domain-b");
      expect(result.balance).toBe(TRUST_FAILURE_DELTA);
    });
  });

  // ─── Clamping ───

  describe("clamping", () => {
    it("clamps balance at +100 on repeated successes", async () => {
      // Use setOverride to bypass rate limit and verify clamping at +100
      // (Rate limit allows only 3 success calls per hour; clamping is verified via override)
      await manager.setOverride("clamped-high", 99, "test setup");
      await manager.recordSuccess("clamped-high"); // 99 + 3 = 102, clamped to 100
      const balance = await manager.getBalance("clamped-high");
      expect(balance.balance).toBe(100);
    });

    it("clamps balance at -100 on repeated failures", async () => {
      // Need to reach below -100: 10 * 10 = 100 > 100
      for (let i = 0; i < 11; i++) {
        await manager.recordFailure("clamped-low");
      }
      const balance = await manager.getBalance("clamped-low");
      expect(balance.balance).toBe(-100);
    });

    it("stays at +100 after additional successes once clamped", async () => {
      // Use setOverride to set balance at 100, then verify a success call keeps it clamped
      // (Rate limit allows only 3 success calls per hour)
      await manager.setOverride("max-domain", 100, "test setup");
      const before = (await manager.getBalance("max-domain")).balance;
      await manager.recordSuccess("max-domain");
      const after = (await manager.getBalance("max-domain")).balance;
      expect(before).toBe(100);
      expect(after).toBe(100);
    });

    it("stays at -100 after additional failures once clamped", async () => {
      for (let i = 0; i < 15; i++) {
        await manager.recordFailure("min-domain");
      }
      const before = (await manager.getBalance("min-domain")).balance;
      await manager.recordFailure("min-domain");
      const after = (await manager.getBalance("min-domain")).balance;
      expect(before).toBe(-100);
      expect(after).toBe(-100);
    });
  });

  // ─── Mixed success/failure sequences ───

  describe("mixed success/failure sequences", () => {
    it("recovers from failures with successes", async () => {
      // Rate limit allows 3 success calls per hour; 4th is skipped
      // So: -10 + 3 + 3 + 3 = -1 (4th success is rate-limited)
      await manager.recordFailure("mixed"); // -10
      await manager.recordSuccess("mixed"); // -7
      await manager.recordSuccess("mixed"); // -4
      await manager.recordSuccess("mixed"); // -1 (3rd success, within limit)
      await manager.recordSuccess("mixed"); // rate-limited, no change → stays -1
      const balance = await manager.getBalance("mixed");
      expect(balance.balance).toBe(-10 + 3 + 3 + 3); // -1
    });

    it("tracks independent domains separately", async () => {
      await manager.recordSuccess("domain-x"); // +3
      await manager.recordFailure("domain-y"); // -10
      expect((await manager.getBalance("domain-x")).balance).toBe(3);
      expect((await manager.getBalance("domain-y")).balance).toBe(-10);
    });
  });

  // ─── getActionQuadrant ───

  describe("getActionQuadrant", () => {
    it("returns 'autonomous' for high trust AND high confidence", async () => {
      // Set trust to HIGH_TRUST_THRESHOLD (20) via overrides
      await manager.setOverride("domain", HIGH_TRUST_THRESHOLD, "test");
      const quadrant = await manager.getActionQuadrant("domain", HIGH_CONFIDENCE_THRESHOLD);
      expect(quadrant).toBe("autonomous");
    });

    it("returns 'autonomous' for trust=20 and confidence=0.50 (boundary)", async () => {
      await manager.setOverride("domain", 20, "test");
      expect(await manager.getActionQuadrant("domain", 0.50)).toBe("autonomous");
    });

    it("returns 'execute_with_confirm' for high trust AND low confidence", async () => {
      await manager.setOverride("domain", HIGH_TRUST_THRESHOLD, "test");
      const confidence = HIGH_CONFIDENCE_THRESHOLD - 0.01; // 0.49
      const quadrant = await manager.getActionQuadrant("domain", confidence);
      expect(quadrant).toBe("execute_with_confirm");
    });

    it("returns 'execute_with_confirm' for low trust AND high confidence", async () => {
      await manager.setOverride("domain", HIGH_TRUST_THRESHOLD - 1, "test"); // 19
      const quadrant = await manager.getActionQuadrant("domain", HIGH_CONFIDENCE_THRESHOLD);
      expect(quadrant).toBe("execute_with_confirm");
    });

    it("returns 'observe_and_propose' for low trust AND low confidence", async () => {
      // Default domain starts at 0 trust
      const confidence = HIGH_CONFIDENCE_THRESHOLD - 0.01; // 0.49
      const quadrant = await manager.getActionQuadrant("new-domain", confidence);
      expect(quadrant).toBe("observe_and_propose");
    });

    it("returns 'observe_and_propose' for negative trust and low confidence", async () => {
      await manager.recordFailure("neg-domain"); // -10
      const quadrant = await manager.getActionQuadrant("neg-domain", 0.10);
      expect(quadrant).toBe("observe_and_propose");
    });

    it("returns 'execute_with_confirm' for trust=19 (just below threshold)", async () => {
      await manager.setOverride("domain", 19, "test");
      const quadrant = await manager.getActionQuadrant("domain", 0.99);
      expect(quadrant).toBe("execute_with_confirm");
    });
  });

  // ─── requiresApproval ───

  describe("requiresApproval", () => {
    it("returns true for irreversible actions regardless of trust/confidence", async () => {
      // Even with max trust and confidence, irreversible requires approval
      await manager.setOverride("trusted", 100, "test");
      expect(await manager.requiresApproval("irreversible", "trusted", 1.0)).toBe(true);
    });

    it("returns true for unknown reversibility regardless of trust/confidence", async () => {
      await manager.setOverride("trusted", 100, "test");
      expect(await manager.requiresApproval("unknown", "trusted", 1.0)).toBe(true);
    });

    it("returns false for reversible action in autonomous quadrant", async () => {
      await manager.setOverride("trusted", 100, "test");
      expect(await manager.requiresApproval("reversible", "trusted", 1.0)).toBe(false);
    });

    it("returns false for reversible action in execute_with_confirm quadrant (high trust, low confidence)", async () => {
      await manager.setOverride("domain", HIGH_TRUST_THRESHOLD, "test");
      const confidence = HIGH_CONFIDENCE_THRESHOLD - 0.01; // 0.49 → execute_with_confirm
      expect(await manager.requiresApproval("reversible", "domain", confidence)).toBe(false);
    });

    it("returns false for reversible action in execute_with_confirm quadrant (low trust, high confidence)", async () => {
      // Default trust = 0 < 20, confidence = 0.99 → execute_with_confirm
      expect(await manager.requiresApproval("reversible", "low-trust-domain", 0.99)).toBe(false);
    });

    it("returns true for reversible action in observe_and_propose quadrant", async () => {
      // Default trust = 0, confidence = 0.10
      expect(await manager.requiresApproval("reversible", "new-domain", 0.10)).toBe(true);
    });
  });

  // ─── setOverride ───

  describe("setOverride", () => {
    it("sets balance to exact value", async () => {
      await manager.setOverride("domain", 50, "manual adjustment");
      expect((await manager.getBalance("domain")).balance).toBe(50);
    });

    it("overrides a balance that was previously modified by successes", async () => {
      await manager.recordSuccess("domain"); // 3
      await manager.setOverride("domain", 75, "admin override");
      expect((await manager.getBalance("domain")).balance).toBe(75);
    });

    it("logs the override in override_log", async () => {
      await manager.recordSuccess("domain"); // balance = 3
      await manager.setOverride("domain", 50, "reason");

      const raw = await stateManager.readRaw("trust/trust-store.json") as {
        override_log: Array<{
          override_type: string;
          domain: string;
          balance_before: number;
          balance_after: number;
        }>;
      };
      const logs = raw.override_log;
      expect(logs).toHaveLength(1);
      expect(logs[0].override_type).toBe("trust_grant");
      expect(logs[0].domain).toBe("domain");
      expect(logs[0].balance_before).toBe(3);
      expect(logs[0].balance_after).toBe(50);
    });

    it("clamps the override value to [-100, +100]", async () => {
      await manager.setOverride("domain", 999, "too high");
      expect((await manager.getBalance("domain")).balance).toBe(100);

      await manager.setOverride("domain", -999, "too low");
      expect((await manager.getBalance("domain")).balance).toBe(-100);
    });

    it("can set override on a domain not previously seen", async () => {
      await manager.setOverride("brand-new", 20, "bootstrapping");
      expect((await manager.getBalance("brand-new")).balance).toBe(20);
    });
  });

  // ─── addPermanentGate / hasPermanentGate ───

  describe("addPermanentGate and hasPermanentGate", () => {
    it("returns false before any gate is added", async () => {
      expect(await manager.hasPermanentGate("domain", "file_delete")).toBe(false);
    });

    it("returns true after a gate is added", async () => {
      await manager.addPermanentGate("domain", "file_delete");
      expect(await manager.hasPermanentGate("domain", "file_delete")).toBe(true);
    });

    it("does not affect other categories on the same domain", async () => {
      await manager.addPermanentGate("domain", "file_delete");
      expect(await manager.hasPermanentGate("domain", "file_write")).toBe(false);
    });

    it("does not affect other domains", async () => {
      await manager.addPermanentGate("domain-a", "file_delete");
      expect(await manager.hasPermanentGate("domain-b", "file_delete")).toBe(false);
    });

    it("allows multiple gates on the same domain", async () => {
      await manager.addPermanentGate("domain", "file_delete");
      await manager.addPermanentGate("domain", "db_drop");
      expect(await manager.hasPermanentGate("domain", "file_delete")).toBe(true);
      expect(await manager.hasPermanentGate("domain", "db_drop")).toBe(true);
    });

    it("is idempotent — adding the same gate twice does not duplicate", async () => {
      await manager.addPermanentGate("domain", "file_delete");
      await manager.addPermanentGate("domain", "file_delete");
      const raw = await stateManager.readRaw("trust/trust-store.json") as {
        permanent_gates: Record<string, string[]>;
      };
      expect(raw.permanent_gates["domain"]).toHaveLength(1);
    });

    it("logs the permanent gate addition in override_log", async () => {
      await manager.addPermanentGate("domain", "file_delete");
      const raw = await stateManager.readRaw("trust/trust-store.json") as {
        override_log: Array<{
          override_type: string;
          domain: string;
          target_category: string | null;
        }>;
      };
      const logs = raw.override_log;
      expect(logs).toHaveLength(1);
      expect(logs[0].override_type).toBe("permanent_gate");
      expect(logs[0].domain).toBe("domain");
      expect(logs[0].target_category).toBe("file_delete");
    });
  });

  // ─── Persistence ───

  describe("persistence", () => {
    it("persists balance after recordSuccess and reloads correctly", async () => {
      await manager.recordSuccess("persist-domain");
      await manager.recordSuccess("persist-domain");

      const manager2 = new TrustManager(stateManager);
      const balance = await manager2.getBalance("persist-domain");
      expect(balance.balance).toBe(TRUST_SUCCESS_DELTA * 2); // 6
    });

    it("persists balance after recordFailure and reloads correctly", async () => {
      await manager.recordFailure("persist-domain");

      const manager2 = new TrustManager(stateManager);
      const balance = await manager2.getBalance("persist-domain");
      expect(balance.balance).toBe(TRUST_FAILURE_DELTA); // -10
    });

    it("persists override and reloads correctly", async () => {
      await manager.setOverride("persist-domain", 42, "test");

      const manager2 = new TrustManager(stateManager);
      expect((await manager2.getBalance("persist-domain")).balance).toBe(42);
    });

    it("persists permanent gates and reloads correctly", async () => {
      await manager.addPermanentGate("persist-domain", "db_drop");

      const manager2 = new TrustManager(stateManager);
      expect(await manager2.hasPermanentGate("persist-domain", "db_drop")).toBe(true);
    });

    it("persists multiple domains independently", async () => {
      await manager.recordSuccess("domain-1"); // 3
      await manager.recordSuccess("domain-1"); // 6
      await manager.recordFailure("domain-2"); // -10

      const manager2 = new TrustManager(stateManager);
      expect((await manager2.getBalance("domain-1")).balance).toBe(6);
      expect((await manager2.getBalance("domain-2")).balance).toBe(-10);
      expect((await manager2.getBalance("domain-3")).balance).toBe(0); // default
    });

    it("persists trust store to trust/trust-store.json", async () => {
      await manager.recordSuccess("check-path");
      const filePath = path.join(tmpDir, "trust", "trust-store.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.balances["check-path"]).toBeDefined();
      expect(parsed.balances["check-path"].balance).toBe(TRUST_SUCCESS_DELTA);
    });

    it("does not leave .tmp files after write", async () => {
      await manager.recordSuccess("atomic-test");
      const trustDir = path.join(tmpDir, "trust");
      const files = fs.readdirSync(trustDir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });
  });
});

// ─── Helpers for plugin trust tests ───

function makePluginState(overrides: Partial<PluginState> = {}): PluginState {
  const manifest = PluginManifestSchema.parse({
    name: "test-plugin",
    version: "1.0.0",
    type: "notifier",
    capabilities: ["notify"],
    description: "test",
  });
  return PluginStateSchema.parse({
    name: "test-plugin",
    manifest,
    status: "loaded",
    loaded_at: new Date().toISOString(),
    trust_score: 0,
    usage_count: 0,
    success_count: 0,
    failure_count: 0,
    ...overrides,
  });
}

function makePluginLoader(states: Record<string, PluginState>): PluginLoader {
  const captured: Record<string, PluginState> = { ...states };
  return {
    getPluginState: vi.fn((name: string) => captured[name] ?? null),
    updatePluginState: vi.fn(
      async (name: string, updates: Partial<PluginState>) => {
        if (captured[name]) {
          captured[name] = { ...captured[name], ...updates };
        }
      }
    ),
    _captured: captured,
  } as unknown as PluginLoader;
}

// ─── Plugin trust ───

describe("plugin trust", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: TrustManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-trust-plugin-test-"));
    stateManager = new StateManager(tmpDir);
    manager = new TrustManager(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordPluginSuccess increases trust_score by 3 and increments counts", async () => {
    const state = makePluginState({ name: "my-plugin", trust_score: 0, usage_count: 0, success_count: 0 });
    const manifest = state.manifest;
    const loader = makePluginLoader({ "my-plugin": state });
    manager.recordPluginSuccess("my-plugin", loader);
    // Allow async updatePluginState to complete
    await Promise.resolve();
    const captured = (loader as unknown as { _captured: Record<string, PluginState> })._captured;
    expect(captured["my-plugin"].trust_score).toBe(3);
    expect(captured["my-plugin"].success_count).toBe(1);
    expect(captured["my-plugin"].usage_count).toBe(1);
  });

  it("recordPluginFailure decreases trust_score by 10 and increments counts", async () => {
    const state = makePluginState({ name: "my-plugin", trust_score: 0, usage_count: 0, failure_count: 0 });
    const loader = makePluginLoader({ "my-plugin": state });
    manager.recordPluginFailure("my-plugin", loader);
    await Promise.resolve();
    const captured = (loader as unknown as { _captured: Record<string, PluginState> })._captured;
    expect(captured["my-plugin"].trust_score).toBe(-10);
    expect(captured["my-plugin"].failure_count).toBe(1);
    expect(captured["my-plugin"].usage_count).toBe(1);
  });

  it("trust score clamps at +100 on success", async () => {
    const state = makePluginState({ name: "my-plugin", trust_score: 99 });
    const loader = makePluginLoader({ "my-plugin": state });
    manager.recordPluginSuccess("my-plugin", loader);
    await Promise.resolve();
    const captured = (loader as unknown as { _captured: Record<string, PluginState> })._captured;
    expect(captured["my-plugin"].trust_score).toBe(100);
  });

  it("trust score clamps at -100 on failure", async () => {
    const state = makePluginState({ name: "my-plugin", trust_score: -95 });
    const loader = makePluginLoader({ "my-plugin": state });
    manager.recordPluginFailure("my-plugin", loader);
    await Promise.resolve();
    const captured = (loader as unknown as { _captured: Record<string, PluginState> })._captured;
    expect(captured["my-plugin"].trust_score).toBe(-100);
  });

  it("selectPlugin returns highest-scoring auto-selectable candidate", () => {
    const stateA = makePluginState({ name: "plugin-a", trust_score: 25 });
    const stateB = makePluginState({ name: "plugin-b", trust_score: 30 });
    const loader = makePluginLoader({ "plugin-a": stateA, "plugin-b": stateB });

    const candidates: PluginMatchResult[] = [
      { pluginName: "plugin-a", matchScore: 0.9, matchedDimensions: [], trustScore: 25, autoSelectable: true },
      { pluginName: "plugin-b", matchScore: 0.9, matchedDimensions: [], trustScore: 30, autoSelectable: true },
    ];

    const result = manager.selectPlugin(candidates, loader);
    expect(result).not.toBeNull();
    expect(result!.pluginName).toBe("plugin-b");
  });

  it("selectPlugin returns null when no candidates are auto-selectable", () => {
    const stateA = makePluginState({ name: "plugin-a", trust_score: 10 });
    const loader = makePluginLoader({ "plugin-a": stateA });

    const candidates: PluginMatchResult[] = [
      { pluginName: "plugin-a", matchScore: 0.9, matchedDimensions: [], trustScore: 10, autoSelectable: false },
    ];

    const result = manager.selectPlugin(candidates, loader);
    expect(result).toBeNull();
  });
});
