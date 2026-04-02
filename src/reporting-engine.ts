import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { StateManager } from "./state-manager.js";
import { ReportSchema } from "./types/report.js";
import type { Report } from "./types/report.js";
import type { INotificationDispatcher } from "./runtime/notification-dispatcher.js";
import type { CharacterConfig } from "./types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "./types/character.js";

// ─── Types ───

export type ExecutionSummaryParams = {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: { taskId: string; action: string; dimension: string } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
};

export type NotificationType =
  | "urgent"
  | "approval_required"
  | "stall_escalation"
  | "completed"
  | "capability_insufficient";

export type NotificationContext = {
  goalId: string;
  message: string;
  details?: string;
};

// ─── ReportingEngine ───

export class ReportingEngine {
  private readonly stateManager: StateManager;
  private notificationDispatcher: INotificationDispatcher | null;
  private readonly characterConfig: CharacterConfig;

  private knowledgeTransfer?: {
    getAppliedTransferCount(): number;
    getTransferSuccessRate(): { total: number; positive: number; negative: number; neutral: number; rate: number };
    getEffectivenessRecords(): Array<{ transfer_id: string; gap_delta_before: number; gap_delta_after: number; effectiveness: string; evaluated_at: string }>;
  };

  private transferTrust?: {
    getAllScores(): Promise<Array<{ domain_pair: string; trust_score: number; success_count: number; failure_count: number; neutral_count: number }>>;
  };

  constructor(
    stateManager: StateManager,
    notificationDispatcher?: INotificationDispatcher,
    characterConfig?: CharacterConfig
  ) {
    this.stateManager = stateManager;
    this.notificationDispatcher = notificationDispatcher ?? null;
    this.characterConfig = characterConfig ?? DEFAULT_CHARACTER_CONFIG;
  }

  setKnowledgeTransfer(kt: typeof this.knowledgeTransfer): void {
    this.knowledgeTransfer = kt;
  }

  setTransferTrust(tt: typeof this.transferTrust): void {
    this.transferTrust = tt;
  }

  setNotificationDispatcher(dispatcher: INotificationDispatcher): void {
    this.notificationDispatcher = dispatcher;
  }

  // ─── getVerbosityLevel ───

  private getVerbosityLevel(): "brief" | "normal" | "detailed" {
    const p = this.characterConfig.proactivity_level;
    if (p === 1) return "brief";
    if (p <= 3) return "normal";
    return "detailed";
  }

  // ─── generateExecutionSummary ───

  generateExecutionSummary(params: ExecutionSummaryParams): Report {
    const {
      goalId,
      loopIndex,
      observation,
      gapAggregate,
      taskResult,
      stallDetected,
      pivotOccurred,
      elapsedMs,
    } = params;

    const now = new Date().toISOString();
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    // Determine verbosity, but force detailed for stall/escalation/completion events
    const isStructuralEvent = stallDetected || pivotOccurred || taskResult === null;
    const verbosity = this.getVerbosityLevel();
    const useBrief = verbosity === "brief" && !isStructuralEvent;

    let content: string;

    if (useBrief) {
      // Brief mode: 1-3 line summary with essential info
      const gapSummary = gapAggregate.toFixed(4);
      const progressSummary =
        observation.length > 0
          ? observation
              .map((o) => `${o.dimensionName}: ${o.progress.toFixed(1)}`)
              .join(", ")
          : "no observations";
      content =
        `Loop ${loopIndex} | gap: ${gapSummary} | ${progressSummary} | ${elapsedSec}s`;
    } else {
      // Normal or detailed: full format
      // Build observation table
      let obsTable = "| Dimension | Progress | Confidence |\n|---|---|---|\n";
      if (observation.length === 0) {
        obsTable += "| (none) | — | — |\n";
      } else {
        for (const obs of observation) {
          const progress = obs.progress.toFixed(1);
          const confidence = (obs.confidence * 100).toFixed(1) + "%";
          obsTable += `| ${obs.dimensionName} | ${progress} | ${confidence} |\n`;
        }
      }

      // Task result section
      let taskSection = "_No task executed this loop._";
      if (taskResult !== null) {
        taskSection =
          `- **Task ID**: ${taskResult.taskId}\n` +
          `- **Action**: ${taskResult.action}\n` +
          `- **Dimension**: ${taskResult.dimension}`;
      }

      // Status flags
      const stallStatus = stallDetected ? "Yes" : "No";
      const pivotStatus = pivotOccurred ? "Yes" : "No";

      content =
        `## Execution Summary — Loop ${loopIndex}\n\n` +
        `**Timestamp**: ${now}\n\n` +
        `### Observation Results\n\n${obsTable}\n` +
        `### Gap Aggregate\n\n` +
        `**Score**: ${gapAggregate.toFixed(4)}\n\n` +
        `### Task Result\n\n${taskSection}\n\n` +
        `### Status\n\n` +
        `- **Stall detected**: ${stallStatus}\n` +
        `- **Strategy pivot**: ${pivotStatus}\n\n` +
        `### Elapsed Time\n\n${elapsedSec}s`;
    }

    const report = ReportSchema.parse({
      id: crypto.randomUUID(),
      report_type: "execution_summary",
      goal_id: goalId,
      title: `Execution Summary — Loop ${loopIndex}`,
      content,
      verbosity: "standard",
      generated_at: now,
      delivered_at: null,
      read: false,
      metadata: {
        loop_index: loopIndex,
        gap_aggregate: gapAggregate,
        stall_detected: stallDetected,
        pivot_occurred: pivotOccurred,
        elapsed_ms: elapsedMs,
        task_id: taskResult?.taskId ?? null,
        task_action: taskResult?.action ?? null,
      },
    });

    return report;
  }

  // ─── generateDailySummary ───

  async generateDailySummary(goalId: string): Promise<Report> {
    const now = new Date();
    const todayPrefix = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

    // Load all reports for this goal
    const allReports = await this.listReports(goalId);

    // Filter to execution summaries generated today
    const todayReports = allReports.filter((r) => {
      return (
        r.report_type === "execution_summary" &&
        r.generated_at.startsWith(todayPrefix)
      );
    });

    const loopsRun = todayReports.length;

    // Compute progress change from first to last loop
    let progressChange: string;
    if (loopsRun === 0) {
      progressChange = "N/A";
    } else if (loopsRun === 1) {
      progressChange = "Single loop (no change to compute)";
    } else {
      const getGap = (r: (typeof todayReports)[0]): number | null => {
        if (r.metadata?.gap_aggregate !== undefined) return r.metadata.gap_aggregate;
        // Fallback: parse from Markdown for reports generated before metadata was added
        const match = r.content.match(/\*\*Score\*\*:\s*([\d.]+)/);
        return match ? parseFloat(match[1]) : null;
      };
      const firstGap = getGap(todayReports[0]);
      const lastGap = getGap(todayReports[loopsRun - 1]);
      if (firstGap !== null && lastGap !== null) {
        const delta = firstGap - lastGap;
        progressChange =
          delta >= 0
            ? `▼ ${delta.toFixed(4)} (gap reduced)`
            : `▲ ${Math.abs(delta).toFixed(4)} (gap grew)`;
      } else {
        progressChange = "Could not parse gap data";
      }
    }

    // Count stalls and pivots
    const stallCount = todayReports.filter((r) => {
      if (r.metadata?.stall_detected !== undefined) return r.metadata.stall_detected;
      return r.content.includes("**Stall detected**: Yes");
    }).length;

    const pivotCount = todayReports.filter((r) => {
      if (r.metadata?.pivot_occurred !== undefined) return r.metadata.pivot_occurred;
      return r.content.includes("**Strategy pivot**: Yes");
    }).length;

    const reportNow = now.toISOString();

    const content =
      `## Daily Summary — ${todayPrefix}\n\n` +
      `**Goal**: ${goalId}\n\n` +
      `### Activity\n\n` +
      `- **Loops run**: ${loopsRun}\n` +
      `- **Stalls detected**: ${stallCount}\n` +
      `- **Strategy pivots**: ${pivotCount}\n\n` +
      `### Progress\n\n` +
      `- **Overall gap change**: ${progressChange}\n\n` +
      `_Generated at ${reportNow}_`;

    const report = ReportSchema.parse({
      id: crypto.randomUUID(),
      report_type: "daily_summary",
      goal_id: goalId,
      title: `Daily Summary — ${todayPrefix}`,
      content,
      verbosity: "standard",
      generated_at: reportNow,
      delivered_at: null,
      read: false,
      metadata: {
        loops_run: loopsRun,
        stall_count: stallCount,
        pivot_count: pivotCount,
        progress_change: progressChange,
      },
    });

    return report;
  }

  // ─── generateWeeklyReport ───

  async generateWeeklyReport(goalId: string): Promise<Report> {
    const now = new Date();
    const reportNow = now.toISOString();

    // Collect daily summaries for the last 7 days
    const allReports = await this.listReports(goalId);

    const dailySummaries = allReports.filter((r) => {
      if (r.report_type !== "daily_summary") return false;
      const generatedAt = new Date(r.generated_at);
      const diffDays =
        (now.getTime() - generatedAt.getTime()) / (1000 * 60 * 60 * 24);
      return diffDays <= 7;
    });

    const daysWithActivity = dailySummaries.length;

    // Sum up total loops from daily summaries
    const getLoopsFromDaily = (r: (typeof dailySummaries)[0]): number => {
      if (r.metadata?.loops_run !== undefined) return r.metadata.loops_run;
      // Fallback for reports without metadata
      const match = r.content.match(/\*\*Loops run\*\*:\s*(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    };

    const totalLoops = dailySummaries.reduce((acc, r) => acc + getLoopsFromDaily(r), 0);

    const totalStalls = dailySummaries.reduce((acc, r) => {
      if (r.metadata?.stall_count !== undefined) return acc + r.metadata.stall_count;
      const match = r.content.match(/\*\*Stalls detected\*\*:\s*(\d+)/);
      return acc + (match ? parseInt(match[1], 10) : 0);
    }, 0);

    const totalPivots = dailySummaries.reduce((acc, r) => {
      if (r.metadata?.pivot_count !== undefined) return acc + r.metadata.pivot_count;
      const match = r.content.match(/\*\*Strategy pivots\*\*:\s*(\d+)/);
      return acc + (match ? parseInt(match[1], 10) : 0);
    }, 0);

    // Build trend lines from daily summaries (sorted chronologically)
    let trendSection = "_No daily activity in the last 7 days._";
    if (dailySummaries.length > 0) {
      const sortedSummaries = [...dailySummaries].sort((a, b) =>
        a.generated_at.localeCompare(b.generated_at)
      );
      const trendLines = sortedSummaries.map((r) => {
        const date = r.generated_at.slice(0, 10);
        const loops = getLoopsFromDaily(r);
        const progress =
          r.metadata?.progress_change ??
          (() => {
            const m = r.content.match(/\*\*Overall gap change\*\*:\s*(.+)/);
            return m ? m[1].trim() : "N/A";
          })();
        return `- **${date}**: ${loops} loops | Gap change: ${progress}`;
      });
      trendSection = trendLines.join("\n");
    }

    const content =
      `## Weekly Report\n\n` +
      `**Goal**: ${goalId}\n` +
      `**Period**: Last 7 days (ending ${reportNow.slice(0, 10)})\n\n` +
      `### Summary\n\n` +
      `- **Days with activity**: ${daysWithActivity}\n` +
      `- **Total loops run**: ${totalLoops}\n` +
      `- **Total stalls**: ${totalStalls}\n` +
      `- **Total pivots**: ${totalPivots}\n\n` +
      `### Daily Trend\n\n${trendSection}\n\n` +
      `_Generated at ${reportNow}_`;

    const report = ReportSchema.parse({
      id: crypto.randomUUID(),
      report_type: "weekly_report",
      goal_id: goalId,
      title: `Weekly Report — ${reportNow.slice(0, 10)}`,
      content,
      verbosity: "standard",
      generated_at: reportNow,
      delivered_at: null,
      read: false,
      metadata: {
        total_loops: totalLoops,
        total_stalls: totalStalls,
        total_pivots: totalPivots,
      },
    });

    return report;
  }

  // ─── saveReport ───

  async saveReport(report: Report): Promise<void> {
    const goalId = report.goal_id ?? "_global";
    const relativePath = `reports/${goalId}/${report.id}.json`;
    await this.stateManager.writeRaw(relativePath, report);
  }

  // ─── getReport ───

  async getReport(reportId: string): Promise<Report | null> {
    const allReports = await this.listReports();
    const found = allReports.find((r) => r.id === reportId);
    return found ?? null;
  }

  // ─── listReports ───

  async listReports(goalId?: string): Promise<Report[]> {
    const results: Report[] = [];
    const baseDir = this.stateManager.getBaseDir();
    const reportsDir = `${baseDir}/reports`;

    if (goalId !== undefined) {
      await this._loadReportsFromAbsDir(`${reportsDir}/${goalId}`, results);
    } else {
      // Scan all subdirectories under reports/
      let entries: import("node:fs").Dirent<string>[];
      try {
        entries = await fsp.readdir(reportsDir, { withFileTypes: true });
      } catch {
        return [];
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this._loadReportsFromAbsDir(`${reportsDir}/${entry.name}`, results);
        }
      }
    }

    // Sort by generated_at ascending
    results.sort((a, b) => a.generated_at.localeCompare(b.generated_at));
    return results;
  }

  private async _loadReportsFromAbsDir(absDir: string, results: Report[]): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      // Use readRaw relative path
      const baseDir = this.stateManager.getBaseDir();
      const relativePath = path.relative(baseDir, path.join(absDir, entry));
      const raw = await this.stateManager.readRaw(relativePath);
      if (raw === null) continue;
      try {
        const report = ReportSchema.parse(raw);
        results.push(report);
      } catch {
        // Skip malformed files
      }
    }
  }

  // ─── formatForCLI ───

  formatForCLI(report: Report): string {
    if (report.report_type === "execution_summary") {
      const m = report.metadata;
      const loopNum = m?.loop_index ?? (() => {
        const match = report.title.match(/Loop (\d+)/);
        return match ? parseInt(match[1], 10) : null;
      })();
      const gap = m?.gap_aggregate !== undefined
        ? m.gap_aggregate.toFixed(2)
        : (() => {
            const match = report.content.match(/\*\*Score\*\*:\s*([\d.]+)/);
            return match ? parseFloat(match[1]).toFixed(2) : "?.??";
          })();
      const taskPart = m
        ? (m.task_id != null && m.task_action != null
            ? `task: ${m.task_id} (${m.task_action})`
            : "no task")
        : (() => {
            const taskIdMatch = report.content.match(/\*\*Task ID\*\*:\s*(.+)/);
            const actionMatch = report.content.match(/\*\*Action\*\*:\s*(.+)/);
            return taskIdMatch && actionMatch
              ? `task: ${taskIdMatch[1].trim()} (${actionMatch[1].trim()})`
              : "no task";
          })();
      const elapsed = m?.elapsed_ms !== undefined
        ? `${(m.elapsed_ms / 1000).toFixed(1)}s`
        : (() => {
            const match = report.content.match(/^([\d.]+)s$/m);
            return match ? `${match[1]}s` : "?s";
          })();
      const goalId = report.goal_id ?? "(no goal)";
      return `[Loop ${loopNum ?? "?"}] ${goalId} | gap: ${gap} | ${taskPart} | ${elapsed}`;
    }

    if (report.report_type === "daily_summary") {
      const dateMatch = report.title.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : "?";
      const loops = report.metadata?.loops_run
        ?? (() => {
            const m = report.content.match(/\*\*Loops run\*\*:\s*(\d+)/);
            return m ? m[1] : "?";
          })();
      const goalId = report.goal_id ?? "(no goal)";
      return `[Daily ${date}] ${goalId} | ${loops} loops`;
    }

    if (report.report_type === "weekly_report") {
      const dateMatch = report.title.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : "?";
      const totalLoops = report.metadata?.total_loops
        ?? (() => {
            const m = report.content.match(/\*\*Total loops run\*\*:\s*(\d+)/);
            return m ? m[1] : "?";
          })();
      const goalId = report.goal_id ?? "(no goal)";
      return `[Weekly ${date}] ${goalId} | ${totalLoops} total loops`;
    }

    // Notification types / fallback
    return `[${report.report_type}] ${report.goal_id ?? "(no goal)"} | ${report.title}`;
  }

  // ─── generateNotification ───

  async generateNotification(
    type: NotificationType,
    context: NotificationContext
  ): Promise<Report> {
    const now = new Date().toISOString();
    const { goalId, message, details } = context;

    let reportType: Report["report_type"];
    let title: string;

    switch (type) {
      case "urgent":
        reportType = "urgent_alert";
        title = `Urgent: ${message}`;
        break;
      case "approval_required":
        reportType = "approval_request";
        title = `Approval Required: ${message}`;
        break;
      case "stall_escalation":
        reportType = "stall_escalation";
        title = `Stall Escalation: ${message}`;
        break;
      case "completed":
        reportType = "goal_completion";
        title = `Goal Completed: ${message}`;
        break;
      case "capability_insufficient":
        reportType = "capability_escalation";
        title = `Capability Insufficient: ${message}`;
        break;
    }

    const detailsSection = details ? `\n\n### Details\n\n${details}` : "";

    // Determine whether to append a suggestions section based on communication_directness
    const directness = this.characterConfig.communication_directness;
    const isEscalation = type === "stall_escalation" || type === "capability_insufficient";
    const isStall = type === "stall_escalation";
    let suggestionsSection = "";
    if (directness <= 2) {
      // considerate: always suggest for escalation and stall
      if (isEscalation) {
        suggestionsSection = "\n\n### Suggested next actions:\n\n- Review current strategy and consider pivoting\n- Check available resources and constraints\n- Escalate to human operator if needed";
      }
    } else if (directness === 3) {
      // balanced: suggest only for escalation (not plain stall)
      if (isEscalation && !isStall) {
        suggestionsSection = "\n\n### Suggested next actions:\n\n- Review current strategy and consider pivoting\n- Check available resources and constraints\n- Escalate to human operator if needed";
      }
    }
    // directness 4-5: no suggestions section

    const content =
      `## ${title}\n\n` +
      `**Goal**: ${goalId}\n\n` +
      `### Message\n\n${message}${detailsSection}${suggestionsSection}\n\n` +
      `_Generated at ${now}_`;

    const report = ReportSchema.parse({
      id: crypto.randomUUID(),
      report_type: reportType,
      goal_id: goalId,
      title,
      content,
      verbosity: "standard",
      generated_at: now,
      delivered_at: null,
      read: false,
    });

    await this.saveReport(report);

    // Push notification (non-blocking)
    this.deliverReport(report).catch((err) => {
      console.warn("ReportingEngine: deliverReport failed", String(err));
    });

    return report;
  }

  // ─── generateTreeReport ───

  /**
   * Generate a tree visualization report for the given root goal.
   * Recursively traverses children_ids to build an indented text tree.
   * Each node shows: title, status, loop_status, specificity_score.
   */
  async generateTreeReport(rootId: string): Promise<Report> {
    const now = new Date().toISOString();
    const root = await this.stateManager.loadGoal(rootId);

    let content: string;

    if (!root) {
      content = `Goal Tree Report: (root goal "${rootId}" not found)`;
    } else {
      const lines: string[] = [`Goal Tree Report: ${root.title}`];

      const renderNode = async (goalId: string, prefix: string, isLast: boolean): Promise<void> => {
        const goal = await this.stateManager.loadGoal(goalId);
        if (!goal) return;

        const connector = isLast ? "└── " : "├── ";
        const specificity =
          goal.specificity_score !== null && goal.specificity_score !== undefined
            ? ` (specificity: ${goal.specificity_score.toFixed(2)})`
            : "";
        lines.push(
          `${prefix}${connector}${goal.title} [${goal.status}] [loop: ${goal.loop_status}]${specificity}`
        );

        const childPrefix = prefix + (isLast ? "    " : "│   ");
        const children = goal.children_ids;
        for (let i = 0; i < children.length; i++) {
          await renderNode(children[i], childPrefix, i === children.length - 1);
        }
      };

      const children = root.children_ids;
      for (let i = 0; i < children.length; i++) {
        await renderNode(children[i], "", i === children.length - 1);
      }

      content = lines.join("\n");
    }

    const report = ReportSchema.parse({
      id: crypto.randomUUID(),
      report_type: "execution_summary",
      goal_id: rootId,
      title: `Goal Tree Report — ${rootId}`,
      content,
      verbosity: "standard",
      generated_at: now,
      delivered_at: null,
      read: false,
    });

    return report;
  }

  // ─── Transfer Effect Report ───

  async generateTransferEffectReport(): Promise<Report> {
    const sections: string[] = [];
    sections.push('# Transfer Effect Summary\n');

    // Applied transfers count + success rate
    if (this.knowledgeTransfer) {
      const count = this.knowledgeTransfer.getAppliedTransferCount();
      const stats = this.knowledgeTransfer.getTransferSuccessRate();
      sections.push('## Transfer Statistics');
      sections.push(`- Applied transfers: ${count}`);
      sections.push(`- Evaluated: ${stats.total} (positive: ${stats.positive}, negative: ${stats.negative}, neutral: ${stats.neutral})`);
      sections.push(`- Success rate: ${(stats.rate * 100).toFixed(1)}%`);
      sections.push('');

      // Estimated time saved from gap reduction
      const records = this.knowledgeTransfer.getEffectivenessRecords();
      if (records.length > 0) {
        const avgGapDelta = records.reduce((sum, r) => sum + (r.gap_delta_before - r.gap_delta_after), 0) / records.length;
        sections.push('## Gap Reduction from Transfers');
        sections.push(`- Average gap reduction per transfer: ${avgGapDelta.toFixed(3)}`);
        sections.push(`- Total evaluated transfers: ${records.length}`);
        if (avgGapDelta > 0) {
          sections.push(`- Estimated acceleration: transfers are reducing gaps by ${(avgGapDelta * 100).toFixed(1)}% on average`);
        }
        sections.push('');
      }
    } else {
      sections.push('No transfer data available.\n');
    }

    // Domain-pair trust scores
    if (this.transferTrust) {
      try {
        const scores = await this.transferTrust.getAllScores();
        if (scores.length > 0) {
          sections.push('## Domain Pair Trust Scores');
          for (const s of scores) {
            sections.push(`- ${s.domain_pair}: trust=${s.trust_score.toFixed(2)} (success: ${s.success_count}, fail: ${s.failure_count}, neutral: ${s.neutral_count})`);
          }
          sections.push('');
        }
      } catch {
        // Trust scores unavailable — skip section
      }
    }

    const content = sections.join('\n');

    return ReportSchema.parse({
      id: `report_transfer_${crypto.randomUUID()}`,
      report_type: 'execution_summary',
      goal_id: 'cross-goal',
      title: 'Transfer Effect Summary',
      content,
      verbosity: 'standard',
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    });
  }

  // ─── deliverReport ───

  /** Deliver a report through push channels (if dispatcher configured) */
  async deliverReport(report: Report): Promise<void> {
    if (!this.notificationDispatcher) return;

    try {
      const results = await this.notificationDispatcher.dispatch(report);
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success && !r.suppressed).length;

      // Results are available for callers that want to inspect them;
      // we intentionally do not throw on failure here.
      void succeeded;
      void failed;
    } catch {
      // Don't let notification failures crash the loop
    }
  }
}
