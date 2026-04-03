import { describe, it, expect, beforeEach } from "vitest";
import { GuardrailRunner } from "../src/traits/guardrail-runner.js";
import type {
  IGuardrailHook,
  GuardrailContext,
  GuardrailResult,
} from "../src/types/guardrail.js";

// ─── Helper context ───

function makeContext(checkpoint: GuardrailContext["checkpoint"] = "before_model"): GuardrailContext {
  return {
    checkpoint,
    goal_id: "goal-1",
    task_id: "task-1",
    input: { messages: [] },
    metadata: {},
  };
}

// ─── Mock hooks ───

const passingHook: IGuardrailHook = {
  name: "test-pass",
  checkpoint: "before_model",
  priority: 10,
  execute: async (ctx) => ({
    hook_name: "test-pass",
    checkpoint: ctx.checkpoint,
    allowed: true,
    severity: "info" as const,
  }),
};

const warningHook: IGuardrailHook = {
  name: "test-warning",
  checkpoint: "before_model",
  priority: 20,
  execute: async (ctx) => ({
    hook_name: "test-warning",
    checkpoint: ctx.checkpoint,
    allowed: true,
    severity: "warning" as const,
    reason: "something looks suspicious",
  }),
};

const criticalBlockHook: IGuardrailHook = {
  name: "test-critical",
  checkpoint: "before_model",
  priority: 5,
  execute: async (ctx) => ({
    hook_name: "test-critical",
    checkpoint: ctx.checkpoint,
    allowed: false,
    severity: "critical" as const,
    reason: "blocked by policy",
  }),
};

const modifyingHook: IGuardrailHook = {
  name: "test-modify",
  checkpoint: "before_model",
  priority: 15,
  execute: async (ctx) => ({
    hook_name: "test-modify",
    checkpoint: ctx.checkpoint,
    allowed: true,
    severity: "info" as const,
    modified_input: { messages: [{ role: "user", content: "modified" }] },
  }),
};

// ─── Tests ───

describe("GuardrailRunner", () => {
  let runner: GuardrailRunner;

  beforeEach(() => {
    runner = new GuardrailRunner();
  });

  // ─── registration ───

  describe("register / getHooks", () => {
    it("registers a hook and getHooks returns it", () => {
      runner.register(passingHook);
      const hooks = runner.getHooks("before_model");
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.name).toBe("test-pass");
    });

    it("getHooks returns only hooks for the requested checkpoint", () => {
      runner.register(passingHook); // before_model
      const afterModelHooks = runner.getHooks("after_model");
      expect(afterModelHooks).toHaveLength(0);
    });

    it("registers multiple hooks and sorts by priority ascending", () => {
      runner.register(warningHook);   // priority 20
      runner.register(passingHook);   // priority 10
      const hooks = runner.getHooks("before_model");
      expect(hooks[0]?.name).toBe("test-pass");   // priority 10 first
      expect(hooks[1]?.name).toBe("test-warning"); // priority 20 second
    });
  });

  // ─── unregistration ───

  describe("unregister", () => {
    it("removes the named hook", () => {
      runner.register(passingHook);
      runner.unregister("test-pass");
      expect(runner.getHooks("before_model")).toHaveLength(0);
    });

    it("is a no-op for a name that was never registered", () => {
      runner.register(passingHook);
      runner.unregister("nonexistent");
      expect(runner.getHooks("before_model")).toHaveLength(1);
    });
  });

  // ─── run() with no hooks ───

  describe("run() with no hooks", () => {
    it("returns allowed=true and empty results", async () => {
      const result = await runner.run("before_model", makeContext());
      expect(result.allowed).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── run() with a passing hook ───

  describe("run() with passing hook", () => {
    it("returns allowed=true", async () => {
      runner.register(passingHook);
      const result = await runner.run("before_model", makeContext());
      expect(result.allowed).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.hook_name).toBe("test-pass");
    });
  });

  // ─── run() with rejecting hook (critical) ───

  describe("run() with critical blocking hook", () => {
    it("returns allowed=false", async () => {
      runner.register(criticalBlockHook);
      const result = await runner.run("before_model", makeContext());
      expect(result.allowed).toBe(false);
    });

    it("result contains the blocking hook's reason", async () => {
      runner.register(criticalBlockHook);
      const result = await runner.run("before_model", makeContext());
      expect(result.results[0]?.reason).toBe("blocked by policy");
    });
  });

  // ─── warning hooks ───

  describe("run() with warning hooks only", () => {
    it("returns allowed=true but collects warnings", async () => {
      runner.register(warningHook);
      const result = await runner.run("before_model", makeContext());
      expect(result.allowed).toBe(true);
      expect(result.results[0]?.severity).toBe("warning");
      expect(result.results[0]?.reason).toBe("something looks suspicious");
    });
  });

  // ─── priority ordering ───

  describe("priority ordering", () => {
    it("executes lower priority number first", async () => {
      const executionOrder: string[] = [];

      const first: IGuardrailHook = {
        name: "first",
        checkpoint: "before_model",
        priority: 1,
        execute: async (ctx) => {
          executionOrder.push("first");
          return { hook_name: "first", checkpoint: ctx.checkpoint, allowed: true, severity: "info" as const };
        },
      };

      const second: IGuardrailHook = {
        name: "second",
        checkpoint: "before_model",
        priority: 100,
        execute: async (ctx) => {
          executionOrder.push("second");
          return { hook_name: "second", checkpoint: ctx.checkpoint, allowed: true, severity: "info" as const };
        },
      };

      runner.register(second); // register out of order
      runner.register(first);

      await runner.run("before_model", makeContext());

      expect(executionOrder).toEqual(["first", "second"]);
    });
  });

  // ─── modified_input passthrough ───

  describe("modified_input passthrough", () => {
    it("forwards modified_input from hook result", async () => {
      runner.register(modifyingHook);
      const result = await runner.run("before_model", makeContext());
      expect(result.modified_input).toEqual({
        messages: [{ role: "user", content: "modified" }],
      });
    });

    it("last hook to set modified_input wins", async () => {
      const firstModifier: IGuardrailHook = {
        name: "modifier-1",
        checkpoint: "before_model",
        priority: 1,
        execute: async (ctx) => ({
          hook_name: "modifier-1",
          checkpoint: ctx.checkpoint,
          allowed: true,
          severity: "info" as const,
          modified_input: { messages: [{ role: "user", content: "first" }] },
        }),
      };

      const secondModifier: IGuardrailHook = {
        name: "modifier-2",
        checkpoint: "before_model",
        priority: 2,
        execute: async (ctx) => ({
          hook_name: "modifier-2",
          checkpoint: ctx.checkpoint,
          allowed: true,
          severity: "info" as const,
          modified_input: { messages: [{ role: "user", content: "second" }] },
        }),
      };

      runner.register(firstModifier);
      runner.register(secondModifier);

      const result = await runner.run("before_model", makeContext());
      expect((result.modified_input as any).messages[0].content).toBe("second");
    });
  });

  // ─── critical stops execution of subsequent hooks ───

  describe("critical block stops subsequent hooks", () => {
    it("does not execute hooks after a critical block", async () => {
      let laterHookCalled = false;

      const laterHook: IGuardrailHook = {
        name: "later",
        checkpoint: "before_model",
        priority: 50, // runs after criticalBlockHook (priority 5)
        execute: async (ctx) => {
          laterHookCalled = true;
          return { hook_name: "later", checkpoint: ctx.checkpoint, allowed: true, severity: "info" as const };
        },
      };

      runner.register(criticalBlockHook); // priority 5
      runner.register(laterHook);         // priority 50

      await runner.run("before_model", makeContext());

      expect(laterHookCalled).toBe(false);
    });

    it("only includes results up to and including the critical hook", async () => {
      const later: IGuardrailHook = {
        name: "later",
        checkpoint: "before_model",
        priority: 50,
        execute: async (ctx) => ({
          hook_name: "later",
          checkpoint: ctx.checkpoint,
          allowed: true,
          severity: "info" as const,
        }),
      };

      runner.register(criticalBlockHook); // priority 5
      runner.register(later);

      const result = await runner.run("before_model", makeContext());
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.hook_name).toBe("test-critical");
    });
  });

  // ─── hook that throws ───

  describe("hook that throws an unexpected error", () => {
    it("treats the throw as a critical block", async () => {
      const throwingHook: IGuardrailHook = {
        name: "thrower",
        checkpoint: "before_model",
        priority: 10,
        execute: async () => {
          throw new Error("unexpected failure");
        },
      };

      runner.register(throwingHook);
      const result = await runner.run("before_model", makeContext());
      expect(result.allowed).toBe(false);
      expect(result.results[0]?.severity).toBe("critical");
      expect(result.results[0]?.reason).toMatch(/unexpected failure/);
    });
  });

  // ─── hookCount getter ───

  describe("hookCount", () => {
    it("returns 0 when no hooks are registered", () => {
      // GuardrailRunner exposes no public hookCount getter in the implementation,
      // so we verify via getHooks across all checkpoints
      const total =
        runner.getHooks("before_model").length +
        runner.getHooks("after_model").length +
        runner.getHooks("before_tool").length +
        runner.getHooks("after_tool").length;
      expect(total).toBe(0);
    });

    it("counts hooks across different checkpoints independently", () => {
      const afterModelHook: IGuardrailHook = {
        name: "after-hook",
        checkpoint: "after_model",
        priority: 10,
        execute: async (ctx) => ({
          hook_name: "after-hook",
          checkpoint: ctx.checkpoint,
          allowed: true,
          severity: "info" as const,
        }),
      };

      runner.register(passingHook);  // before_model
      runner.register(afterModelHook); // after_model

      expect(runner.getHooks("before_model")).toHaveLength(1);
      expect(runner.getHooks("after_model")).toHaveLength(1);
    });
  });
});
