// ─── pulseed report command ───

import { StateManager } from "../../state-manager.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { getCliLogger } from "../cli-logger.js";

export async function cmdReport(stateManager: StateManager, goalId: string): Promise<number> {
  const logger = getCliLogger();
  const reportingEngine = new ReportingEngine(stateManager);

  const goal = await stateManager.loadGoal(goalId);
  if (!goal) {
    logger.error(`Error: Goal "${goalId}" not found.`);
    return 1;
  }

  const reports = await reportingEngine.listReports(goalId);

  if (reports.length === 0) {
    console.log(`No reports found for goal "${goalId}".`);
    console.log(`Run \`pulseed run --goal ${goalId}\` to generate reports.`);
    return 0;
  }

  const sorted = [...reports].sort((a, b) =>
    a.generated_at < b.generated_at ? 1 : -1
  );
  const latest = sorted[0];

  console.log(`# ${latest.title}`);
  console.log(`\n**Report ID**: ${latest.id}`);
  console.log(`**Type**: ${latest.report_type}`);
  console.log(`**Generated**: ${latest.generated_at}`);
  console.log(`**Goal**: ${goalId}`);
  console.log(`\n---\n`);
  console.log(latest.content);

  return 0;
}
