import { z } from "zod";

// Daemon configuration
export const DaemonConfigSchema = z.object({
  runtime_journal_v2: z.boolean().default(false),
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
  iterations_per_cycle: z.number().int().positive().default(10), // max CoreLoop iterations per daemon cycle
  event_server_port: z.number().int().nonnegative().default(41700), // EventServer HTTP port (0 = OS-assigned, safe for tests)
  proactive_mode: z.boolean().default(false),
  proactive_interval_ms: z.number().default(3_600_000), // 1 hour minimum between proactive ticks
  adaptive_sleep: z.object({
    enabled: z.boolean().default(false),
    min_interval_ms: z.number().default(60_000),      // 1 minute minimum
    max_interval_ms: z.number().default(1_800_000),    // 30 minutes maximum
    night_start_hour: z.number().default(22),           // 22:00
    night_end_hour: z.number().default(7),              // 07:00
    night_multiplier: z.number().default(2.0),          // 2x interval at night
  }).default({}),
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
