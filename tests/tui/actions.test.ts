import { describe, it, expect, vi, beforeEach } from "vitest";
import { ActionHandler } from "../../src/tui/actions.js";
import type { ActionDeps } from "../../src/tui/actions.js";
import type { RecognizedIntent } from "../../src/tui/intent-recognizer.js";
import type { Goal } from "../../src/types/goal.js";
import { makeGoal } from "../helpers/fixtures.js";

function makeReport() {
  return {
    id: "report-1",
    report_type: "daily_summary" as const,
    goal_id: "goal-1",
    title: "Daily Summary",
    content: "## Daily Summary\n\nAll good.",
    verbosity: "standard" as const,
    generated_at: new Date().toISOString(),
    delivered_at: null,
    read: false,
  };
}

// ─── Mock deps factory ───

function makeDeps(overrides: Partial<ActionDeps> = {}): ActionDeps {
  const stateManager = {
    listGoalIds: vi.fn(() => []),
    loadGoal: vi.fn(() => null),
  } as unknown as ActionDeps["stateManager"];

  const goalNegotiator = {
    negotiate: vi.fn(),
  } as unknown as ActionDeps["goalNegotiator"];

  const reportingEngine = {
    generateDailySummary: vi.fn(() => makeReport()),
    saveReport: vi.fn(),
  } as unknown as ActionDeps["reportingEngine"];

  return {
    stateManager,
    goalNegotiator,
    reportingEngine,
    ...overrides,
  };
}

// ─── Tests ───

describe("ActionHandler — handle()", () => {
  describe("unknown intent", () => {
    it("returns a help hint message", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "unknown", raw: "???" });
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[0]).toContain("help");
    });
  });

  describe("chat intent", () => {
    it("returns the LLM response text as a message", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({
        intent: "chat",
        response: "PulSeed manages goals with measurable dimensions.",
        params: { response: "PulSeed manages goals with measurable dimensions." },
        raw: "What can PulSeed do?",
      });
      expect(result.messages).toEqual([
        "PulSeed manages goals with measurable dimensions.",
      ]);
    });

    it("falls back to params.response when response field is absent", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({
        intent: "chat",
        params: { response: "Use 'run' to start the loop." },
        raw: "how do I start?",
      });
      expect(result.messages[0]).toBe("Use 'run' to start the loop.");
    });

    it("returns fallback message when no response is provided", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({
        intent: "chat",
        raw: "something",
      });
      expect(result.messages[0]).toBe("I'm not sure how to help with that.");
    });

    it("does not set startLoop or stopLoop", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({
        intent: "chat",
        response: "Hello!",
        raw: "hello",
      });
      expect(result.startLoop).toBeUndefined();
      expect(result.stopLoop).toBeUndefined();
    });
  });

  describe("help intent", () => {
    it("returns showHelp signal", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "help", raw: "help" });
      expect(result.showHelp).toBe(true);
      expect(result.messages).toEqual([]);
    });

    it("does not set startLoop or stopLoop", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "help", raw: "help" });
      expect(result.startLoop).toBeUndefined();
      expect(result.stopLoop).toBeUndefined();
    });
  });

  describe("loop_stop intent", () => {
    it("sets stopLoop: true in result", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "loop_stop", raw: "stop" });
      expect(result.stopLoop).toBe(true);
    });

    it("does not call coreLoop.stop() directly (delegated to app.tsx)", async () => {
      const handler = new ActionHandler(makeDeps());
      // ActionHandler no longer holds a coreLoop reference — this just confirms
      // handleStop returns the signal without throwing.
      const result = await handler.handle({ intent: "loop_stop", raw: "stop" });
      expect(result.messages.join("\n")).toContain("stopped");
    });
  });

  describe("loop_start intent — no goals", () => {
    it("returns error message when no goals exist", async () => {
      const deps = makeDeps();
      const handler = new ActionHandler(deps);
      const result = await handler.handle({ intent: "loop_start", raw: "run" });
      expect(result.startLoop).toBeUndefined();
      expect(result.messages.join("\n")).toMatch(/ゴール|goal/i);
    });
  });

  describe("loop_start intent — with active goal", () => {
    it("returns startLoop signal with first active goal id", async () => {
      const goal = makeGoal({ id: "goal-abc", status: "active" });
      const deps = makeDeps();
      vi.mocked(deps.stateManager.listGoalIds).mockReturnValue(["goal-abc"]);
      vi.mocked(deps.stateManager.loadGoal).mockReturnValue(goal);

      const handler = new ActionHandler(deps);
      const result = await handler.handle({ intent: "loop_start", raw: "run" });
      expect(result.startLoop).toEqual({ goalId: "goal-abc" });
    });

    it("uses goalId from params if provided", async () => {
      const goal = makeGoal({ id: "explicit-id", status: "active" });
      const deps = makeDeps();
      vi.mocked(deps.stateManager.loadGoal).mockReturnValue(goal);

      const handler = new ActionHandler(deps);
      const intent: RecognizedIntent = {
        intent: "loop_start",
        params: { goalId: "explicit-id" },
        raw: "run",
      };
      const result = await handler.handle(intent);
      expect(result.startLoop).toEqual({ goalId: "explicit-id" });
    });
  });

  describe("status intent", () => {
    it("returns 'no goals' message when state is empty", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "status", raw: "status" });
      expect(result.messages.join("\n")).toMatch(/ゴール|goal/i);
    });

    it("shows goal title and dimension info", async () => {
      const goal = makeGoal({ dimensions: [{ name: "coverage", label: "Coverage", current_value: 0.5, threshold: { type: "min", value: 0.8 }, confidence: 0.9, observation_method: { type: "mechanical", source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" }, last_updated: new Date().toISOString(), history: [], weight: 1.0, uncertainty_weight: null, state_integrity: "ok", dimension_mapping: null }] });
      const deps = makeDeps();
      vi.mocked(deps.stateManager.listGoalIds).mockReturnValue(["goal-1"]);
      vi.mocked(deps.stateManager.loadGoal).mockReturnValue(goal);

      const handler = new ActionHandler(deps);
      const result = await handler.handle({ intent: "status", raw: "status" });
      const text = result.messages.join("\n");
      expect(text).toContain("Test Goal");
      expect(text).toContain("Coverage");
    });
  });

  describe("goal_list intent", () => {
    it("returns 'no goals' when empty", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "goal_list", raw: "goals" });
      expect(result.messages.join("\n")).toMatch(/ゴール|goal/i);
    });

    it("lists all goals with status and title", async () => {
      const goal = makeGoal();
      const deps = makeDeps();
      vi.mocked(deps.stateManager.listGoalIds).mockReturnValue(["goal-1"]);
      vi.mocked(deps.stateManager.loadGoal).mockReturnValue(goal);

      const handler = new ActionHandler(deps);
      const result = await handler.handle({ intent: "goal_list", raw: "goals" });
      const text = result.messages.join("\n");
      expect(text).toContain("active");
      expect(text).toContain("Test Goal");
    });
  });

  describe("report intent", () => {
    it("returns 'no goals' when empty", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "report", raw: "report" });
      expect(result.messages.join("\n")).toMatch(/ゴール|goal/i);
    });

    it("calls generateDailySummary and saveReport", async () => {
      const goal = makeGoal();
      const deps = makeDeps();
      vi.mocked(deps.stateManager.listGoalIds).mockReturnValue(["goal-1"]);
      vi.mocked(deps.stateManager.loadGoal).mockReturnValue(goal);

      const handler = new ActionHandler(deps);
      await handler.handle({ intent: "report", raw: "report" });

      expect(deps.reportingEngine.generateDailySummary).toHaveBeenCalledWith("goal-1");
      expect(deps.reportingEngine.saveReport).toHaveBeenCalledOnce();
    });

    it("returns showReport with the generated report", async () => {
      const goal = makeGoal();
      const deps = makeDeps();
      vi.mocked(deps.stateManager.listGoalIds).mockReturnValue(["goal-1"]);
      vi.mocked(deps.stateManager.loadGoal).mockReturnValue(goal);

      const handler = new ActionHandler(deps);
      const result = await handler.handle({ intent: "report", raw: "report" });
      expect(result.showReport).toBeDefined();
      expect(result.showReport?.title).toContain("Daily Summary");
    });
  });

  describe("dashboard intent", () => {
    it("returns output with toggleDashboard: 'toggle'", async () => {
      const handler = new ActionHandler(makeDeps());
      const result = await handler.handle({ intent: "dashboard", raw: "/dashboard" });
      expect(result.toggleDashboard).toBe("toggle");
      expect(result.messages.join("\n")).toContain("Dashboard toggled");
    });
  });

  describe("goal_create intent", () => {
    it("calls goalNegotiator.negotiate with description from params", async () => {
      const goal = makeGoal();
      const deps = makeDeps();
      vi.mocked(deps.goalNegotiator.negotiate).mockResolvedValue({
        goal,
        response: {
          type: "accept",
          message: "Goal accepted.",
          accepted: true,
          initial_confidence: "high",
        },
        log: {} as never,
      });

      const handler = new ActionHandler(deps);
      const intent: RecognizedIntent = {
        intent: "goal_create",
        params: { description: "READMEを書く" },
        raw: "READMEを書いてほしい",
      };
      await handler.handle(intent);
      expect(deps.goalNegotiator.negotiate).toHaveBeenCalledWith("READMEを書く");
    });

    it("falls back to raw input when no params.description", async () => {
      const goal = makeGoal();
      const deps = makeDeps();
      vi.mocked(deps.goalNegotiator.negotiate).mockResolvedValue({
        goal,
        response: {
          type: "accept",
          message: "Goal accepted.",
          accepted: true,
          initial_confidence: "high",
        },
        log: {} as never,
      });

      const handler = new ActionHandler(deps);
      const intent: RecognizedIntent = {
        intent: "goal_create",
        raw: "テスト書いて",
      };
      await handler.handle(intent);
      expect(deps.goalNegotiator.negotiate).toHaveBeenCalledWith("テスト書いて");
    });

    it("returns created goal info in messages", async () => {
      const goal = makeGoal();
      const deps = makeDeps();
      vi.mocked(deps.goalNegotiator.negotiate).mockResolvedValue({
        goal,
        response: {
          type: "accept",
          message: "Goal accepted.",
          accepted: true,
          initial_confidence: "high",
        },
        log: {} as never,
      });

      const handler = new ActionHandler(deps);
      const result = await handler.handle({
        intent: "goal_create",
        params: { description: "テストゴール" },
        raw: "テストゴール",
      });
      const text = result.messages.join("\n");
      expect(text).toContain("goal-1");
      expect(text).toContain("accept");
    });

    it("returns error message when negotiate throws", async () => {
      const deps = makeDeps();
      vi.mocked(deps.goalNegotiator.negotiate).mockRejectedValue(
        new Error("Ethics rejected")
      );

      const handler = new ActionHandler(deps);
      const result = await handler.handle({
        intent: "goal_create",
        params: { description: "危険なゴール" },
        raw: "危険なゴール",
      });
      expect(result.messages.join("\n")).toContain("Ethics rejected");
    });
  });
});
