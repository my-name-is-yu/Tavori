import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state-manager.js";
import { SessionManager, DEFAULT_CONTEXT_BUDGET } from "../src/execution/session-manager.js";
import { CheckpointManager } from "../src/execution/checkpoint-manager.js";
import type { Session } from "../src/types/session.js";
import type { KnowledgeEntry } from "../src/types/knowledge.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { randomUUID } from "node:crypto";

// ─── Tests ───

describe("SessionManager", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    manager = new SessionManager(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── createSession ───

  describe("createSession", () => {
    it("creates a task_execution session with correct shape", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      expect(session.session_type).toBe("task_execution");
      expect(session.goal_id).toBe("goal-1");
      expect(session.task_id).toBe("task-1");
      expect(session.ended_at).toBeNull();
      expect(session.result_summary).toBeNull();
      expect(session.context_budget).toBe(DEFAULT_CONTEXT_BUDGET);
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
    });

    it("creates an observation session with null taskId", async () => {
      const session = await manager.createSession("observation", "goal-2", null);
      expect(session.session_type).toBe("observation");
      expect(session.goal_id).toBe("goal-2");
      expect(session.task_id).toBeNull();
    });

    it("creates a task_review session", async () => {
      const session = await manager.createSession("task_review", "goal-3", "task-3");
      expect(session.session_type).toBe("task_review");
    });

    it("creates a goal_review session with null taskId", async () => {
      const session = await manager.createSession("goal_review", "goal-4", null);
      expect(session.session_type).toBe("goal_review");
      expect(session.task_id).toBeNull();
    });

    it("respects custom contextBudget", async () => {
      const session = await manager.createSession("goal_review", "goal-5", null, 10_000);
      expect(session.context_budget).toBe(10_000);
    });

    it("sets started_at to a valid ISO timestamp", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      const date = new Date(session.started_at);
      expect(isNaN(date.getTime())).toBe(false);
    });

    it("generates unique IDs for each session", async () => {
      const s1 = await manager.createSession("task_execution", "goal-1", "task-1");
      const s2 = await manager.createSession("task_execution", "goal-1", "task-1");
      expect(s1.id).not.toBe(s2.id);
    });

    it("persists session to sessions/<session_id>.json", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      const filePath = path.join(tmpDir, "sessions", `${session.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("task_execution session includes 4 context slots", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      expect(session.context_slots).toHaveLength(4);
    });

    it("observation session includes 4 context slots", async () => {
      const session = await manager.createSession("observation", "goal-1", null);
      expect(session.context_slots).toHaveLength(4);
    });

    it("task_review session includes 2 context slots", async () => {
      const session = await manager.createSession("task_review", "goal-1", "task-1");
      expect(session.context_slots).toHaveLength(2);
    });

    it("goal_review session includes 3 context slots", async () => {
      const session = await manager.createSession("goal_review", "goal-1", null);
      expect(session.context_slots).toHaveLength(3);
    });
  });

  // ─── buildTaskExecutionContext ───

  describe("buildTaskExecutionContext", () => {
    it("returns slots with priorities 1–4", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const priorities = slots.map((s) => s.priority).sort((a, b) => a - b);
      expect(priorities).toEqual([1, 2, 3, 4]);
    });

    it("p1 slot is task_definition_and_success_criteria", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const p1 = slots.find((s) => s.priority === 1);
      expect(p1?.label).toBe("task_definition_and_success_criteria");
    });

    it("p2 slot is target_dimension_current_state", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const p2 = slots.find((s) => s.priority === 2);
      expect(p2?.label).toBe("target_dimension_current_state");
    });

    it("p3 slot is recent_observation_summary", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const p3 = slots.find((s) => s.priority === 3);
      expect(p3?.label).toBe("recent_observation_summary");
    });

    it("p4 slot is constraints", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const p4 = slots.find((s) => s.priority === 4);
      expect(p4?.label).toBe("constraints");
    });

    it("does NOT include goal history or strategic background slots", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("goal_history");
      expect(labels).not.toContain("strategic_background");
      expect(labels).not.toContain("other_goals");
    });

    it("adds priority-5 slot for retry", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1", true);
      const p5 = slots.find((s) => s.priority === 5);
      expect(p5?.label).toBe("previous_attempt_result");
    });

    it("does NOT add priority-5 slot when isRetry=false", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1", false);
      expect(slots.find((s) => s.priority === 5)).toBeUndefined();
    });

    it("does NOT add priority-5 slot by default (isRetry omitted)", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      expect(slots.find((s) => s.priority === 5)).toBeUndefined();
    });

    it("slots include goalId and taskId in content", () => {
      const slots = manager.buildTaskExecutionContext("goal-abc", "task-xyz");
      const p1 = slots.find((s) => s.priority === 1)!;
      expect(p1.content).toContain("goal-abc");
      expect(p1.content).toContain("task-xyz");
    });
  });

  // ─── buildObservationContext ───

  describe("buildObservationContext", () => {
    it("returns slots with priorities 1–4", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a", "dim_b"]);
      const priorities = slots.map((s) => s.priority).sort((a, b) => a - b);
      expect(priorities).toEqual([1, 2, 3, 4]);
    });

    it("p1 slot is goal_and_dimension_definitions", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const p1 = slots.find((s) => s.priority === 1);
      expect(p1?.label).toBe("goal_and_dimension_definitions");
    });

    it("p2 slot is observation_methods", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const p2 = slots.find((s) => s.priority === 2);
      expect(p2?.label).toBe("observation_methods");
    });

    it("p3 slot is previous_observation_results", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const p3 = slots.find((s) => s.priority === 3);
      expect(p3?.label).toBe("previous_observation_results");
    });

    it("p4 slot is constraints", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const p4 = slots.find((s) => s.priority === 4);
      expect(p4?.label).toBe("constraints");
    });

    it("does NOT contain task execution details (bias prevention)", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("task_definition_and_success_criteria");
      expect(labels).not.toContain("previous_attempt_result");
      expect(labels).not.toContain("artifact_access_information");
    });

    it("encodes dimension names into slot content", () => {
      const slots = manager.buildObservationContext("goal-1", ["coverage", "latency"]);
      const p1 = slots.find((s) => s.priority === 1)!;
      expect(p1.content).toContain("coverage");
      expect(p1.content).toContain("latency");
    });

    it("handles empty dimension list", () => {
      const slots = manager.buildObservationContext("goal-1", []);
      expect(slots).toHaveLength(4);
    });
  });

  // ─── buildTaskReviewContext ───

  describe("buildTaskReviewContext", () => {
    it("returns slots with priorities 1 and 2", () => {
      const slots = manager.buildTaskReviewContext("goal-1", "task-1");
      const priorities = slots.map((s) => s.priority).sort((a, b) => a - b);
      expect(priorities).toEqual([1, 2]);
    });

    it("p1 slot is task_definition_and_success_criteria", () => {
      const slots = manager.buildTaskReviewContext("goal-1", "task-1");
      const p1 = slots.find((s) => s.priority === 1);
      expect(p1?.label).toBe("task_definition_and_success_criteria");
    });

    it("p2 slot is artifact_access_information", () => {
      const slots = manager.buildTaskReviewContext("goal-1", "task-1");
      const p2 = slots.find((s) => s.priority === 2);
      expect(p2?.label).toBe("artifact_access_information");
    });

    it("does NOT contain executor self-report (independent judgment)", () => {
      const slots = manager.buildTaskReviewContext("goal-1", "task-1");
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("executor_self_report");
      expect(labels).not.toContain("self_report");
      expect(labels).not.toContain("task_generation_background");
    });

    it("does NOT contain goal-level context", () => {
      const slots = manager.buildTaskReviewContext("goal-1", "task-1");
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("goal_definition");
      expect(labels).not.toContain("state_vector_and_recent_changes");
    });

    it("slots include goalId and taskId in content", () => {
      const slots = manager.buildTaskReviewContext("goal-xyz", "task-abc");
      const p1 = slots.find((s) => s.priority === 1)!;
      expect(p1.content).toContain("goal-xyz");
      expect(p1.content).toContain("task-abc");
    });
  });

  // ─── buildGoalReviewContext ───

  describe("buildGoalReviewContext", () => {
    it("returns slots with priorities 1–3", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const priorities = slots.map((s) => s.priority).sort((a, b) => a - b);
      expect(priorities).toEqual([1, 2, 3]);
    });

    it("p1 slot is goal_definition", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const p1 = slots.find((s) => s.priority === 1);
      expect(p1?.label).toBe("goal_definition");
    });

    it("p2 slot is state_vector_and_recent_changes", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const p2 = slots.find((s) => s.priority === 2);
      expect(p2?.label).toBe("state_vector_and_recent_changes");
    });

    it("p3 slot is achievement_thresholds", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const p3 = slots.find((s) => s.priority === 3);
      expect(p3?.label).toBe("achievement_thresholds");
    });

    it("does NOT contain individual task execution details", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("task_definition_and_success_criteria");
      expect(labels).not.toContain("artifact_access_information");
      expect(labels).not.toContain("previous_attempt_result");
    });

    it("does NOT contain full execution history", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("full_execution_history");
    });

    it("slots include goalId in content", () => {
      const slots = manager.buildGoalReviewContext("goal-unique");
      slots.forEach((slot) => {
        expect(slot.content).toContain("goal-unique");
      });
    });
  });

  // ─── endSession ───

  describe("endSession", () => {
    it("sets ended_at on the session", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      await manager.endSession(session.id, "task completed successfully");
      const updated = (await manager.getSession(session.id))!;
      expect(updated.ended_at).not.toBeNull();
    });

    it("sets result_summary on the session", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      await manager.endSession(session.id, "coverage improved to 85%");
      const updated = (await manager.getSession(session.id))!;
      expect(updated.result_summary).toBe("coverage improved to 85%");
    });

    it("ended_at is a valid ISO timestamp", async () => {
      const session = await manager.createSession("goal_review", "goal-1", null);
      await manager.endSession(session.id, "review done");
      const updated = (await manager.getSession(session.id))!;
      const date = new Date(updated.ended_at!);
      expect(isNaN(date.getTime())).toBe(false);
    });

    it("persists the updated session to disk", async () => {
      const session = await manager.createSession("observation", "goal-1", null);
      await manager.endSession(session.id, "observed");

      // Load via a fresh manager to confirm disk persistence
      const manager2 = new SessionManager(stateManager);
      const loaded = (await manager2.getSession(session.id))!;
      expect(loaded.result_summary).toBe("observed");
      expect(loaded.ended_at).not.toBeNull();
    });

    it("throws if session does not exist", async () => {
      await expect(manager.endSession("nonexistent-id", "done")).rejects.toThrow();
    });

    it("does not change other session fields after endSession", async () => {
      const session = await manager.createSession("task_review", "goal-1", "task-1");
      await manager.endSession(session.id, "review complete");
      const updated = (await manager.getSession(session.id))!;
      expect(updated.session_type).toBe("task_review");
      expect(updated.goal_id).toBe("goal-1");
      expect(updated.task_id).toBe("task-1");
      expect(updated.context_budget).toBe(DEFAULT_CONTEXT_BUDGET);
    });
  });

  // ─── getSession ───

  describe("getSession", () => {
    it("returns null for a non-existent session ID", async () => {
      const result = await manager.getSession("does-not-exist");
      expect(result).toBeNull();
    });

    it("returns the session for a valid session ID", async () => {
      const session = await manager.createSession("task_execution", "goal-1", "task-1");
      const loaded = await manager.getSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(session.id);
    });

    it("returns the session from a fresh manager (disk persistence)", async () => {
      const session = await manager.createSession("observation", "goal-2", null);
      const manager2 = new SessionManager(stateManager);
      const loaded = await manager2.getSession(session.id);
      expect(loaded!.id).toBe(session.id);
      expect(loaded!.goal_id).toBe("goal-2");
    });
  });

  // ─── getActiveSessions ───

  describe("getActiveSessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await manager.getActiveSessions("goal-1");
      expect(sessions).toHaveLength(0);
    });

    it("returns active sessions for a goal", async () => {
      await manager.createSession("task_execution", "goal-1", "task-1");
      await manager.createSession("observation", "goal-1", null);
      const sessions = await manager.getActiveSessions("goal-1");
      expect(sessions).toHaveLength(2);
    });

    it("filters out ended sessions", async () => {
      const s1 = await manager.createSession("task_execution", "goal-1", "task-1");
      await manager.createSession("observation", "goal-1", null);
      await manager.endSession(s1.id, "done");
      const sessions = await manager.getActiveSessions("goal-1");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].session_type).toBe("observation");
    });

    it("does not include sessions from other goals", async () => {
      await manager.createSession("task_execution", "goal-A", "task-1");
      await manager.createSession("observation", "goal-B", null);
      const sessionsA = await manager.getActiveSessions("goal-A");
      const sessionsB = await manager.getActiveSessions("goal-B");
      expect(sessionsA).toHaveLength(1);
      expect(sessionsB).toHaveLength(1);
      expect(sessionsA[0].goal_id).toBe("goal-A");
      expect(sessionsB[0].goal_id).toBe("goal-B");
    });

    it("returns empty array when all sessions for goal are ended", async () => {
      const s1 = await manager.createSession("task_execution", "goal-1", "task-1");
      await manager.endSession(s1.id, "done");
      const sessions = await manager.getActiveSessions("goal-1");
      expect(sessions).toHaveLength(0);
    });

    it("each returned session has correct goal_id", async () => {
      await manager.createSession("task_execution", "goal-X", "task-1");
      await manager.createSession("goal_review", "goal-X", null);
      const sessions = await manager.getActiveSessions("goal-X");
      for (const s of sessions) {
        expect(s.goal_id).toBe("goal-X");
      }
    });
  });

  // ─── injectKnowledgeContext ───

  describe("injectKnowledgeContext", () => {
    function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
      const now = new Date().toISOString();
      return {
        entry_id: randomUUID(),
        question: "What is the test framework?",
        answer: "Vitest",
        sources: [],
        confidence: 0.9,
        acquired_at: now,
        acquisition_task_id: "task-k1",
        superseded_by: null,
        tags: ["testing"],
        ...overrides,
      };
    }

    it("returns slots unchanged when entries array is empty", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const original = slots.length;
      const result = manager.injectKnowledgeContext(slots, []);
      expect(result).toHaveLength(original);
    });

    it("adds a domain_knowledge slot when entries are provided", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const entry = makeKnowledgeEntry();
      const result = manager.injectKnowledgeContext(slots, [entry]);
      const knowledgeSlot = result.find((s) => s.label === "domain_knowledge");
      expect(knowledgeSlot).toBeDefined();
    });

    it("knowledge slot has priority higher than all existing slots", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const entry = makeKnowledgeEntry();
      const result = manager.injectKnowledgeContext(slots, [entry]);
      const maxExisting = slots.reduce((m, s) => Math.max(m, s.priority), 0);
      const knowledgeSlot = result.find((s) => s.label === "domain_knowledge")!;
      expect(knowledgeSlot.priority).toBeGreaterThan(maxExisting);
    });

    it("knowledge slot content contains question and answer", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const entry = makeKnowledgeEntry({
        question: "What language is used?",
        answer: "TypeScript",
      });
      const result = manager.injectKnowledgeContext(slots, [entry]);
      const knowledgeSlot = result.find((s) => s.label === "domain_knowledge")!;
      expect(knowledgeSlot.content).toContain("What language is used?");
      expect(knowledgeSlot.content).toContain("TypeScript");
    });

    it("superseded entries are excluded from knowledge slot", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const active = makeKnowledgeEntry({ question: "Active entry?", answer: "Yes" });
      const superseded = makeKnowledgeEntry({
        question: "Old entry?",
        answer: "Old answer",
        superseded_by: "newer-entry-id",
      });
      const result = manager.injectKnowledgeContext(slots, [active, superseded]);
      const knowledgeSlot = result.find((s) => s.label === "domain_knowledge")!;
      expect(knowledgeSlot.content).toContain("Active entry?");
      expect(knowledgeSlot.content).not.toContain("Old entry?");
    });
  });

  // ─── filterSlotsByBudget ───

  describe("dynamic budget filtering", () => {
    it("returns all slots when budget is large enough to fit everything", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const result = manager.filterSlotsByBudget(slots, 1_000_000);
      expect(result).toHaveLength(slots.length);
    });

    it("drops lower-priority slots when budget is tight", () => {
      const slots: import("../src/types/session.js").ContextSlot[] = [
        { priority: 1, label: "slot-A", content: "a".repeat(400), token_estimate: 100 },
        { priority: 2, label: "slot-B", content: "b".repeat(400), token_estimate: 100 },
        { priority: 3, label: "slot-C", content: "c".repeat(400), token_estimate: 100 },
        { priority: 4, label: "slot-D", content: "d".repeat(400), token_estimate: 100 },
      ];
      // Budget fits only 2 slots (200 tokens)
      const result = manager.filterSlotsByBudget(slots, 200);
      expect(result).toHaveLength(2);
      const labels = result.map((s) => s.label);
      expect(labels).toContain("slot-A");
      expect(labels).toContain("slot-B");
      expect(labels).not.toContain("slot-C");
      expect(labels).not.toContain("slot-D");
    });

    it("keeps higher-priority slots over lower-priority slots", () => {
      const slots: import("../src/types/session.js").ContextSlot[] = [
        { priority: 5, label: "low-priority", content: "x".repeat(400), token_estimate: 100 },
        { priority: 1, label: "high-priority", content: "y".repeat(400), token_estimate: 100 },
      ];
      const result = manager.filterSlotsByBudget(slots, 100);
      expect(result).toHaveLength(1);
      expect(result[0]?.label).toBe("high-priority");
    });

    it("returns empty array when budget is zero", () => {
      const slots: import("../src/types/session.js").ContextSlot[] = [
        { priority: 1, label: "slot-A", content: "content", token_estimate: 10 },
      ];
      const result = manager.filterSlotsByBudget(slots, 0);
      expect(result).toHaveLength(0);
    });

    it("returns empty array when input is empty", () => {
      const result = manager.filterSlotsByBudget([], 50_000);
      expect(result).toHaveLength(0);
    });

    it("uses content.length / 4 to estimate tokens when token_estimate is 0", () => {
      // 400 chars / 4 = 100 token estimate
      const slots: import("../src/types/session.js").ContextSlot[] = [
        { priority: 1, label: "slot-A", content: "a".repeat(400), token_estimate: 0 },
        { priority: 2, label: "slot-B", content: "b".repeat(400), token_estimate: 0 },
        { priority: 3, label: "slot-C", content: "c".repeat(400), token_estimate: 0 },
      ];
      // Budget = 250 tokens → fits slot-A (100) + slot-B (100), total 200 ≤ 250; slot-C pushes to 300 > 250
      const result = manager.filterSlotsByBudget(slots, 250);
      expect(result).toHaveLength(2);
      const labels = result.map((s) => s.label);
      expect(labels).toContain("slot-A");
      expect(labels).toContain("slot-B");
      expect(labels).not.toContain("slot-C");
    });

    it("fits exactly at budget boundary", () => {
      const slots: import("../src/types/session.js").ContextSlot[] = [
        { priority: 1, label: "slot-A", content: "a", token_estimate: 50 },
        { priority: 2, label: "slot-B", content: "b", token_estimate: 50 },
      ];
      // Budget = 100 exactly fits both slots
      const result = manager.filterSlotsByBudget(slots, 100);
      expect(result).toHaveLength(2);
    });

    it("DEFAULT_CONTEXT_BUDGET is large enough for all standard slots", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const result = manager.filterSlotsByBudget(slots, DEFAULT_CONTEXT_BUDGET);
      // All slots have short content, so they should all fit
      expect(result).toHaveLength(slots.length);
    });
  });

  // ─── Context slot priority ordering ───

  describe("context slot priority ordering", () => {
    it("task_execution slots are in ascending priority order", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].priority).toBeGreaterThan(slots[i - 1].priority);
      }
    });

    it("observation slots are in ascending priority order", () => {
      const slots = manager.buildObservationContext("goal-1", ["d1", "d2"]);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].priority).toBeGreaterThan(slots[i - 1].priority);
      }
    });

    it("task_review slots are in ascending priority order", () => {
      const slots = manager.buildTaskReviewContext("goal-1", "task-1");
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].priority).toBeGreaterThan(slots[i - 1].priority);
      }
    });

    it("goal_review slots are in ascending priority order", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].priority).toBeGreaterThan(slots[i - 1].priority);
      }
    });
  });

  // ─── loadSessionIndex edge cases ───

  describe("loadSessionIndex edge cases (via getActiveSessions)", () => {
    it("handles non-array raw index by treating as empty (returns no sessions)", async () => {
      // Write a non-array value to the index file to hit the !Array.isArray(raw) branch
      await stateManager.writeRaw("sessions/index.json", { corrupt: true });

      // getActiveSessions reads the index — non-array raw should be treated as empty
      const sessions = await manager.getActiveSessions("any-goal");
      expect(sessions).toEqual([]);
    });

    it("handles null index (no index file) by returning empty array", async () => {
      // No index file written — readRaw returns null → return []
      const sessions = await manager.getActiveSessions("any-goal");
      expect(sessions).toEqual([]);
    });
  });

  // ─── updateSessionIndex deduplication ───

  describe("updateSessionIndex deduplication", () => {
    it("does not duplicate session IDs in the index when createSession is called twice for same session structure", async () => {
      const s1 = await manager.createSession("task_execution", "goal-1", "task-1");

      // Manually write the same session ID to index again to simulate a duplicate scenario,
      // then create another session — the index should not contain more duplicates
      const s2 = await manager.createSession("observation", "goal-1", null);

      // Read the raw index and verify no duplicates
      const rawIndex = await stateManager.readRaw("sessions/index.json") as string[];
      expect(rawIndex).toContain(s1.id);
      expect(rawIndex).toContain(s2.id);
      // Verify uniqueness
      const unique = new Set(rawIndex);
      expect(unique.size).toBe(rawIndex.length);
    });

    it("does not add duplicate session ID when persistSession is called twice", async () => {
      const s = await manager.createSession("goal_review", "goal-dup", null);
      // End the session (which calls persistSession again with the same id)
      await manager.endSession(s.id, "done");

      const rawIndex = await stateManager.readRaw("sessions/index.json") as string[];
      const count = rawIndex.filter((id) => id === s.id).length;
      expect(count).toBe(1);
    });
  });

  // ─── Checkpoint delegation ───

  describe("checkpoint delegation", () => {
    it("saveCheckpoint returns null when no checkpointManager is set", async () => {
      const result = await manager.saveCheckpoint({
        goalId: "goal-1",
        taskId: "task-1",
        agentId: "mock-agent",
        sessionContextSnapshot: "context",
      });
      expect(result).toBeNull();
    });

    it("loadCheckpoint returns null when no checkpointManager is set", async () => {
      const result = await manager.loadCheckpoint("goal-1", "mock-agent");
      expect(result).toBeNull();
    });

    it("gcCheckpoints returns 0 when no checkpointManager is set", async () => {
      const result = await manager.gcCheckpoints("goal-1");
      expect(result).toBe(0);
    });

    it("setCheckpointManager installs the checkpoint manager", async () => {
      const cm = new CheckpointManager({ stateManager });
      manager.setCheckpointManager(cm);

      // After setting, saveCheckpoint should delegate (returns a Checkpoint object, not null)
      const result = await manager.saveCheckpoint({
        goalId: "goal-cp",
        taskId: "task-cp",
        agentId: "mock-agent",
        sessionContextSnapshot: "snapshot text",
        intermediateResults: ["step 1 done"],
      });
      expect(result).not.toBeNull();
      expect(result?.goal_id).toBe("goal-cp");
    });

    it("gcCheckpoints delegates to checkpointManager when set", async () => {
      const cm = new CheckpointManager({ stateManager });
      manager.setCheckpointManager(cm);

      // No checkpoints exist for the goal — should return 0 deleted
      const deleted = await manager.gcCheckpoints("goal-no-checkpoints");
      expect(typeof deleted).toBe("number");
      expect(deleted).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── buildContextForType with tokenBudget ───

  describe("buildContextForType with tokenBudget (via createSession)", () => {
    it("createSession with very tight budget produces fewer slots", async () => {
      // A budget of 1 token should drop most or all slots (all have token_estimate=0 but content)
      // The key is the branch `if (tokenBudget !== undefined)` inside buildContextForType is hit.
      // With budget=0 all slots are dropped.
      const session = await manager.createSession("task_execution", "goal-budget", "task-budget", 0);
      // With budget 0, all slots should be filtered out
      expect(session.context_slots).toHaveLength(0);
    });

    it("createSession with ample budget retains all slots", async () => {
      const session = await manager.createSession("task_review", "goal-budget2", "task-budget2", 1_000_000);
      expect(session.context_slots).toHaveLength(2);
    });
  });

  // ─── injectLearningFeedback ───

  describe("injectLearningFeedback", () => {
    it("returns slots unchanged when feedback array is empty", () => {
      const slots = manager.buildTaskExecutionContext("goal-1", "task-1");
      const result = manager.injectLearningFeedback(slots, []);
      expect(result).toHaveLength(slots.length);
    });

    it("adds a learning_feedback slot when feedback items are provided", () => {
      const slots = manager.buildGoalReviewContext("goal-1");
      const result = manager.injectLearningFeedback(slots, ["Feedback item A", "Feedback item B"]);
      const feedbackSlot = result.find((s) => s.label === "learning_feedback");
      expect(feedbackSlot).toBeDefined();
    });

    it("feedback slot content contains the provided feedback items", () => {
      const slots = manager.buildObservationContext("goal-1", ["dim_a"]);
      const result = manager.injectLearningFeedback(slots, ["Use approach X", "Avoid approach Y"]);
      const feedbackSlot = result.find((s) => s.label === "learning_feedback")!;
      expect(feedbackSlot.content).toContain("Use approach X");
      expect(feedbackSlot.content).toContain("Avoid approach Y");
    });
  });
});
