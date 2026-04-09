import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../../prompt/gateway.js";
import type { KnowledgeManager } from "../knowledge-manager.js";
import type { VectorIndex } from "../vector-index.js";
import type { LearningPipeline } from "../learning/learning-pipeline.js";
import type { EthicsGate } from "../../traits/ethics-gate.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { z } from "zod";
import type {
  TransferCandidate,
  TransferResult,
  TransferEffectivenessRecord,
} from "../../../base/types/cross-portfolio.js";
import {
  TransferCandidateSchema,
  TransferResultSchema,
  TransferEffectivenessSchema,
} from "../../../base/types/cross-portfolio.js";
import type { CrossGoalPattern, StructuralFeedbackType } from "../../../base/types/learning.js";
import { LearnedPatternSchema } from "../../../base/types/learning.js";
import { TransferTrustManager } from "./transfer-trust.js";
import type { TransferContext, PatternEffectivenessTracker } from "./knowledge-transfer-types.js";

import { detectTransferOpportunities } from "./knowledge-transfer-detect.js";
import type { DetectDeps } from "./knowledge-transfer-detect.js";
import {
  applyTransfer,
  autoApplyHighConfidenceTransfers,
  detectCandidatesRealtime,
} from "./knowledge-transfer-apply.js";
import type { ApplyDeps } from "./knowledge-transfer-apply.js";
import {
  evaluateTransferEffect,
  getEffectivenessRecords,
  getAppliedTransferCount,
  getTransferSuccessRate,
} from "./knowledge-transfer-evaluate.js";
import {
  buildCrossGoalKnowledgeBase,
  updateMetaPatternsIncremental,
  storePattern,
  retrievePatterns,
} from "./knowledge-transfer-meta.js";
import type { MetaDeps } from "./knowledge-transfer-meta.js";

// ─── KnowledgeTransfer (Facade) ───

/**
 * KnowledgeTransfer implements cross-goal knowledge and strategy transfer.
 *
 * Phase 1 (MVP): Transfer is always suggestion-only.
 * applyTransfer() exists but should only be called after explicit user approval.
 *
 * Delegates to sub-modules:
 * - knowledge-transfer-detect.ts  — candidate detection + scoring
 * - knowledge-transfer-apply.ts   — application + ethics gating
 * - knowledge-transfer-evaluate.ts — effectiveness evaluation + trust update
 * - knowledge-transfer-meta.ts    — meta-pattern aggregation (batch + incremental)
 *
 * State is kept in-memory and mirrored to a persisted snapshot so other
 * processes can read transfer history without sharing process-local memory.
 */
export class KnowledgeTransfer {
  private static readonly SNAPSHOT_PATH = "knowledge-transfer/snapshot.json";

  private readonly detectDeps: DetectDeps;
  private readonly applyDeps: ApplyDeps;
  private readonly metaDeps: MetaDeps;

  private readonly transferTrust: TransferTrustManager;

  /** In-memory candidate store: candidate_id → TransferCandidate */
  private readonly candidates: Map<string, TransferCandidate> = new Map();

  /** In-memory result store: transfer_id → TransferResult */
  private readonly results: Map<string, TransferResult> = new Map();

  /** Context stored at apply time: transfer_id → TransferContext */
  private readonly applyContexts: Map<string, TransferContext> = new Map();

  /** Effectiveness records: transfer_id → TransferEffectivenessRecord */
  private readonly effectivenessRecords: Map<string, TransferEffectivenessRecord> = new Map();

  /** Per-pattern consecutive non-positive outcome tracker */
  private readonly patternTrackers: Map<string, PatternEffectivenessTracker> = new Map();

  /** Cross-goal pattern store: pattern id → CrossGoalPattern */
  private readonly crossGoalPatterns: Map<string, CrossGoalPattern> = new Map();

  /** Timestamp of last incremental meta-pattern aggregation (ISO string) */
  private lastAggregatedAt: string | null = null;

  private snapshotLoaded = false;
  private snapshotLoadPromise: Promise<void> | null = null;

  constructor(deps: {
    llmClient: ILLMClient;
    knowledgeManager: KnowledgeManager;
    vectorIndex: VectorIndex | null;
    learningPipeline: LearningPipeline;
    ethicsGate: EthicsGate;
    stateManager: StateManager;
    transferTrust?: TransferTrustManager;
    gateway?: IPromptGateway;
  }) {
    this.transferTrust =
      deps.transferTrust ??
      new TransferTrustManager({ stateManager: deps.stateManager });

    this.detectDeps = {
      stateManager: deps.stateManager,
      learningPipeline: deps.learningPipeline,
      vectorIndex: deps.vectorIndex,
      knowledgeManager: deps.knowledgeManager,
      transferTrust: this.transferTrust,
    };

    this.applyDeps = {
      llmClient: deps.llmClient,
      learningPipeline: deps.learningPipeline,
      ethicsGate: deps.ethicsGate,
      stateManager: deps.stateManager,
      transferTrust: this.transferTrust,
      gateway: deps.gateway,
    };

    this.metaDeps = {
      llmClient: deps.llmClient,
      learningPipeline: deps.learningPipeline,
      vectorIndex: deps.vectorIndex,
      stateManager: deps.stateManager,
      gateway: deps.gateway,
    };
  }

  // ─── Detect ───

  async detectTransferOpportunities(goalId: string): Promise<TransferCandidate[]> {
    await this.ensureSnapshotLoaded();
    const result = await detectTransferOpportunities(goalId, this.detectDeps, this.candidates, this.patternTrackers);
    await this.persistSnapshot();
    return result;
  }

  // ─── Apply ───

  async applyTransfer(candidateId: string, targetGoalId: string): Promise<TransferResult> {
    await this.ensureSnapshotLoaded();
    const result = await applyTransfer(candidateId, targetGoalId, this.applyDeps, this.candidates, this.results, this.applyContexts);
    await this.persistSnapshot();
    return result;
  }

  async autoApplyHighConfidenceTransfers(goalId: string): Promise<TransferCandidate[]> {
    await this.ensureSnapshotLoaded();
    const result = await autoApplyHighConfidenceTransfers(goalId, this.applyDeps, this.detectDeps, this.candidates, this.results, this.applyContexts, this.patternTrackers);
    await this.persistSnapshot();
    return result;
  }

  async detectCandidatesRealtime(goalId: string): Promise<{ candidates: TransferCandidate[]; contextSnippets: string[] }> {
    await this.ensureSnapshotLoaded();
    const result = await detectCandidatesRealtime(goalId, this.detectDeps, this.candidates, this.patternTrackers);
    await this.persistSnapshot();
    return result;
  }

  // ─── Evaluate ───

  async evaluateTransferEffect(transferId: string): Promise<TransferEffectivenessRecord> {
    await this.ensureSnapshotLoaded();
    const result = await evaluateTransferEffect(transferId, this.applyDeps.stateManager, this.transferTrust, this.results, this.applyContexts, this.effectivenessRecords, this.candidates, this.patternTrackers);
    await this.persistSnapshot();
    return result;
  }

  // ─── Meta ───

  async buildCrossGoalKnowledgeBase(): Promise<void> {
    return buildCrossGoalKnowledgeBase(this.metaDeps);
  }

  async updateMetaPatternsIncremental(): Promise<number> {
    return updateMetaPatternsIncremental(
      this.metaDeps,
      () => this._loadLastAggregatedAt(),
      (ts) => this._saveLastAggregatedAt(ts)
    );
  }

  // ─── Cross-Goal Pattern Storage ───

  storePattern(pattern: CrossGoalPattern): void {
    storePattern(pattern, this.crossGoalPatterns, this.metaDeps.vectorIndex);
  }

  retrievePatterns(filter?: {
    feedbackType?: StructuralFeedbackType;
    patternType?: CrossGoalPattern["patternType"];
  }): CrossGoalPattern[] {
    return retrievePatterns(this.crossGoalPatterns, filter);
  }

  // ─── Accessors ───

  getTransferCandidates(): TransferCandidate[] {
    return Array.from(this.candidates.values());
  }

  getTransferResults(): TransferResult[] {
    return Array.from(this.results.values());
  }

  getEffectivenessRecords(): TransferEffectivenessRecord[] {
    return getEffectivenessRecords(this.effectivenessRecords);
  }

  async listTransferSnapshot(): Promise<{
    transfers: TransferCandidate[];
    results: TransferResult[];
    effectiveness_records: TransferEffectivenessRecord[];
  }> {
    await this.ensureSnapshotLoaded();
    return this.buildTransferSnapshot();
  }

  getAppliedTransferCount(): number {
    return getAppliedTransferCount(this.candidates);
  }

  getTransferSuccessRate(): { total: number; positive: number; negative: number; neutral: number; rate: number } {
    return getTransferSuccessRate(this.effectivenessRecords);
  }

  // ─── Private Persistence Helpers ───

  private static readonly SnapshotSchema = z.object({
    transfers: z.array(TransferCandidateSchema).default([]),
    results: z.array(TransferResultSchema).default([]),
    effectiveness_records: z.array(TransferEffectivenessSchema).default([]),
    apply_contexts: z.record(
      z.string(),
      z.object({
        candidate: TransferCandidateSchema,
        gap_at_apply: z.number(),
        source_pattern: LearnedPatternSchema.nullable(),
      })
    ).default({}),
    pattern_trackers: z.record(
      z.string(),
      z.object({
        consecutive_non_positive: z.number().int().min(0),
        invalidated: z.boolean(),
      })
    ).default({}),
  });

  private buildTransferSnapshot(): {
    transfers: TransferCandidate[];
    results: TransferResult[];
    effectiveness_records: TransferEffectivenessRecord[];
  } {
    return {
      transfers: Array.from(this.candidates.values()),
      results: Array.from(this.results.values()),
      effectiveness_records: getEffectivenessRecords(this.effectivenessRecords),
    };
  }

  private async ensureSnapshotLoaded(): Promise<void> {
    if (this.snapshotLoaded) {
      return;
    }
    if (!this.snapshotLoadPromise) {
      this.snapshotLoadPromise = this.loadSnapshot();
    }
    await this.snapshotLoadPromise;
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const raw = await this.applyDeps.stateManager.readRaw(KnowledgeTransfer.SNAPSHOT_PATH);
      if (raw && typeof raw === "object") {
        const snapshot = KnowledgeTransfer.SnapshotSchema.parse(raw);
        this.candidates.clear();
        for (const candidate of snapshot.transfers) {
          this.candidates.set(candidate.candidate_id, candidate);
        }
        this.results.clear();
        for (const result of snapshot.results) {
          this.results.set(result.transfer_id, result);
        }
        this.effectivenessRecords.clear();
        for (const record of snapshot.effectiveness_records) {
          this.effectivenessRecords.set(record.transfer_id, record);
        }
        this.applyContexts.clear();
        for (const [transferId, context] of Object.entries(snapshot.apply_contexts)) {
          this.applyContexts.set(transferId, context);
        }
        this.patternTrackers.clear();
        for (const [patternId, tracker] of Object.entries(snapshot.pattern_trackers)) {
          this.patternTrackers.set(patternId, tracker);
        }
      }
    } catch {
      // non-fatal: start from an empty snapshot
    } finally {
      this.snapshotLoaded = true;
      this.snapshotLoadPromise = null;
    }
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.snapshotLoaded) {
      return;
    }
    const snapshot = {
      ...this.buildTransferSnapshot(),
      apply_contexts: Object.fromEntries(this.applyContexts.entries()),
      pattern_trackers: Object.fromEntries(this.patternTrackers.entries()),
    };
    try {
      await this.applyDeps.stateManager.writeRaw(KnowledgeTransfer.SNAPSHOT_PATH, snapshot);
    } catch {
      // non-fatal: in-memory state remains authoritative for this process
    }
  }

  private async _loadLastAggregatedAt(): Promise<string | null> {
    if (this.lastAggregatedAt !== null) return this.lastAggregatedAt;
    try {
      const data = await this.applyDeps.stateManager.readRaw(
        "meta-patterns/last_aggregated_at.json"
      );
      if (data && typeof data === "object" && "ts" in (data as Record<string, unknown>)) {
        return (data as Record<string, string>).ts;
      }
    } catch {
      // non-fatal
    }
    return null;
  }

  private async _saveLastAggregatedAt(ts: string): Promise<void> {
    try {
      await this.applyDeps.stateManager.writeRaw(
        "meta-patterns/last_aggregated_at.json",
        { ts }
      );
    } catch {
      // non-fatal
    }
    this.lastAggregatedAt = ts;
  }
}
