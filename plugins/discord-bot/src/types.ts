export type NotificationEventType =
  | "goal_progress"
  | "goal_complete"
  | "task_blocked"
  | "approval_needed"
  | "stall_detected"
  | "trust_change"
  | "schedule_change_detected"
  | "schedule_heartbeat_failure"
  | "schedule_escalation"
  | "schedule_report_ready";

export interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string;
  summary: string;
  details: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
}

export interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}
