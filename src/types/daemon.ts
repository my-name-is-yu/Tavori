import { z } from "zod";

// Daemon configuration
export const DaemonConfigSchema = z.object({
  check_interval_ms: z.number().int().positive().default(300_000), // 5 min default
  pid_file: z.string().default("pulseed.pid"),
  log_dir: z.string().default("logs"),
  log_rotation: z.object({
    max_size_mb: z.number().positive().default(10),
    max_files: z.number().int().positive().default(5),
  }).default({}),
  crash_recovery: z.object({
    enabled: z.boolean().default(true),
    max_retries: z.number().int().nonnegative().default(3),
    retry_delay_ms: z.number().int().positive().default(10_000),
    graceful_shutdown_timeout_ms: z.number().int().positive().optional(),
  }).default({}),
  goal_intervals: z.record(z.string(), z.number().int().positive()).optional(), // goal_id -> interval_ms override
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

// Daemon runtime state
export const DaemonStateSchema = z.object({
  pid: z.number().int().positive(),
  started_at: z.string().datetime(),
  last_loop_at: z.string().datetime().nullable(),
  loop_count: z.number().int().nonnegative(),
  active_goals: z.array(z.string()),
  status: z.enum(["running", "stopping", "stopped", "crashed"]),
  crash_count: z.number().int().nonnegative().default(0),
  last_error: z.string().nullable().default(null),
  interrupted_goals: z.array(z.string()).optional(),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

// PID file info
export const PIDInfoSchema = z.object({
  pid: z.number().int().positive(),
  started_at: z.string().datetime(),
  version: z.string().optional(),
});
export type PIDInfo = z.infer<typeof PIDInfoSchema>;
