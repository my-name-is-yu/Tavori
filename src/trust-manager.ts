import type { StateManager } from "./state-manager.js";
import {
  TrustBalanceSchema,
  TrustStoreSchema,
  TrustOverrideLogEntrySchema,
} from "./types/trust.js";
import {
  HIGH_TRUST_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  TRUST_SUCCESS_DELTA,
  TRUST_FAILURE_DELTA,
} from "./types/trust.js";
import type { TrustBalance, TrustStore, ActionQuadrant } from "./types/trust.js";

/** Path relative to StateManager base dir for the trust store */
const TRUST_STORE_PATH = "trust/trust-store.json";

/** Default empty TrustStore */
function emptyStore(): TrustStore {
  return TrustStoreSchema.parse({
    balances: {},
    permanent_gates: {},
    override_log: [],
  });
}

/** Default TrustBalance for a new domain */
function defaultBalance(domain: string): TrustBalance {
  return TrustBalanceSchema.parse({
    domain,
    balance: 0,
    success_delta: TRUST_SUCCESS_DELTA,
    failure_delta: TRUST_FAILURE_DELTA,
  });
}

/** Clamp a value to [-100, 100] */
function clamp(value: number): number {
  return Math.max(-100, Math.min(100, value));
}

/**
 * TrustManager handles per-domain trust balances, action quadrant determination,
 * irreversibility-based approval requirements, and user overrides.
 *
 * Persistence: `trust/trust-store.json` via StateManager readRaw/writeRaw.
 * The store is loaded lazily on first access and cached in memory.
 * Every mutation persists immediately.
 */
export class TrustManager {
  private readonly stateManager: StateManager;
  private cache: TrustStore | null = null;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ─── Private: Store I/O ───

  private loadStore(): TrustStore {
    if (this.cache !== null) {
      return this.cache;
    }
    const raw = this.stateManager.readRaw(TRUST_STORE_PATH);
    if (raw === null) {
      this.cache = emptyStore();
    } else {
      this.cache = TrustStoreSchema.parse(raw);
    }
    return this.cache;
  }

  private saveStore(store: TrustStore): void {
    const parsed = TrustStoreSchema.parse(store);
    this.cache = parsed;
    this.stateManager.writeRaw(TRUST_STORE_PATH, parsed);
  }

  // ─── Public API ───

  /**
   * Get the trust balance for a domain.
   * Returns a default balance (score=0) if the domain is not yet tracked.
   */
  getBalance(domain: string): TrustBalance {
    const store = this.loadStore();
    const existing = store.balances[domain];
    if (existing === undefined) {
      return defaultBalance(domain);
    }
    return TrustBalanceSchema.parse(existing);
  }

  /**
   * Record a successful task for a domain.
   * Adds TRUST_SUCCESS_DELTA (+3), clamps to [-100, +100], and persists.
   */
  recordSuccess(domain: string): TrustBalance {
    const store = this.loadStore();
    const current = store.balances[domain] ?? defaultBalance(domain);
    const updated = TrustBalanceSchema.parse({
      ...current,
      balance: clamp(current.balance + TRUST_SUCCESS_DELTA),
    });
    store.balances[domain] = updated;
    this.saveStore(store);
    return updated;
  }

  /**
   * Record a failed task for a domain.
   * Adds TRUST_FAILURE_DELTA (-10), clamps to [-100, +100], and persists.
   */
  recordFailure(domain: string): TrustBalance {
    const store = this.loadStore();
    const current = store.balances[domain] ?? defaultBalance(domain);
    const updated = TrustBalanceSchema.parse({
      ...current,
      balance: clamp(current.balance + TRUST_FAILURE_DELTA),
    });
    store.balances[domain] = updated;
    this.saveStore(store);
    return updated;
  }

  /**
   * Determine the action quadrant based on trust balance and confidence.
   *
   * Matrix:
   *   trust >= 20 AND confidence >= 0.50 → "autonomous"
   *   trust >= 20 AND confidence < 0.50  → "execute_with_confirm"
   *   trust <  20 AND confidence >= 0.50 → "execute_with_confirm"
   *   trust <  20 AND confidence < 0.50  → "observe_and_propose"
   */
  getActionQuadrant(domain: string, confidence: number): ActionQuadrant {
    const { balance } = this.getBalance(domain);
    const highTrust = balance >= HIGH_TRUST_THRESHOLD;
    const highConfidence = confidence >= HIGH_CONFIDENCE_THRESHOLD;

    if (highTrust && highConfidence) {
      return "autonomous";
    }
    if (!highTrust && !highConfidence) {
      return "observe_and_propose";
    }
    return "execute_with_confirm";
  }

  /**
   * Determine whether an action requires human approval.
   *
   * Returns true if:
   *   - reversibility is "irreversible" or "unknown" (always requires approval), OR
   *   - a permanent gate exists for the given domain and category, OR
   *   - the action quadrant is not "autonomous"
   */
  requiresApproval(
    reversibility: string,
    domain: string,
    confidence: number,
    category?: string
  ): boolean {
    if (reversibility === "irreversible" || reversibility === "unknown") {
      return true;
    }
    if (category && this.hasPermanentGate(domain, category)) {
      return true;
    }
    const quadrant = this.getActionQuadrant(domain, confidence);
    return quadrant === "observe_and_propose";
  }

  /**
   * Override the trust balance for a domain to a specific value.
   * Logs the override with a reason and persists.
   */
  setOverride(domain: string, balance: number, reason: string): void {
    const store = this.loadStore();
    const current = store.balances[domain] ?? defaultBalance(domain);
    const balanceBefore = current.balance;
    const balanceAfter = clamp(balance);

    const updated = TrustBalanceSchema.parse({
      ...current,
      balance: balanceAfter,
    });
    store.balances[domain] = updated;

    const logEntry = TrustOverrideLogEntrySchema.parse({
      timestamp: new Date().toISOString(),
      override_type: "trust_grant",
      domain,
      target_category: null,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    });
    store.override_log.push(logEntry);

    this.saveStore(store);
  }

  /**
   * Add a permanent gate for a category within a domain.
   * Actions with this category will always require approval regardless of trust/confidence.
   * Logs the gate addition and persists.
   */
  addPermanentGate(domain: string, category: string): void {
    const store = this.loadStore();

    if (!store.permanent_gates[domain]) {
      store.permanent_gates[domain] = [];
    }

    if (!store.permanent_gates[domain].includes(category)) {
      store.permanent_gates[domain].push(category);
    }

    const logEntry = TrustOverrideLogEntrySchema.parse({
      timestamp: new Date().toISOString(),
      override_type: "permanent_gate",
      domain,
      target_category: category,
      balance_before: null,
      balance_after: null,
    });
    store.override_log.push(logEntry);

    this.saveStore(store);
  }

  /**
   * Check whether a permanent gate exists for the given domain and category.
   */
  hasPermanentGate(domain: string, category: string): boolean {
    const store = this.loadStore();
    const gates = store.permanent_gates[domain];
    if (!gates) return false;
    return gates.includes(category);
  }
}
