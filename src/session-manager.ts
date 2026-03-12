import { SessionSchema } from "./types/session.js";
import type { Session, SessionType, ContextSlot } from "./types/session.js";
import type { StateManager } from "./state-manager.js";
import type { KnowledgeEntry } from "./types/knowledge.js";

// ─── Constants ───

export const DEFAULT_CONTEXT_BUDGET = 50_000;

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

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ─── Session Lifecycle ───

  /**
   * Creates a new session of the given type for goalId/taskId.
   * Context slots are built based on session type using fixed MVP templates.
   */
  createSession(
    sessionType: SessionType,
    goalId: string,
    taskId: string | null,
    contextBudget: number = DEFAULT_CONTEXT_BUDGET
  ): Session {
    const sessionId = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();

    const contextSlots = this.buildContextForType(
      sessionType,
      goalId,
      taskId
    );

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

    this.persistSession(session);
    return session;
  }

  /**
   * Marks a session as completed and records the result summary.
   */
  endSession(sessionId: string, resultSummary: string): void {
    const session = this.getSession(sessionId);
    if (session === null) {
      throw new Error(`SessionManager.endSession: session "${sessionId}" not found`);
    }

    const updated: Session = SessionSchema.parse({
      ...session,
      ended_at: new Date().toISOString(),
      result_summary: resultSummary,
    });

    this.persistSession(updated);
  }

  /**
   * Returns a session by ID, or null if not found.
   */
  getSession(sessionId: string): Session | null {
    const raw = this.stateManager.readRaw(`sessions/${sessionId}.json`);
    if (raw === null) return null;
    return SessionSchema.parse(raw);
  }

  /**
   * Returns all active (not yet ended) sessions for a given goal.
   * Note: MVP scans all sessions matching goalId with status="active".
   * This reads the session index; sessions without ended_at are active.
   */
  getActiveSessions(goalId: string): Session[] {
    const index = this.loadSessionIndex();
    const sessions: Session[] = [];

    for (const sessionId of index) {
      const session = this.getSession(sessionId);
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

  /**
   * Inject relevant KnowledgeEntry items into an existing set of context slots.
   *
   * Each non-superseded entry is formatted as structured text and appended as
   * a new low-priority context slot (`domain_knowledge`). Empty entry arrays
   * are a no-op — the original slots are returned unchanged.
   */
  injectKnowledgeContext(
    slots: ContextSlot[],
    entries: KnowledgeEntry[]
  ): ContextSlot[] {
    const activeEntries = entries.filter((e) => e.superseded_by === null);
    if (activeEntries.length === 0) return slots;

    const content = activeEntries
      .map(
        (e) =>
          `[Knowledge] Q: ${e.question}\nA: ${e.answer} (confidence: ${e.confidence})`
      )
      .join("\n\n");

    const maxPriority = slots.reduce(
      (max, s) => (s.priority > max ? s.priority : max),
      0
    );

    const knowledgeSlot: ContextSlot = {
      priority: maxPriority + 1,
      label: "domain_knowledge",
      content,
      token_estimate: 0,
    };

    return [...slots, knowledgeSlot];
  }

  // ─── Private Helpers ───

  private buildContextForType(
    sessionType: SessionType,
    goalId: string,
    taskId: string | null
  ): ContextSlot[] {
    switch (sessionType) {
      case "task_execution":
        return this.buildTaskExecutionContext(goalId, taskId ?? "");
      case "observation":
        return this.buildObservationContext(goalId, []);
      case "task_review":
        return this.buildTaskReviewContext(goalId, taskId ?? "");
      case "goal_review":
        return this.buildGoalReviewContext(goalId);
    }
  }

  private persistSession(session: Session): void {
    this.stateManager.writeRaw(`sessions/${session.id}.json`, session);
    this.updateSessionIndex(session.id);
  }

  /** Loads the session index (list of all session IDs). */
  private loadSessionIndex(): string[] {
    const raw = this.stateManager.readRaw("sessions/index.json");
    if (raw === null) return [];
    return raw as string[];
  }

  /** Adds a session ID to the index if not already present. */
  private updateSessionIndex(sessionId: string): void {
    const index = this.loadSessionIndex();
    if (!index.includes(sessionId)) {
      index.push(sessionId);
      this.stateManager.writeRaw("sessions/index.json", index);
    }
  }
}
