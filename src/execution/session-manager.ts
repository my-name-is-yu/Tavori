import { randomUUID } from "node:crypto";
import { SessionSchema } from "../types/session.js";
import type { Session, SessionType, ContextSlot } from "../types/session.js";
import type { StateManager } from "../state/state-manager.js";
import type { KnowledgeEntry } from "../types/knowledge.js";
import type { VectorIndex } from "../knowledge/vector-index.js";
import type { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import { CheckpointManager } from './checkpoint-manager.js';
import type { Checkpoint } from '../types/checkpoint.js';
import {
  estimateTokens as _estimateTokens,
  compressSlot as _compressSlot,
  filterSlotsByBudget as _filterSlotsByBudget,
  injectKnowledgeContext as _injectKnowledgeContext,
  injectSemanticKnowledgeContext as _injectSemanticKnowledgeContext,
  injectLearningFeedback as _injectLearningFeedback,
  DEFAULT_CONTEXT_BUDGET,
} from './context/context-builder.js';

// ─── Types ───

export interface ContextBudget {
  totalTokens: number;
  usedTokens: number;
  remaining: number;
}

export { DEFAULT_CONTEXT_BUDGET };

// ─── SessionManager ───

/**
 * SessionManager creates and manages the 4 session types
 * (task_execution, observation, task_review, goal_review).
 *
 * MVP: Fixed priority-1–4 context templates per session type.
 * Context isolation is enforced: each session type receives only
 * what it needs to prevent bias (e.g., observation sessions never
 * receive task execution details; task review sessions never receive
 * the executor's self-report).
 *
 * Persistence: sessions/<session_id>.json via StateManager readRaw/writeRaw.
 */
export class SessionManager {
  private readonly stateManager: StateManager;
  private readonly dependencyGraph?: GoalDependencyGraph;
  private checkpointManager?: CheckpointManager;

  constructor(stateManager: StateManager, dependencyGraph?: GoalDependencyGraph) {
    this.stateManager = stateManager;
    this.dependencyGraph = dependencyGraph;
  }

  setCheckpointManager(cm: CheckpointManager): void {
    this.checkpointManager = cm;
  }

  // ─── Token Estimation ───

  /** Estimates token count for a string. */
  estimateTokens(text: string): number {
    return _estimateTokens(text);
  }

  /** Compresses a context slot to fit within maxTokens. */
  compressSlot(slot: ContextSlot, maxTokens: number): ContextSlot {
    return _compressSlot(slot, maxTokens);
  }

  // ─── Session Lifecycle ───

  /**
   * Creates a new session of the given type for goalId/taskId.
   * Context slots are built based on session type using fixed MVP templates.
   */
  async createSession(
    sessionType: SessionType,
    goalId: string,
    taskId: string | null,
    contextBudget: number = DEFAULT_CONTEXT_BUDGET
  ): Promise<Session> {
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const contextSlots = this.dependencyGraph
      ? this.buildContextWithConflictAwareness(goalId, sessionType, {
          tokenBudget: contextBudget,
          taskId,
        })
      : this.buildContextForType(sessionType, goalId, taskId, contextBudget);

    const session: Session = SessionSchema.parse({
      id: sessionId,
      session_type: sessionType,
      goal_id: goalId,
      task_id: taskId,
      context_slots: contextSlots,
      context_budget: contextBudget,
      started_at: now,
      ended_at: null,
      result_summary: null,
    });

    await this.persistSession(session);
    return session;
  }

  /**
   * Marks a session as completed and records the result summary.
   */
  async endSession(sessionId: string, resultSummary: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session === null) {
      throw new Error(`SessionManager.endSession: session "${sessionId}" not found`);
    }

    const updated: Session = SessionSchema.parse({
      ...session,
      ended_at: new Date().toISOString(),
      result_summary: resultSummary,
    });

    await this.persistSession(updated);
  }

  /**
   * Returns a session by ID, or null if not found.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const raw = await this.stateManager.readRaw(`sessions/${sessionId}.json`);
    if (raw === null) return null;
    return SessionSchema.parse(raw);
  }

  /**
   * Returns all active (not yet ended) sessions for a given goal.
   * Note: MVP scans all sessions matching goalId with status="active".
   * This reads the session index; sessions without ended_at are active.
   */
  async getActiveSessions(goalId: string): Promise<Session[]> {
    const index = await this.loadSessionIndex();
    const sessions: Session[] = [];

    for (const sessionId of index) {
      const session = await this.getSession(sessionId);
      if (
        session !== null &&
        session.goal_id === goalId &&
        session.ended_at === null
      ) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  // ─── Context Building ───

  /**
   * Builds context slots for task execution sessions.
   *
   * Priority assignments:
   *   p1 — task definition and success criteria
   *   p2 — target dimension current state
   *   p3 — recent observation summary
   *   p4 — constraints
   *
   * Excluded: goal history, other goals, strategic background
   */
  buildTaskExecutionContext(
    goalId: string,
    taskId: string,
    isRetry: boolean = false
  ): ContextSlot[] {
    const slots: ContextSlot[] = [
      {
        priority: 1,
        label: "task_definition_and_success_criteria",
        content: `goal_id:${goalId} task_id:${taskId}`,
        token_estimate: 0,
      },
      {
        priority: 2,
        label: "target_dimension_current_state",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
      {
        priority: 3,
        label: "recent_observation_summary",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
      {
        priority: 4,
        label: "constraints",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
    ];

    if (isRetry) {
      slots.push({
        priority: 5,
        label: "previous_attempt_result",
        content: `goal_id:${goalId} task_id:${taskId} retry:true`,
        token_estimate: 0,
      });
    }

    return slots;
  }

  /**
   * Builds context slots for observation sessions.
   *
   * Priority assignments:
   *   p1 — goal definition and dimension definitions
   *   p2 — observation methods
   *   p3 — previous observation results
   *   p4 — constraints
   *
   * Excluded: task details, execution session content (bias prevention)
   */
  buildObservationContext(
    goalId: string,
    dimensionNames: string[]
  ): ContextSlot[] {
    return [
      {
        priority: 1,
        label: "goal_and_dimension_definitions",
        content: `goal_id:${goalId} dimensions:${dimensionNames.join(",")}`,
        token_estimate: 0,
      },
      {
        priority: 2,
        label: "observation_methods",
        content: `goal_id:${goalId} dimensions:${dimensionNames.join(",")}`,
        token_estimate: 0,
      },
      {
        priority: 3,
        label: "previous_observation_results",
        content: `goal_id:${goalId} dimensions:${dimensionNames.join(",")}`,
        token_estimate: 0,
      },
      {
        priority: 4,
        label: "constraints",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
    ];
  }

  /**
   * Builds context slots for task review sessions.
   *
   * Priority assignments:
   *   p1 — task definition and success criteria
   *   p2 — artifact access information
   *
   * Excluded: goal-level context, task generation background,
   *           executor's self-report (independent judgment must be preserved)
   */
  buildTaskReviewContext(
    goalId: string,
    taskId: string
  ): ContextSlot[] {
    return [
      {
        priority: 1,
        label: "task_definition_and_success_criteria",
        content: `goal_id:${goalId} task_id:${taskId}`,
        token_estimate: 0,
      },
      {
        priority: 2,
        label: "artifact_access_information",
        content: `goal_id:${goalId} task_id:${taskId}`,
        token_estimate: 0,
      },
    ];
  }

  /**
   * Builds context slots for goal review sessions.
   *
   * Priority assignments:
   *   p1 — goal definition (full)
   *   p2 — state vector and recent changes
   *   p3 — achievement thresholds
   *   p4 — (reserved; not used in MVP but slot reserved for consistency)
   *
   * Excluded: individual task execution details, full execution history
   */
  buildGoalReviewContext(goalId: string): ContextSlot[] {
    return [
      {
        priority: 1,
        label: "goal_definition",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
      {
        priority: 2,
        label: "state_vector_and_recent_changes",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
      {
        priority: 3,
        label: "achievement_thresholds",
        content: `goal_id:${goalId}`,
        token_estimate: 0,
      },
    ];
  }

  // ─── Knowledge Context Injection ───

  /** Inject relevant KnowledgeEntry items into an existing set of context slots. */
  injectKnowledgeContext(slots: ContextSlot[], entries: KnowledgeEntry[]): ContextSlot[] {
    return _injectKnowledgeContext(slots, entries);
  }

  /** Phase 2: Inject knowledge context using semantic search. */
  async injectSemanticKnowledgeContext(
    slots: ContextSlot[],
    query: string,
    vectorIndex: VectorIndex | undefined,
    contextBudget: number = DEFAULT_CONTEXT_BUDGET
  ): Promise<ContextSlot[]> {
    return _injectSemanticKnowledgeContext(slots, query, vectorIndex, contextBudget);
  }

  /** Inject learning feedback into context slots. */
  injectLearningFeedback(slots: ContextSlot[], feedback: string[]): ContextSlot[] {
    return _injectLearningFeedback(slots, feedback);
  }

  // ─── Dynamic Budget Filtering ───

  /** Filters context slots to fit within a token budget. */
  filterSlotsByBudget(slots: ContextSlot[], budget: number): ContextSlot[] {
    return _filterSlotsByBudget(slots, budget);
  }

  // ─── Resource Conflict Awareness ───

  /**
   * Reads resource_conflict edges from the dependency graph for goalId.
   * Returns list of conflicting goals and their shared resources (affected_dimensions).
   */
  checkResourceConflicts(goalId: string): { conflictingGoalId: string; sharedResources: string[] }[] {
    if (!this.dependencyGraph) return [];

    const conflictEdges = this.dependencyGraph.getResourceConflicts(goalId);
    return conflictEdges.map((edge) => ({
      conflictingGoalId:
        edge.from_goal_id === goalId ? edge.to_goal_id : edge.from_goal_id,
      sharedResources: edge.affected_dimensions,
    }));
  }

  /**
   * Builds context slots for a given goalId/sessionType, then if a dependency graph
   * is available, inserts a conflict-awareness slot (priority 4.5) describing
   * active resource conflicts and instructing the session to avoid concurrent
   * operations on shared resources.
   *
   * The conflict-awareness slot sits between constraints (p4) and previous session
   * results (p5).
   */
  buildContextWithConflictAwareness(
    goalId: string,
    sessionType: SessionType,
    options?: { tokenBudget?: number; taskId?: string | null }
  ): ContextSlot[] {
    const slots = this.buildContextForType(sessionType, goalId, options?.taskId ?? null);
    const conflicts = this.checkResourceConflicts(goalId);

    if (conflicts.length > 0) {
      const conflictLines = conflicts.map((c) => {
        const resources =
          c.sharedResources.length > 0
            ? c.sharedResources.join(", ")
            : "(unspecified resources)";
        return `- Conflicting goal: ${c.conflictingGoalId} | Shared resources: ${resources}`;
      });

      const conflictContent = [
        "RESOURCE CONFLICT AWARENESS:",
        "The following goals are competing for shared resources with this goal.",
        "Avoid concurrent operations on these shared resources.",
        "",
        ...conflictLines,
      ].join("\n");

      const conflictSlot: ContextSlot = {
        priority: 4.5,
        label: "resource_conflict_awareness",
        content: conflictContent,
        token_estimate: this.estimateTokens(conflictContent),
      };

      const withConflict = [...slots, conflictSlot];

      if (options?.tokenBudget !== undefined) {
        return this.filterSlotsByBudget(withConflict, options.tokenBudget);
      }
      return withConflict;
    }

    if (options?.tokenBudget !== undefined) {
      return this.filterSlotsByBudget(slots, options.tokenBudget);
    }
    return slots;
  }

  // ─── Checkpoint Delegation ───

  async saveCheckpoint(params: {
    goalId: string;
    taskId: string;
    agentId: string;
    sessionContextSnapshot: string;
    intermediateResults?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Checkpoint | null> {
    if (!this.checkpointManager) return null;
    return this.checkpointManager.saveCheckpoint(params);
  }

  async loadCheckpoint(goalId: string, currentAgentId: string, taskId?: string): Promise<{
    checkpoint: Checkpoint;
    adaptedContext: string;
    wasAdapted: boolean;
  } | null> {
    if (!this.checkpointManager) return null;
    return this.checkpointManager.loadAndAdaptCheckpoint(goalId, currentAgentId, taskId);
  }

  async gcCheckpoints(goalId: string, maxAgeDays?: number): Promise<number> {
    if (!this.checkpointManager) return 0;
    return this.checkpointManager.garbageCollect(goalId, maxAgeDays);
  }

  // ─── Private Helpers ───

  private buildContextForType(
    sessionType: SessionType,
    goalId: string,
    taskId: string | null,
    tokenBudget?: number
  ): ContextSlot[] {
    let slots: ContextSlot[];
    switch (sessionType) {
      case "task_execution":
        slots = this.buildTaskExecutionContext(goalId, taskId ?? "");
        break;
      case "observation":
        slots = this.buildObservationContext(goalId, []);
        break;
      case "task_review":
        slots = this.buildTaskReviewContext(goalId, taskId ?? "");
        break;
      case "goal_review":
        slots = this.buildGoalReviewContext(goalId);
        break;
      default:
        slots = [];
        break;
    }

    if (tokenBudget !== undefined) {
      return this.filterSlotsByBudget(slots, tokenBudget);
    }
    return slots;
  }

  private async persistSession(session: Session): Promise<void> {
    await this.stateManager.writeRaw(`sessions/${session.id}.json`, session);
    await this.updateSessionIndex(session.id);
  }

  /** Loads the session index (list of all session IDs). */
  private async loadSessionIndex(): Promise<string[]> {
    const raw = await this.stateManager.readRaw("sessions/index.json");
    if (raw === null) return [];
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === "string");
  }

  /** Adds a session ID to the index if not already present. */
  private async updateSessionIndex(sessionId: string): Promise<void> {
    const index = await this.loadSessionIndex();
    if (!index.includes(sessionId)) {
      index.push(sessionId);
      await this.stateManager.writeRaw("sessions/index.json", index);
    }
  }
}
