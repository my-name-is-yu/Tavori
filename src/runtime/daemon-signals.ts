/**
 * daemon-signals.ts
 *
 * Standalone utilities for daemon scheduling / cron entry generation.
 * Extracted from DaemonRunner to keep daemon-runner.ts focused on the loop.
 */

/**
 * Generate a crontab entry that runs `pulseed run --goal <goalId>` on a schedule.
 *
 * Rules:
 *   intervalMinutes <= 0 → treated as 60
 *   intervalMinutes < 60 → every N minutes:   *\/N * * * *
 *   intervalMinutes < 1440 (1 day) → every N hours: 0 *\/N * * *
 *   intervalMinutes >= 1440 → once per day:   0 0 * * *
 */
export function generateCronEntry(goalId: string, intervalMinutes: number = 60): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(goalId)) {
    throw new Error(`Invalid goalId for cron entry: "${goalId}" (only alphanumeric, underscore, hyphen allowed)`);
  }
  if (intervalMinutes <= 0) intervalMinutes = 60;

  if (intervalMinutes < 60) {
    return `*/${intervalMinutes} * * * * /usr/bin/env pulseed run --goal ${goalId}`;
  }

  const hours = Math.floor(intervalMinutes / 60);
  if (hours < 24) {
    return `0 */${hours} * * * /usr/bin/env pulseed run --goal ${goalId}`;
  }

  return `0 0 * * * /usr/bin/env pulseed run --goal ${goalId}`;
}
