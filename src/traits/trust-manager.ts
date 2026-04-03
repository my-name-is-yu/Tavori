import type { StateManager } from "../state/state-manager.js";
import {
  TrustBalanceSchema,
  TrustStoreSchema,
  TrustOverrideLogEntrySchema,
} from "../types/trust.js";
import {
  HIGH_TRUST_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  TRUST_SUCCESS_DELTA,
  TRUST_FAILURE_DELTA,
} from "../types/trust.js";
import type { TrustBalance, TrustStore, ActionQuadrant } from "../types/trust.js";
import type { PluginMatchResult } from "../types/plugin.js";
import type { PluginLoader } from "../runtime/plugin-loader.js";

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

/** Maximum success calls allowed within 1-hour sliding window before rate limiting */
const TRUST_RATE_LIMIT_MAX = 3;
/** Sliding window duration in milliseconds (1 hour) */
const TRUST_RATE_LIMIT_WINDOW_MS = 3_600_000;

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
  /** In-memory sliding window of success call timestamps per domain */
  private successTimestamps: Map<string, number[]> = new Map();

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ─── Private: Store I/O ───

  private async loadStore(): Promise<TrustStore> {
    if (this.cache !== null) {
      return this.cache;
    }
    const raw = await this.stateManager.readRaw(TRUST_STORE_PATH);
    if (raw === null) {
      this.cache = emptyStore();
    } else {
      this.cache = TrustStoreSchema.parse(raw);
    }
    return this.cache;
  }

  private async saveStore(store: TrustStore): Promise<void> {
    const parsed = TrustStoreSchema.parse(store);
    this.cache = parsed;
    await this.stateManager.writeRaw(TRUST_STORE_PATH, parsed);
  }

  // ─── Public API ───

  /**
   * Get the trust balance for a domain.
   * Returns a default balance (score=0) if the domain is not yet tracked.
   */
  async getBalance(domain: string): Promise<TrustBalance> {
    const store = await this.loadStore();
    const existing = store.balances[domain];
    if (existing === undefined) {
      return defaultBalance(domain);
    }
    return TrustBalanceSchema.parse(existing);
  }

  /**
   * Record a successful task for a domain.
   * Adds TRUST_SUCCESS_DELTA (+3), clamps to [-100, +100], and persists.
   *
   * Rate limit: if 3+ success calls occurred in the last 1 hour for this domain,
   * the delta is skipped (but the current balance is still returned).
   */
  async recordSuccess(domain: string): Promise<TrustBalance> {
    const now = Date.now();
    const windowStart = now - TRUST_RATE_LIMIT_WINDOW_MS;

    // Filter timestamps to the current sliding window
    const timestamps = (this.successTimestamps.get(domain) ?? []).filter(
      (ts) => ts >= windowStart
    );

    if (timestamps.length >= TRUST_RATE_LIMIT_MAX) {
      console.warn(
        `WARN: trust rate limit triggered (domain: ${domain}, window: 1h, count: ${timestamps.length})`
      );
      // Store the cleaned-up timestamps and return without applying delta
      this.successTimestamps.set(domain, timestamps);
      const store = await this.loadStore();
      return store.balances[domain] ?? defaultBalance(domain);
    }

    // Record this call and apply the delta
    timestamps.push(now);
    this.successTimestamps.set(domain, timestamps);

    const store = await this.loadStore();
    const current = store.balances[domain] ?? defaultBalance(domain);
    const updated = TrustBalanceSchema.parse({
      ...current,
      balance: clamp(current.balance + TRUST_SUCCESS_DELTA),
    });
    store.balances[domain] = updated;
    await this.saveStore(store);
    return updated;
  }

  /**
   * Record a failed task for a domain.
   * Adds TRUST_FAILURE_DELTA (-10), clamps to [-100, +100], and persists.
   */
  async recordFailure(domain: string): Promise<TrustBalance> {
    const store = await this.loadStore();
    const current = store.balances[domain] ?? defaultBalance(domain);
    const updated = TrustBalanceSchema.parse({
      ...current,
      balance: clamp(current.balance + TRUST_FAILURE_DELTA),
    });
    store.balances[domain] = updated;
    await this.saveStore(store);
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
  async getActionQuadrant(domain: string, confidence: number): Promise<ActionQuadrant> {
    const { balance } = await this.getBalance(domain);
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
  async requiresApproval(
    reversibility: string,
    domain: string,
    confidence: number,
    category?: string
  ): Promise<boolean> {
    if (reversibility === "irreversible" || reversibility === "unknown") {
      return true;
    }
    if (category && await this.hasPermanentGate(domain, category)) {
      return true;
    }
    const quadrant = await this.getActionQuadrant(domain, confidence);
    return quadrant === "observe_and_propose";
  }

  /**
   * Override the trust balance for a domain to a specific value.
   * Logs the override with a reason and persists.
   */
  async setOverride(domain: string, balance: number, reason: string): Promise<void> {
    const store = await this.loadStore();
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

    await this.saveStore(store);
  }

  /**
   * Add a permanent gate for a category within a domain.
   * Actions with this category will always require approval regardless of trust/confidence.
   * Logs the gate addition and persists.
   */
  async addPermanentGate(domain: string, category: string): Promise<void> {
    const store = await this.loadStore();

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

    await this.saveStore(store);
  }

  /**
   * Check whether a permanent gate exists for the given domain and category.
   */
  async hasPermanentGate(domain: string, category: string): Promise<boolean> {
    const store = await this.loadStore();
    const gates = store.permanent_gates[domain];
    if (!gates) return false;
    return gates.includes(category);
  }

  // ─── Plugin trust ───

  /**
   * Record a successful plugin execution.
   * Updates trust_score (+3), success_count, and usage_count in PluginState.
   */
  recordPluginSuccess(pluginName: string, pluginLoader: PluginLoader): void {
    const state = pluginLoader.getPluginState(pluginName);
    if (state === null) return;
    pluginLoader.updatePluginState(pluginName, {
      trust_score: clamp(state.trust_score + TRUST_SUCCESS_DELTA),
      success_count: state.success_count + 1,
      usage_count: state.usage_count + 1,
    }).catch((err: unknown) => {
      console.warn('updatePluginState failed (recordPluginSuccess)', String(err));
    });
  }

  /**
   * Record a failed plugin execution.
   * Updates trust_score (-10), failure_count, and usage_count in PluginState.
   */
  recordPluginFailure(pluginName: string, pluginLoader: PluginLoader): void {
    const state = pluginLoader.getPluginState(pluginName);
    if (state === null) return;
    pluginLoader.updatePluginState(pluginName, {
      trust_score: clamp(state.trust_score + TRUST_FAILURE_DELTA),
      failure_count: state.failure_count + 1,
      usage_count: state.usage_count + 1,
    }).catch((err: unknown) => {
      console.warn('updatePluginState failed (recordPluginFailure)', String(err));
    });
  }

  /**
   * Select the best plugin from candidates.
   * Prefers auto-selectable (trust >= 20) candidates, picking highest matchScore then trustScore.
   * Returns null if no candidate is auto-selectable.
   */
  selectPlugin(candidates: PluginMatchResult[], pluginLoader: PluginLoader): PluginMatchResult | null {
    // Enrich candidates with current trust scores from pluginLoader
    const enriched = candidates.map((c) => {
      const state = pluginLoader.getPluginState(c.pluginName);
      const trustScore = state !== null ? state.trust_score : c.trustScore;
      return { ...c, trustScore, autoSelectable: trustScore >= HIGH_TRUST_THRESHOLD };
    });

    const autoSelectable = enriched.filter((c) => c.autoSelectable);
    if (autoSelectable.length === 0) return null;

    // Sort by matchScore desc, then trustScore desc
    autoSelectable.sort((a, b) =>
      b.matchScore !== a.matchScore ? b.matchScore - a.matchScore : b.trustScore - a.trustScore
    );
    return autoSelectable[0];
  }
}
