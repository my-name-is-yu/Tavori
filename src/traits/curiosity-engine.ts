import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { StallDetector } from "../drive/stall-detector.js";
import type { DriveSystem } from "../drive/drive-system.js";
import type { VectorIndex } from "../knowledge/vector-index.js";
import type { KnowledgeTransfer } from "../knowledge/transfer/knowledge-transfer.js";
import type { TransferCandidate } from "../types/cross-portfolio.js";
import type { Goal } from "../types/goal.js";
import {
  CuriosityStateSchema,
  CuriosityTriggerSchema,
  CuriosityProposalSchema,
  CuriosityConfigSchema,
  LearningRecordSchema,
} from "../types/curiosity.js";
import type {
  CuriosityState,
  CuriosityTrigger,
  CuriosityProposal,
  CuriosityConfig,
  LearningRecord,
} from "../types/curiosity.js";
import {
  buildProposalPrompt,
  computeProposalHash,
  isInRejectionCooldown,
  generateProposals as generateProposalsImpl,
} from "./curiosity-proposals.js";
import {
  detectSemanticTransfer as detectSemanticTransferImpl,
  detectKnowledgeTransferOpportunities as detectKnowledgeTransferOpportunitiesImpl,
} from "./curiosity-transfer.js";

// ─── Constants ───

const CURIOSITY_STATE_PATH = "curiosity/state.json";

// ─── Deps Interface ───

export interface CuriosityEngineDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  ethicsGate: EthicsGate;
  stallDetector: StallDetector;
  driveSystem: DriveSystem;
  vectorIndex?: VectorIndex;  // Phase 2: embedding-based detection
  knowledgeTransfer?: KnowledgeTransfer;  // Stage 14F: cross-goal transfer detection
  config?: Partial<CuriosityConfig>;
}

// ─── CuriosityEngine ───

/**
 * CuriosityEngine implements Stage 11C (Curiosity MVP).
 *
 * It acts as a meta-orchestrator: while the 3 drive forces (dissatisfaction,
 * deadline, opportunity) select tasks within existing goals, CuriosityEngine
 * proposes new goals or goal restructurings based on learning feedback.
 *
 * Key responsibilities:
 * - Evaluate 5 trigger conditions (§2 of curiosity.md)
 * - Generate LLM-based proposals, filtered by ethics gate
 * - Track proposal lifecycle (pending → approved/rejected/expired/auto_closed)
 * - Enforce constraints: max proposals, rejection cooldown, resource budget
 * - Persist all state to curiosity/state.json via StateManager
 */
export class CuriosityEngine {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly ethicsGate: EthicsGate;
  private readonly stallDetector: StallDetector;
  private readonly driveSystem: DriveSystem;
  private readonly vectorIndex?: VectorIndex;
  private readonly knowledgeTransfer?: KnowledgeTransfer;
  private readonly config: CuriosityConfig;
  private state: CuriosityState;

  constructor(deps: CuriosityEngineDeps) {
    this.stateManager = deps.stateManager;
    this.llmClient = deps.llmClient;
    this.ethicsGate = deps.ethicsGate;
    this.stallDetector = deps.stallDetector;
    this.driveSystem = deps.driveSystem;
    this.vectorIndex = deps.vectorIndex;
    this.knowledgeTransfer = deps.knowledgeTransfer;

    // Merge user config with defaults
    this.config = CuriosityConfigSchema.parse(deps.config ?? {});

    // Initialize with empty state; actual state is loaded asynchronously via ensureStateLoaded()
    this.state = CuriosityStateSchema.parse({
      proposals: [],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });
    this._stateLoaded = false;
  }

  private _stateLoaded: boolean;

  private async ensureStateLoaded(): Promise<void> {
    if (!this._stateLoaded) {
      this.state = await this.loadState();
      this._stateLoaded = true;
    }
  }

  // ─── State Persistence ───

  private async loadState(): Promise<CuriosityState> {
    const raw = await this.stateManager.readRaw(CURIOSITY_STATE_PATH);
    if (raw === null) {
      return CuriosityStateSchema.parse({
        proposals: [],
        learning_records: [],
        last_exploration_at: null,
        rejected_proposal_hashes: [],
      });
    }
    try {
      return CuriosityStateSchema.parse(raw);
    } catch {
      // Corrupt state — start fresh
      return CuriosityStateSchema.parse({
        proposals: [],
        learning_records: [],
        last_exploration_at: null,
        rejected_proposal_hashes: [],
      });
    }
  }

  private async saveState(): Promise<void> {
    const parsed = CuriosityStateSchema.parse(this.state);
    await this.stateManager.writeRaw(CURIOSITY_STATE_PATH, parsed);
  }

  // ─── Trigger Helpers ───

  /**
   * 2.1: All active user goals are completed or waiting.
   */
  private checkTaskQueueEmpty(goals: Goal[]): CuriosityTrigger | null {
    const userGoals = goals.filter(
      (g) => g.origin !== "curiosity" || g.origin === null
    );

    if (userGoals.length === 0) return null;

    const allInactive = userGoals.every(
      (g) => g.status === "completed" || g.status === "waiting"
    );

    if (!allInactive) return null;

    return CuriosityTriggerSchema.parse({
      type: "task_queue_empty",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: `All ${userGoals.length} user goal(s) are completed or waiting. Entering curiosity mode.`,
      severity: 0.8,
    });
  }

  /**
   * 2.2: Unexpected observation — a dimension's value deviates significantly
   * from its historical mean (> threshold * stddev).
   */
  private checkUnexpectedObservation(goals: Goal[]): CuriosityTrigger | null {
    const threshold = this.config.unexpected_observation_threshold;

    for (const goal of goals) {
      if (goal.status !== "active") continue;

      for (const dim of goal.dimensions) {
        const history = dim.history;
        if (history.length < 4) continue; // need enough data

        // Compute mean and stddev of numeric history values
        const numericValues = history
          .map((h) => (typeof h.value === "number" ? h.value : null))
          .filter((v): v is number => v !== null);

        if (numericValues.length < 4) continue;

        const mean =
          numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
        const variance =
          numericValues.reduce((a, b) => a + (b - mean) ** 2, 0) /
          numericValues.length;
        const stddev = Math.sqrt(variance);

        if (stddev === 0) continue;

        const currentValue = dim.current_value;
        if (typeof currentValue !== "number") continue;

        const deviation = Math.abs(currentValue - mean);
        if (deviation > threshold * stddev) {
          return CuriosityTriggerSchema.parse({
            type: "unexpected_observation",
            detected_at: new Date().toISOString(),
            source_goal_id: goal.id,
            details: `Dimension "${dim.name}" in goal "${goal.id}" deviated ${deviation.toFixed(2)} from mean ${mean.toFixed(2)} (stddev=${stddev.toFixed(2)}, threshold=${threshold}σ).`,
            severity: Math.min(1.0, deviation / (stddev * threshold * 2)),
          });
        }
      }
    }

    return null;
  }

  /**
   * 2.3: Repeated domain failures — StallDetector reports consecutive_failure
   * or global_stall for any active user goal.
   */
  private async checkRepeatedFailures(goals: Goal[]): Promise<CuriosityTrigger | null> {
    const activeUserGoals = goals.filter(
      (g) => g.status === "active" && g.origin !== "curiosity"
    );

    for (const goal of activeUserGoals) {
      const stallState = await this.stallDetector.getStallState(goal.id);

      // Check dimension-level escalation: any dimension with escalation_level > 0
      // that was caused by consecutive failures
      const hasConsecutiveFailure = Object.entries(
        stallState.dimension_escalation
      ).some(([, level]) => level > 0);

      if (hasConsecutiveFailure) {
        const stalledDims = Object.entries(stallState.dimension_escalation)
          .filter(([, level]) => level > 0)
          .map(([dim]) => dim);

        return CuriosityTriggerSchema.parse({
          type: "repeated_failure",
          detected_at: new Date().toISOString(),
          source_goal_id: goal.id,
          details: `Goal "${goal.id}" has escalated stall on dimension(s): ${stalledDims.join(", ")}. Task-level approaches are failing; goal structure may need revision.`,
          severity: 0.7,
        });
      }
    }

    return null;
  }

  /**
   * 2.4: Goal Reviewer found undefined problems — dimensions with very low
   * observation confidence indicate unmapped important problems.
   */
  private checkUndefinedProblems(goals: Goal[]): CuriosityTrigger | null {
    const activeGoals = goals.filter((g) => g.status === "active");

    for (const goal of activeGoals) {
      // Look for dimensions with extremely low confidence (< 0.3)
      // that represent important but poorly understood aspects
      const lowConfidenceDims = goal.dimensions.filter(
        (d) => d.confidence < 0.3
      );

      if (lowConfidenceDims.length > 0 && goal.dimensions.length > 0) {
        const ratio = lowConfidenceDims.length / goal.dimensions.length;
        // Trigger only when more than half the dimensions are poorly observed
        if (ratio >= 0.5) {
          const dimNames = lowConfidenceDims.map((d) => d.name).join(", ");
          return CuriosityTriggerSchema.parse({
            type: "undefined_problem",
            detected_at: new Date().toISOString(),
            source_goal_id: goal.id,
            details: `Goal "${goal.id}" has ${lowConfidenceDims.length} dimension(s) with very low confidence (< 0.3): ${dimNames}. Current goal structure may not cover the real problem space.`,
            severity: 0.5 + ratio * 0.3,
          });
        }
      }
    }

    return null;
  }

  /**
   * 2.5: Periodic exploration — has it been >= periodic_exploration_hours
   * since the last exploration trigger?
   */
  private checkPeriodicExploration(): CuriosityTrigger | null {
    const lastExploration = this.state.last_exploration_at;
    const intervalMs =
      this.config.periodic_exploration_hours * 60 * 60 * 1000;

    if (lastExploration === null) {
      // Never explored — trigger immediately
      return CuriosityTriggerSchema.parse({
        type: "periodic_exploration",
        detected_at: new Date().toISOString(),
        source_goal_id: null,
        details: `First periodic exploration check. No previous exploration recorded.`,
        severity: 0.3,
      });
    }

    const elapsed = Date.now() - new Date(lastExploration).getTime();
    if (elapsed >= intervalMs) {
      const hoursElapsed = (elapsed / (1000 * 60 * 60)).toFixed(1);
      return CuriosityTriggerSchema.parse({
        type: "periodic_exploration",
        detected_at: new Date().toISOString(),
        source_goal_id: null,
        details: `${hoursElapsed} hours since last exploration (threshold: ${this.config.periodic_exploration_hours}h). Periodic curiosity check.`,
        severity: 0.3,
      });
    }

    return null;
  }

  // ─── Public API ───

  /**
   * Evaluate all 5 trigger conditions against current goal state.
   * Returns an array of fired triggers (may be empty if none fire).
   */
  async evaluateTriggers(goals: Goal[]): Promise<CuriosityTrigger[]> {
    if (!this.config.enabled) return [];
    await this.ensureStateLoaded();

    const triggers: CuriosityTrigger[] = [];

    const t1 = this.checkTaskQueueEmpty(goals);
    if (t1) triggers.push(t1);

    const t2 = this.checkUnexpectedObservation(goals);
    if (t2) triggers.push(t2);

    const t3 = await this.checkRepeatedFailures(goals);
    if (t3) triggers.push(t3);

    const t4 = this.checkUndefinedProblems(goals);
    if (t4) triggers.push(t4);

    const t5 = this.checkPeriodicExploration();
    if (t5) triggers.push(t5);

    return triggers;
  }

  /**
   * Generate curiosity proposals using the LLM, filtered by ethics gate.
   *
   * - Respects max_active_proposals limit (skips generation if at capacity)
   * - Skips proposals in rejection cooldown
   * - Runs ethics check on each proposal before adding
   * - Updates last_exploration_at on any periodic_exploration trigger
   * - Saves state after mutation
   */
  async generateProposals(
    triggers: CuriosityTrigger[],
    goals: Goal[]
  ): Promise<CuriosityProposal[]> {
    await this.ensureStateLoaded();
    const activeProposals = this.getActiveProposals();

    const newProposals = await generateProposalsImpl(
      triggers,
      goals,
      this.state,
      activeProposals.length,
      {
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        vectorIndex: this.vectorIndex,
        knowledgeTransfer: this.knowledgeTransfer,
        config: this.config,
      }
    );

    this.saveState();
    return newProposals;
  }

  /**
   * Approve a pending proposal by ID.
   * Sets status to "approved" and records reviewed_at.
   * Throws if proposal is not found or not in "pending" status.
   */
  approveProposal(proposalId: string): CuriosityProposal {
    const index = this.state.proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
      throw new Error(
        `CuriosityEngine.approveProposal: proposal "${proposalId}" not found`
      );
    }

    const proposal = this.state.proposals[index]!;
    if (proposal.status !== "pending") {
      throw new Error(
        `CuriosityEngine.approveProposal: proposal "${proposalId}" is not pending (status=${proposal.status})`
      );
    }

    const updated = CuriosityProposalSchema.parse({
      ...proposal,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });

    this.state.proposals[index] = updated;
    this.saveState();
    return updated;
  }

  /**
   * Reject a pending proposal by ID.
   * Sets status to "rejected", records reviewed_at, and sets rejection_cooldown_until.
   * Also adds the proposal hash to rejected_proposal_hashes for cooldown tracking.
   * Throws if proposal is not found or not in "pending" status.
   */
  rejectProposal(proposalId: string): CuriosityProposal {
    const index = this.state.proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
      throw new Error(
        `CuriosityEngine.rejectProposal: proposal "${proposalId}" not found`
      );
    }

    const proposal = this.state.proposals[index]!;
    if (proposal.status !== "pending") {
      throw new Error(
        `CuriosityEngine.rejectProposal: proposal "${proposalId}" is not pending (status=${proposal.status})`
      );
    }

    const now = new Date();
    const cooldownUntil = new Date(
      now.getTime() +
        this.config.rejection_cooldown_hours * 60 * 60 * 1000
    );

    const updated = CuriosityProposalSchema.parse({
      ...proposal,
      status: "rejected",
      reviewed_at: now.toISOString(),
      rejection_cooldown_until: cooldownUntil.toISOString(),
    });

    this.state.proposals[index] = updated;

    // Track hash for cooldown deduplication
    const hash = computeProposalHash(proposal.proposed_goal.description);
    if (!this.state.rejected_proposal_hashes.includes(hash)) {
      this.state.rejected_proposal_hashes.push(hash);
    }

    this.saveState();
    return updated;
  }

  /**
   * Expire pending proposals past their expires_at date, and auto-close
   * approved proposals that have reached the unproductive_loop_limit.
   *
   * Returns the list of proposals that were changed in this call.
   */
  checkAutoExpiration(): CuriosityProposal[] {
    const now = new Date();
    const changed: CuriosityProposal[] = [];

    this.state.proposals = this.state.proposals.map((p) => {
      // Expire pending proposals past expires_at
      if (p.status === "pending" && new Date(p.expires_at) <= now) {
        const updated = CuriosityProposalSchema.parse({
          ...p,
          status: "expired",
        });
        changed.push(updated);
        return updated;
      }

      // Auto-close approved proposals at or past the unproductive loop limit
      if (
        p.status === "approved" &&
        p.loop_count >= this.config.unproductive_loop_limit
      ) {
        const updated = CuriosityProposalSchema.parse({
          ...p,
          status: "auto_closed",
        });
        changed.push(updated);
        return updated;
      }

      return p;
    });

    if (changed.length > 0) {
      this.saveState();
    }

    return changed;
  }

  /**
   * Increment loop_count for an approved curiosity proposal identified by its goal_id.
   * No-op if no matching proposal is found.
   */
  incrementLoopCount(goalId: string): void {
    let changed = false;

    this.state.proposals = this.state.proposals.map((p) => {
      if (p.status === "approved" && p.goal_id === goalId) {
        changed = true;
        return CuriosityProposalSchema.parse({
          ...p,
          loop_count: p.loop_count + 1,
        });
      }
      return p;
    });

    if (changed) {
      this.saveState();
    }
  }

  /**
   * Add a learning record to state and persist.
   * Automatically sets recorded_at to now.
   */
  recordLearning(record: Omit<LearningRecord, "recorded_at">): void {
    const full = LearningRecordSchema.parse({
      ...record,
      recorded_at: new Date().toISOString(),
    });
    this.state.learning_records.push(full);
    this.saveState();
  }

  /**
   * Return all proposals with status "pending" or "approved".
   */
  getActiveProposals(): CuriosityProposal[] {
    return this.state.proposals.filter(
      (p) => p.status === "pending" || p.status === "approved"
    );
  }

  /**
   * Quick check: are there any triggers that warrant curiosity?
   * Used by CoreLoop to decide whether to run full evaluateTriggers.
   *
   * Returns true if:
   * - Curiosity is enabled
   * - Any of the quick-check conditions are met (task queue empty,
   *   periodic exploration overdue, or any stall state detected)
   */
  async shouldExplore(goals: Goal[]): Promise<boolean> {
    if (!this.config.enabled) return false;
    await this.ensureStateLoaded();

    // Quick check 1: task queue empty
    const userGoals = goals.filter((g) => g.origin !== "curiosity");
    if (
      userGoals.length > 0 &&
      userGoals.every(
        (g) => g.status === "completed" || g.status === "waiting"
      )
    ) {
      return true;
    }

    // Quick check 2: periodic exploration overdue
    const lastExploration = this.state.last_exploration_at;
    if (lastExploration === null) return true;
    const intervalMs =
      this.config.periodic_exploration_hours * 60 * 60 * 1000;
    if (Date.now() - new Date(lastExploration).getTime() >= intervalMs) {
      return true;
    }

    // Quick check 3: any active goal has stall state with escalated dimensions
    const activeGoals = goals.filter(
      (g) => g.status === "active" && g.origin !== "curiosity"
    );
    for (const goal of activeGoals) {
      const stallState = await this.stallDetector.getStallState(goal.id);
      const hasEscalated = Object.values(stallState.dimension_escalation).some(
        (level) => level > 0
      );
      if (hasEscalated) return true;
    }

    return false;
  }

  // ─── Phase 2: Embedding-based Detection ───

  /**
   * Index a dimension name into the VectorIndex for semantic search.
   * Silently skips if no vectorIndex is configured.
   */
  async indexDimensionToVector(goalId: string, dimensionName: string): Promise<void> {
    if (!this.vectorIndex) return;
    await this.vectorIndex.add(
      `dim:${goalId}:${dimensionName}`,
      dimensionName,
      { goal_id: goalId, type: "dimension" }
    );
  }

  /**
   * Find semantically similar dimensions across other goals using VectorIndex.
   * Returns up to 3 results with similarity > 0.7. Returns [] if no vectorIndex.
   */
  async findSimilarDimensions(
    goalId: string,
    dimName: string
  ): Promise<Array<{ id: string; similarity: number; goal_id: string }>> {
    if (!this.vectorIndex) return [];
    const results = await this.vectorIndex.search(dimName, 3, 0.7);
    return results
      .filter((r) => (r.metadata.goal_id as string) !== goalId)
      .map((r) => ({ id: r.id, similarity: r.similarity, goal_id: r.metadata.goal_id as string }));
  }

  /**
   * Detect semantically similar dimensions across goals using VectorIndex.
   * Returns cross-goal transfers with similarity > 0.7.
   */
  async detectSemanticTransfer(
    goalId: string,
    dimensions: string[]
  ): Promise<Array<{ source_goal_id: string; dimension: string; similarity: number }>> {
    return detectSemanticTransferImpl(goalId, dimensions, {
      vectorIndex: this.vectorIndex,
    });
  }

  // ─── Stage 14F: KnowledgeTransfer Integration ───

  /**
   * Detect cross-goal knowledge transfer opportunities for all active goals.
   * Requires knowledgeTransfer to be injected — returns [] otherwise.
   *
   * For each active goal, calls KnowledgeTransfer.detectTransferOpportunities()
   * and converts the resulting TransferCandidates into a flat list.
   * Results are suggestion-only (Phase 1); no transfers are applied automatically.
   */
  async detectKnowledgeTransferOpportunities(
    goals: Goal[]
  ): Promise<TransferCandidate[]> {
    return detectKnowledgeTransferOpportunitiesImpl(goals, {
      knowledgeTransfer: this.knowledgeTransfer,
    });
  }

  /**
   * Calculate the allowed resource percentage for curiosity goals based on
   * the current state of user goals.
   *
   * Returns:
   *   - 100 (no limit) if all user goals are completed
   *   - waiting_user_goals_max_percent if all user goals are waiting
   *   - active_user_goals_max_percent if any user goals are active
   *   - 0 if curiosity is disabled
   */
  getResourceBudget(goals: Goal[]): number {
    if (!this.config.enabled) return 0;

    const userGoals = goals.filter(
      (g) => g.origin !== "curiosity" && g.origin !== null
    );

    // Also treat goals with no origin as user goals
    const allUserGoals = goals.filter((g) => g.origin !== "curiosity");

    if (allUserGoals.length === 0) {
      // No user goals — unlimited curiosity budget
      return 100;
    }

    const allCompleted = allUserGoals.every((g) => g.status === "completed");
    if (allCompleted) {
      return 100;
    }

    const allWaiting = allUserGoals.every(
      (g) => g.status === "completed" || g.status === "waiting"
    );
    if (allWaiting) {
      return this.config.resource_budget.waiting_user_goals_max_percent;
    }

    // Some goals are active — limited budget
    void userGoals; // suppress unused-var warning; variable used above via allUserGoals
    return this.config.resource_budget.active_user_goals_max_percent;
  }
}
