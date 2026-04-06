import { parseArgs } from "node:util";
import { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import type { StateManager } from "../../../base/state/state-manager.js";

export async function cmdSchedule(
  stateManager: StateManager,
  argv: string[],
): Promise<void> {
  const subcommand = argv[0];
  const baseDir = stateManager.getBaseDir();
  const engine = new ScheduleEngine({ baseDir });
  await engine.loadEntries();

  switch (subcommand) {
    case "list":
      return await scheduleList(engine);
    case "add":
      return await scheduleAdd(engine, argv.slice(1));
    case "remove":
      return await scheduleRemove(engine, argv.slice(1));
    default:
      console.log("Usage: pulseed schedule <list|add|remove>");
      console.log("  list              List all schedule entries");
      console.log("  add               Add a heartbeat entry");
      console.log("  remove <id>       Remove a schedule entry");
  }
}

async function scheduleList(engine: ScheduleEngine): Promise<void> {
  const entries = engine.getEntries();
  if (entries.length === 0) {
    console.log("No schedule entries.");
    return;
  }
  for (const e of entries) {
    const status = e.enabled ? "enabled" : "disabled";
    const layer = e.layer;
    const schedule = e.trigger.type === "cron" ? e.trigger.expression : `every ${e.trigger.seconds}s`;
    const lastFired = e.last_fired_at ?? "never";
    console.log(`  ${e.id.slice(0, 8)}  [${layer}] ${e.name}  (${schedule})  ${status}  last: ${lastFired}`);
  }
}

async function scheduleAdd(engine: ScheduleEngine, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      type: { type: "string", default: "http" },
      url: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      pid: { type: "string" },
      path: { type: "string" },
      command: { type: "string" },
      cron: { type: "string" },
      interval: { type: "string" },
      threshold: { type: "string", default: "3" },
    },
    strict: false,
  });

  if (!values.name) {
    console.error("Error: --name is required");
    return;
  }

  const checkType = values.type as "http" | "tcp" | "process" | "disk" | "custom";
  const checkConfig: Record<string, unknown> = {};
  if (values.url) checkConfig.url = values.url;
  if (values.host) checkConfig.host = values.host;
  if (values.port) checkConfig.port = parseInt(values.port as string, 10);
  if (values.pid) checkConfig.pid = parseInt(values.pid as string, 10);
  if (values.path) checkConfig.path = values.path;
  if (values.command) checkConfig.command = values.command;

  const trigger = values.cron
    ? { type: "cron" as const, expression: values.cron as string, timezone: "UTC" }
    : { type: "interval" as const, seconds: parseInt(values.interval as string || "60", 10), jitter_factor: 0 };

  const entry = await engine.addEntry({
    name: values.name as string,
    layer: "heartbeat",
    trigger,
    enabled: true,
    heartbeat: {
      check_type: checkType,
      check_config: checkConfig,
      failure_threshold: parseInt(values.threshold as string, 10),
      timeout_ms: 5000,
    },
  });

  console.log(`Added schedule entry: ${entry.id} (${entry.name})`);
}

async function scheduleRemove(engine: ScheduleEngine, argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.error("Error: schedule entry ID is required");
    return;
  }
  // Support short IDs (first 8 chars)
  const entries = engine.getEntries();
  const match = entries.find(e => e.id === id || e.id.startsWith(id));
  if (!match) {
    console.error(`No schedule entry found matching: ${id}`);
    return;
  }
  await engine.removeEntry(match.id);
  console.log(`Removed schedule entry: ${match.id} (${match.name})`);
}
