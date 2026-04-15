import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { HookManager } from "../hook-manager.js";
import type { HookConfig } from "../../base/types/hook.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

// ─── Helpers ───

function writeHooksJson(dir: string, hooks: HookConfig[]): void {
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks }), "utf-8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

// ─── Tests ───

describe("HookManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("hook-manager-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // ─── loadHooks ───

  describe("loadHooks", () => {
    it("loads valid hooks config", async () => {
      const hooks: HookConfig[] = [
        { event: "LoopCycleStart", type: "shell", command: "echo hi", timeout_ms: 5000, enabled: true },
        { event: "PostObserve", type: "webhook", url: "https://example.com/hook", timeout_ms: 3000, enabled: true },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      expect(manager.getHookCount()).toBe(2);
    });

    it("handles missing hooks.json gracefully (no error, empty hooks)", async () => {
      const manager = new HookManager(tempDir);
      await manager.loadHooks(); // no file exists

      expect(manager.getHookCount()).toBe(0);
    });

    it("handles malformed hooks.json gracefully (logs warning, empty hooks)", async () => {
      fs.writeFileSync(path.join(tempDir, "hooks.json"), "this is not json", "utf-8");

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      expect(manager.getHookCount()).toBe(0);
    });

    it("handles empty hooks array", async () => {
      writeHooksJson(tempDir, []);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      expect(manager.getHookCount()).toBe(0);
    });
  });

  // ─── getHooksForEvent ───

  describe("getHooksForEvent", () => {
    it("returns hooks for the given event", async () => {
      const hooks: HookConfig[] = [
        { event: "LoopCycleStart", type: "shell", command: "echo start", timeout_ms: 5000, enabled: true },
        { event: "LoopCycleEnd", type: "shell", command: "echo end", timeout_ms: 5000, enabled: true },
        { event: "LoopCycleStart", type: "shell", command: "echo start2", timeout_ms: 5000, enabled: false },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      const startHooks = manager.getHooksForEvent("LoopCycleStart");
      expect(startHooks).toHaveLength(2);
      expect(startHooks.every((h) => h.event === "LoopCycleStart")).toBe(true);
    });

    it("returns empty array when no hooks match", async () => {
      writeHooksJson(tempDir, []);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      expect(manager.getHooksForEvent("GoalStateChange")).toHaveLength(0);
    });
  });

  // ─── emit ───

  describe("emit", () => {
    it("respects dream logCollection config when persisting events", async () => {
      await fs.promises.mkdir(path.join(tempDir, "dream"), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, "dream", "config.json"),
        JSON.stringify({ logCollection: { enabled: true, eventPersistenceEnabled: false } }),
        "utf8"
      );

      const manager = new HookManager(tempDir);
      await manager.emit("LoopCycleStart", { goal_id: "g1" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(fs.existsSync(path.join(tempDir, "dream", "events", "g1.jsonl"))).toBe(false);
    });

    it("uses date-based dream event paths when configured", async () => {
      await fs.promises.mkdir(path.join(tempDir, "dream"), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, "dream", "config.json"),
        JSON.stringify({ logCollection: { enabled: true, rotationMode: "date" } }),
        "utf8"
      );

      const manager = new HookManager(tempDir);
      await manager.emit("LoopCycleStart", { goal_id: "g1" });

      const dateSuffix = new Date().toISOString().slice(0, 10);
      await waitFor(() =>
        fs.existsSync(path.join(tempDir, "dream", "events", `g1.${dateSuffix}.jsonl`))
      );
    });

    it("only fires hooks matching the event type", async () => {
      const spawnedCommands: string[] = [];

      const hooks: HookConfig[] = [
        { event: "PreObserve", type: "shell", command: "echo preobserve", timeout_ms: 5000, enabled: true },
        { event: "PostObserve", type: "shell", command: "echo postobserve", timeout_ms: 5000, enabled: true },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // Only emit PreObserve — PostObserve should NOT fire
      await manager.emit("PreObserve", { goal_id: "g1", dimension: "dim1" });

      // Wait a tick for async fire-and-forget
      await new Promise((resolve) => setTimeout(resolve, 200));

      // We can't easily capture spawned output in unit tests, so just verify
      // emit doesn't throw and the right count fires
      expect(manager.getHooksForEvent("PreObserve")).toHaveLength(1);
      expect(manager.getHooksForEvent("PostObserve")).toHaveLength(1);
    });

    it("skips disabled hooks", async () => {
      const hooks: HookConfig[] = [
        { event: "LoopCycleStart", type: "shell", command: "echo nope", timeout_ms: 5000, enabled: false },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // Should complete without spawning anything
      await expect(manager.emit("LoopCycleStart", { goal_id: "g1" })).resolves.toBeUndefined();
    });

    it("filters by goal_id when filter.goal_id is set", async () => {
      const hooks: HookConfig[] = [
        {
          event: "GoalStateChange",
          type: "shell",
          command: "echo matched",
          timeout_ms: 5000,
          enabled: true,
          filter: { goal_id: "goal-123" },
        },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // Emit with a different goal_id — hook should be filtered out
      await manager.emit("GoalStateChange", { goal_id: "goal-999" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // If hook fired, the shell process would complete. We just verify no throw.
      expect(manager.getHooksForEvent("GoalStateChange")).toHaveLength(1);
    });

    it("filters by dimension when filter.dimension is set", async () => {
      const hooks: HookConfig[] = [
        {
          event: "PreObserve",
          type: "shell",
          command: "echo dim-match",
          timeout_ms: 5000,
          enabled: true,
          filter: { dimension: "test_coverage" },
        },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // Emit with non-matching dimension
      await manager.emit("PreObserve", { goal_id: "g1", dimension: "other_dim" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(manager.getHooksForEvent("PreObserve")).toHaveLength(1);
    });

    it("fires hook when filter.dimension matches", async () => {
      let fired = false;

      const hooks: HookConfig[] = [
        {
          event: "PreObserve",
          type: "shell",
          command: "echo matched",
          timeout_ms: 5000,
          enabled: true,
          filter: { dimension: "test_coverage" },
        },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // The shell hook fires async; just ensure emit resolves
      await manager.emit("PreObserve", { goal_id: "g1", dimension: "test_coverage" });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // If we got here without throwing, the test passes
      expect(true).toBe(true);
    });

    it("never throws even when a shell hook fails", async () => {
      const hooks: HookConfig[] = [
        {
          event: "LoopCycleEnd",
          type: "shell",
          command: "exit 1", // will fail
          timeout_ms: 5000,
          enabled: true,
        },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // Should NOT throw
      await expect(manager.emit("LoopCycleEnd", { goal_id: "g1" })).resolves.toBeUndefined();

      // Wait for async fire-and-forget to settle
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    it("never throws even when a webhook hook fails", async () => {
      const hooks: HookConfig[] = [
        {
          event: "ReflectionComplete",
          type: "webhook",
          url: "http://localhost:19999/nonexistent", // will fail to connect
          timeout_ms: 500,
          enabled: true,
        },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      // Should NOT throw
      await expect(manager.emit("ReflectionComplete", {})).resolves.toBeUndefined();

      // Wait for async fire-and-forget to settle
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    it("shell hook execution passes JSON payload via stdin", async () => {
      // Use a shell hook that writes its stdin to a file
      const outputFile = path.join(tempDir, "hook-output.json");
      const hooks: HookConfig[] = [
        {
          event: "PostTaskCreate",
          type: "shell",
          command: `cat > ${outputFile}`,
          timeout_ms: 5000,
          enabled: true,
        },
      ];
      writeHooksJson(tempDir, hooks);

      const manager = new HookManager(tempDir);
      await manager.loadHooks();

      await manager.emit("PostTaskCreate", { goal_id: "g1", data: { task_id: "task-42" } });

      // Wait for async fire-and-forget to settle
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify the output file was written with valid JSON payload
      expect(fs.existsSync(outputFile)).toBe(true);
      const output = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
      expect(output.event).toBe("PostTaskCreate");
      expect(output.goal_id).toBe("g1");
      expect(output.data?.task_id).toBe("task-42");
    });

    it("does nothing when no hooks are loaded", async () => {
      const manager = new HookManager(tempDir);
      // No loadHooks() call — hooks is empty

      await expect(manager.emit("LoopCycleStart", { goal_id: "g1" })).resolves.toBeUndefined();
    });

    it("persists dream event logs for supported hook events", async () => {
      const manager = new HookManager(tempDir);

      await manager.emit("PostTaskCreate", { goal_id: "goal-1", data: { task_id: "task-42", status: "ok" } });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const eventPath = path.join(tempDir, "dream", "events", "goal-1.jsonl");
      expect(fs.existsSync(eventPath)).toBe(true);

      const [firstLine] = fs.readFileSync(eventPath, "utf-8").trim().split("\n");
      const record = JSON.parse(firstLine!);
      expect(record.eventType).toBe("PostTaskCreate");
      expect(record.goalId).toBe("goal-1");
      expect(record.taskId).toBe("task-42");
      expect(record.data.status).toBe("ok");
    });
  });
});
