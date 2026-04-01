import type { Report } from "../types/report.js";

type Priority = "immediate" | "batchable" | "digest_only";

const IMMEDIATE_TYPES = new Set(["goal_completion", "urgent_alert", "approval_request"]);
const BATCHABLE_TYPES = new Set(["daily_summary", "strategy_change", "execution_summary"]);

export class NotificationBatcher {
  private queue: Array<{ report: Report; timestamp: number }> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: { window_minutes: number; digest_format: "compact" | "detailed" },
    private flushCallback: (digest: Report) => Promise<void>
  ) {}

  /** Classify a report type into a dispatch priority tier. */
  static getPriority(reportType: string): Priority {
    if (IMMEDIATE_TYPES.has(reportType)) return "immediate";
    if (BATCHABLE_TYPES.has(reportType)) return "batchable";
    // stall_escalation, capability_escalation, weekly_report, etc.
    return "digest_only";
  }

  /**
   * Add a report to the queue.
   * Returns true if batched, false if it should be sent immediately.
   */
  add(report: Report): boolean {
    const priority = NotificationBatcher.getPriority(report.report_type);
    if (priority === "immediate") return false;

    this.queue.push({ report, timestamp: Date.now() });
    if (this.timer === null) this.startTimer();
    return true;
  }

  /** Flush queued reports as a single digest, then clear the queue. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const items = this.queue.splice(0);
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const digest = this.buildDigest(items);
    await this.flushCallback(digest);
  }

  /** Stop the timer and flush remaining items. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  // ─── Private helpers ───

  private startTimer(): void {
    const ms = this.config.window_minutes * 60 * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private buildDigest(items: Array<{ report: Report; timestamp: number }>): Report {
    // Group by goal_id
    const byGoal = new Map<string, Report[]>();
    for (const { report } of items) {
      const key = report.goal_id ?? "__none__";
      const group = byGoal.get(key) ?? [];
      group.push(report);
      byGoal.set(key, group);
    }

    const sections: string[] = [];
    for (const [goalId, reports] of byGoal) {
      const header = goalId === "__none__" ? "No goal" : `Goal: ${goalId}`;
      if (this.config.digest_format === "detailed") {
        const lines = reports.map((r) => `- [${r.report_type}] ${r.title}: ${r.content}`);
        sections.push(`${header}\n${lines.join("\n")}`);
      } else {
        const types = reports.map((r) => r.report_type).join(", ");
        sections.push(`${header}: ${reports.length} report(s) (${types})`);
      }
    }

    const first = items[0].report;
    return {
      id: `digest-${Date.now()}`,
      report_type: "daily_summary",
      goal_id: first.goal_id,
      title: `Digest: ${items.length} batched report(s)`,
      content: sections.join("\n\n"),
      verbosity: "standard",
      generated_at: new Date().toISOString(),
      delivered_at: null,
      read: false,
    };
  }
}
