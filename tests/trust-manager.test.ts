import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { TrustManager } from "../src/trust-manager.js";
import {
  HIGH_TRUST_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  TRUST_SUCCESS_DELTA,
  TRUST_FAILURE_DELTA,
} from "../src/types/trust.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-trust-test-"));
}

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
    it("returns default balance (score=0) for unknown domain", () => {
      const balance = manager.getBalance("unknown-domain");
      expect(balance.domain).toBe("unknown-domain");
      expect(balance.balance).toBe(0);
      expect(balance.success_delta).toBe(TRUST_SUCCESS_DELTA);
      expect(balance.failure_delta).toBe(TRUST_FAILURE_DELTA);
    });

    it("returns persisted balance for known domain", () => {
      manager.recordSuccess("my-domain");
      const balance = manager.getBalance("my-domain");
      expect(balance.balance).toBe(TRUST_SUCCESS_DELTA);
    });

    it("does not persist the default balance on access", () => {
      manager.getBalance("ghost-domain");
      // A second manager (fresh cache) should still return default
      const manager2 = new TrustManager(stateManager);
      const balance = manager2.getBalance("ghost-domain");
      expect(balance.balance).toBe(0);
    });
  });

  // ─── recordSuccess ───

  describe("recordSuccess", () => {
    it("increments balance by TRUST_SUCCESS_DELTA (+3)", () => {
      const result = manager.recordSuccess("domain-a");
      expect(result.balance).toBe(TRUST_SUCCESS_DELTA); // 0 + 3 = 3
    });

    it("accumulates multiple successes", () => {
      manager.recordSuccess("domain-a");
      manager.recordSuccess("domain-a");
      const balance = manager.getBalance("domain-a");
      expect(balance.balance).toBe(TRUST_SUCCESS_DELTA * 2); // 6
    });

    it("returns the updated TrustBalance", () => {
      const result = manager.recordSuccess("domain-b");
      expect(result.domain).toBe("domain-b");
      expect(result.balance).toBe(TRUST_SUCCESS_DELTA);
    });
  });

  // ─── recordFailure ───

  describe("recordFailure", () => {
    it("decrements balance by TRUST_FAILURE_DELTA (-10)", () => {
      const result = manager.recordFailure("domain-a");
      expect(result.balance).toBe(TRUST_FAILURE_DELTA); // 0 + (-10) = -10
    });

    it("accumulates multiple failures", () => {
      manager.recordFailure("domain-a");
      manager.recordFailure("domain-a");
      const balance = manager.getBalance("domain-a");
      expect(balance.balance).toBe(TRUST_FAILURE_DELTA * 2); // -20
    });

    it("returns the updated TrustBalance", () => {
      const result = manager.recordFailure("domain-b");
      expect(result.domain).toBe("domain-b");
      expect(result.balance).toBe(TRUST_FAILURE_DELTA);
    });
  });

  // ─── Clamping ───

  describe("clamping", () => {
    it("clamps balance at +100 on repeated successes", () => {
      // Need to reach above 100: 34 * 3 = 102 > 100
      for (let i = 0; i < 34; i++) {
        manager.recordSuccess("clamped-high");
      }
      const balance = manager.getBalance("clamped-high");
      expect(balance.balance).toBe(100);
    });

    it("clamps balance at -100 on repeated failures", () => {
      // Need to reach below -100: 10 * 10 = 100 > 100
      for (let i = 0; i < 11; i++) {
        manager.recordFailure("clamped-low");
      }
      const balance = manager.getBalance("clamped-low");
      expect(balance.balance).toBe(-100);
    });

    it("stays at +100 after additional successes once clamped", () => {
      for (let i = 0; i < 40; i++) {
        manager.recordSuccess("max-domain");
      }
      const before = manager.getBalance("max-domain").balance;
      manager.recordSuccess("max-domain");
      const after = manager.getBalance("max-domain").balance;
      expect(before).toBe(100);
      expect(after).toBe(100);
    });

    it("stays at -100 after additional failures once clamped", () => {
      for (let i = 0; i < 15; i++) {
        manager.recordFailure("min-domain");
      }
      const before = manager.getBalance("min-domain").balance;
      manager.recordFailure("min-domain");
      const after = manager.getBalance("min-domain").balance;
      expect(before).toBe(-100);
      expect(after).toBe(-100);
    });
  });

  // ─── Mixed success/failure sequences ───

  describe("mixed success/failure sequences", () => {
    it("recovers from failures with successes", () => {
      manager.recordFailure("mixed"); // -10
      manager.recordSuccess("mixed"); // -7
      manager.recordSuccess("mixed"); // -4
      manager.recordSuccess("mixed"); // -1
      manager.recordSuccess("mixed"); // +2
      const balance = manager.getBalance("mixed");
      expect(balance.balance).toBe(-10 + 3 + 3 + 3 + 3); // 2
    });

    it("tracks independent domains separately", () => {
      manager.recordSuccess("domain-x"); // +3
      manager.recordFailure("domain-y"); // -10
      expect(manager.getBalance("domain-x").balance).toBe(3);
      expect(manager.getBalance("domain-y").balance).toBe(-10);
    });
  });

  // ─── getActionQuadrant ───

  describe("getActionQuadrant", () => {
    it("returns 'autonomous' for high trust AND high confidence", () => {
      // Set trust to HIGH_TRUST_THRESHOLD (20) via overrides
      manager.setOverride("domain", HIGH_TRUST_THRESHOLD, "test");
      const quadrant = manager.getActionQuadrant("domain", HIGH_CONFIDENCE_THRESHOLD);
      expect(quadrant).toBe("autonomous");
    });

    it("returns 'autonomous' for trust=20 and confidence=0.50 (boundary)", () => {
      manager.setOverride("domain", 20, "test");
      expect(manager.getActionQuadrant("domain", 0.50)).toBe("autonomous");
    });

    it("returns 'execute_with_confirm' for high trust AND low confidence", () => {
      manager.setOverride("domain", HIGH_TRUST_THRESHOLD, "test");
      const confidence = HIGH_CONFIDENCE_THRESHOLD - 0.01; // 0.49
      const quadrant = manager.getActionQuadrant("domain", confidence);
      expect(quadrant).toBe("execute_with_confirm");
    });

    it("returns 'execute_with_confirm' for low trust AND high confidence", () => {
      manager.setOverride("domain", HIGH_TRUST_THRESHOLD - 1, "test"); // 19
      const quadrant = manager.getActionQuadrant("domain", HIGH_CONFIDENCE_THRESHOLD);
      expect(quadrant).toBe("execute_with_confirm");
    });

    it("returns 'observe_and_propose' for low trust AND low confidence", () => {
      // Default domain starts at 0 trust
      const confidence = HIGH_CONFIDENCE_THRESHOLD - 0.01; // 0.49
      const quadrant = manager.getActionQuadrant("new-domain", confidence);
      expect(quadrant).toBe("observe_and_propose");
    });

    it("returns 'observe_and_propose' for negative trust and low confidence", () => {
      manager.recordFailure("neg-domain"); // -10
      const quadrant = manager.getActionQuadrant("neg-domain", 0.10);
      expect(quadrant).toBe("observe_and_propose");
    });

    it("returns 'execute_with_confirm' for trust=19 (just below threshold)", () => {
      manager.setOverride("domain", 19, "test");
      const quadrant = manager.getActionQuadrant("domain", 0.99);
      expect(quadrant).toBe("execute_with_confirm");
    });
  });

  // ─── requiresApproval ───

  describe("requiresApproval", () => {
    it("returns true for irreversible actions regardless of trust/confidence", () => {
      // Even with max trust and confidence, irreversible requires approval
      manager.setOverride("trusted", 100, "test");
      expect(manager.requiresApproval("irreversible", "trusted", 1.0)).toBe(true);
    });

    it("returns true for unknown reversibility regardless of trust/confidence", () => {
      manager.setOverride("trusted", 100, "test");
      expect(manager.requiresApproval("unknown", "trusted", 1.0)).toBe(true);
    });

    it("returns false for reversible action in autonomous quadrant", () => {
      manager.setOverride("trusted", 100, "test");
      expect(manager.requiresApproval("reversible", "trusted", 1.0)).toBe(false);
    });

    it("returns true for reversible action in execute_with_confirm quadrant (high trust, low confidence)", () => {
      manager.setOverride("domain", HIGH_TRUST_THRESHOLD, "test");
      const confidence = HIGH_CONFIDENCE_THRESHOLD - 0.01; // 0.49 → execute_with_confirm
      expect(manager.requiresApproval("reversible", "domain", confidence)).toBe(true);
    });

    it("returns true for reversible action in execute_with_confirm quadrant (low trust, high confidence)", () => {
      // Default trust = 0 < 20
      expect(manager.requiresApproval("reversible", "low-trust-domain", 0.99)).toBe(true);
    });

    it("returns true for reversible action in observe_and_propose quadrant", () => {
      // Default trust = 0, confidence = 0.10
      expect(manager.requiresApproval("reversible", "new-domain", 0.10)).toBe(true);
    });
  });

  // ─── setOverride ───

  describe("setOverride", () => {
    it("sets balance to exact value", () => {
      manager.setOverride("domain", 50, "manual adjustment");
      expect(manager.getBalance("domain").balance).toBe(50);
    });

    it("overrides a balance that was previously modified by successes", () => {
      manager.recordSuccess("domain"); // 3
      manager.setOverride("domain", 75, "admin override");
      expect(manager.getBalance("domain").balance).toBe(75);
    });

    it("logs the override in override_log", () => {
      manager.recordSuccess("domain"); // balance = 3
      manager.setOverride("domain", 50, "reason");

      const raw = stateManager.readRaw("trust/trust-store.json") as {
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

    it("clamps the override value to [-100, +100]", () => {
      manager.setOverride("domain", 999, "too high");
      expect(manager.getBalance("domain").balance).toBe(100);

      manager.setOverride("domain", -999, "too low");
      expect(manager.getBalance("domain").balance).toBe(-100);
    });

    it("can set override on a domain not previously seen", () => {
      manager.setOverride("brand-new", 20, "bootstrapping");
      expect(manager.getBalance("brand-new").balance).toBe(20);
    });
  });

  // ─── addPermanentGate / hasPermanentGate ───

  describe("addPermanentGate and hasPermanentGate", () => {
    it("returns false before any gate is added", () => {
      expect(manager.hasPermanentGate("domain", "file_delete")).toBe(false);
    });

    it("returns true after a gate is added", () => {
      manager.addPermanentGate("domain", "file_delete");
      expect(manager.hasPermanentGate("domain", "file_delete")).toBe(true);
    });

    it("does not affect other categories on the same domain", () => {
      manager.addPermanentGate("domain", "file_delete");
      expect(manager.hasPermanentGate("domain", "file_write")).toBe(false);
    });

    it("does not affect other domains", () => {
      manager.addPermanentGate("domain-a", "file_delete");
      expect(manager.hasPermanentGate("domain-b", "file_delete")).toBe(false);
    });

    it("allows multiple gates on the same domain", () => {
      manager.addPermanentGate("domain", "file_delete");
      manager.addPermanentGate("domain", "db_drop");
      expect(manager.hasPermanentGate("domain", "file_delete")).toBe(true);
      expect(manager.hasPermanentGate("domain", "db_drop")).toBe(true);
    });

    it("is idempotent — adding the same gate twice does not duplicate", () => {
      manager.addPermanentGate("domain", "file_delete");
      manager.addPermanentGate("domain", "file_delete");
      const raw = stateManager.readRaw("trust/trust-store.json") as {
        permanent_gates: Record<string, string[]>;
      };
      expect(raw.permanent_gates["domain"]).toHaveLength(1);
    });

    it("logs the permanent gate addition in override_log", () => {
      manager.addPermanentGate("domain", "file_delete");
      const raw = stateManager.readRaw("trust/trust-store.json") as {
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
    it("persists balance after recordSuccess and reloads correctly", () => {
      manager.recordSuccess("persist-domain");
      manager.recordSuccess("persist-domain");

      const manager2 = new TrustManager(stateManager);
      const balance = manager2.getBalance("persist-domain");
      expect(balance.balance).toBe(TRUST_SUCCESS_DELTA * 2); // 6
    });

    it("persists balance after recordFailure and reloads correctly", () => {
      manager.recordFailure("persist-domain");

      const manager2 = new TrustManager(stateManager);
      const balance = manager2.getBalance("persist-domain");
      expect(balance.balance).toBe(TRUST_FAILURE_DELTA); // -10
    });

    it("persists override and reloads correctly", () => {
      manager.setOverride("persist-domain", 42, "test");

      const manager2 = new TrustManager(stateManager);
      expect(manager2.getBalance("persist-domain").balance).toBe(42);
    });

    it("persists permanent gates and reloads correctly", () => {
      manager.addPermanentGate("persist-domain", "db_drop");

      const manager2 = new TrustManager(stateManager);
      expect(manager2.hasPermanentGate("persist-domain", "db_drop")).toBe(true);
    });

    it("persists multiple domains independently", () => {
      manager.recordSuccess("domain-1"); // 3
      manager.recordSuccess("domain-1"); // 6
      manager.recordFailure("domain-2"); // -10

      const manager2 = new TrustManager(stateManager);
      expect(manager2.getBalance("domain-1").balance).toBe(6);
      expect(manager2.getBalance("domain-2").balance).toBe(-10);
      expect(manager2.getBalance("domain-3").balance).toBe(0); // default
    });

    it("persists trust store to trust/trust-store.json", () => {
      manager.recordSuccess("check-path");
      const filePath = path.join(tmpDir, "trust", "trust-store.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.balances["check-path"]).toBeDefined();
      expect(parsed.balances["check-path"].balance).toBe(TRUST_SUCCESS_DELTA);
    });

    it("does not leave .tmp files after write", () => {
      manager.recordSuccess("atomic-test");
      const trustDir = path.join(tmpDir, "trust");
      const files = fs.readdirSync(trustDir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });
  });
});
