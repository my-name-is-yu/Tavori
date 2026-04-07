import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DreamConsolidator } from "../dream-consolidator.js";

describe("DreamConsolidator", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("persists a light-tier report with the expected categories", async () => {
    tmpDir = makeTempDir("dream-consolidator-light-");
    await seedDreamFiles(tmpDir);

    const consolidator = new DreamConsolidator({ baseDir: tmpDir });
    const report = await consolidator.run({ tier: "light" });

    expect(report.tier).toBe("light");
    expect(report.categories.map((category) => category.category)).toEqual([
      "memory",
      "agentMemory",
      "knowledgeOptimization",
    ]);

    const reportsDir = path.join(tmpDir, "dream", "reports");
    const persisted = await fs.readdir(reportsDir);
    expect(persisted).toHaveLength(1);
  });

  it("includes deep-tier categories and scans dream artifacts", async () => {
    tmpDir = makeTempDir("dream-consolidator-deep-");
    await seedDreamFiles(tmpDir);

    const consolidator = new DreamConsolidator({ baseDir: tmpDir });
    const report = await consolidator.run({ tier: "deep" });
    const iterationLogs = report.categories.find((category) => category.category === "iterationLogs");
    const stallHistory = report.categories.find((category) => category.category === "stallHistory");

    expect(report.categories.some((category) => category.category === "archive")).toBe(true);
    expect(iterationLogs?.metrics.iterationLogsScanned).toBe(1);
    expect(stallHistory?.metrics.stallEventsScanned).toBe(1);
  });
});

async function seedDreamFiles(baseDir: string): Promise<void> {
  await fs.mkdir(path.join(baseDir, "goals", "goal-1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "dream", "events"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "archive", "goal-1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "verification", "task-1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "agent-memory"), { recursive: true });

  await fs.writeFile(
    path.join(baseDir, "goals", "goal-1", "iteration-logs.jsonl"),
    `${JSON.stringify({ goalId: "goal-1", iteration: 0 })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(baseDir, "dream", "session-logs.jsonl"),
    `${JSON.stringify({ goalId: "goal-1", sessionId: "s-1" })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(baseDir, "dream", "events", "goal-1.jsonl"),
    `${JSON.stringify({ eventType: "StallDetected" })}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(baseDir, "archive", "goal-1", "bundle.json"), "{}", "utf8");
  await fs.writeFile(path.join(baseDir, "verification", "task-1", "report.json"), "{}", "utf8");
  await fs.writeFile(path.join(baseDir, "agent-memory", "store.json"), "[]", "utf8");
}
