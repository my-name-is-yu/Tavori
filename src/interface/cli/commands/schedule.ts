import { parseArgs } from "node:util";
import { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import {
  buildSchedulePresetEntry,
  listSchedulePresetDefinitions,
  type SchedulePresetInput,
} from "../../../runtime/schedule-presets.js";
import { DreamScheduleSuggestionStore } from "../../../platform/dream/dream-schedule-suggestions.js";
import type { ScheduleTriggerInput } from "../../../runtime/types/schedule.js";

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
    case "presets":
      return schedulePresetList();
    case "suggestions":
      return await scheduleSuggestions(baseDir, engine, argv.slice(1));
    default:
      console.log("Usage: pulseed schedule <list|add|remove|presets|suggestions>");
      console.log("  list                              List all schedule entries");
      console.log("  add                               Add a heartbeat entry or preset");
      console.log("  remove <id>                       Remove a schedule entry");
      console.log("  presets                           List reusable schedule presets");
      console.log("  suggestions <list|apply|reject|dismiss>  Review dream-generated suggestions");
  }
}

async function scheduleList(engine: ScheduleEngine): Promise<void> {
  const entries = engine.getEntries();
  if (entries.length === 0) {
    console.log("No schedule entries.");
    return;
  }
  for (const entry of entries) {
    const status = entry.enabled ? "enabled" : "disabled";
    const schedule = entry.trigger.type === "cron"
      ? entry.trigger.expression
      : `every ${entry.trigger.seconds}s`;
    const lastFired = entry.last_fired_at ?? "never";
    const source = entry.metadata?.source
      ? `${entry.metadata.source}${entry.metadata.preset_key ? `:${entry.metadata.preset_key}` : ""}`
      : "manual";
    console.log(
      `  ${entry.id.slice(0, 8)}  [${entry.layer}] ${entry.name}  (${schedule})  ${status}  source: ${source}  last: ${lastFired}`
    );
  }
}

function resolveOptionalTrigger(values: { cron?: string; interval?: string }): ScheduleTriggerInput | undefined {
  if (values.cron) {
    return { type: "cron", expression: values.cron, timezone: "UTC" };
  }
  if (values.interval) {
    return { type: "interval", seconds: parseInt(values.interval, 10), jitter_factor: 0 };
  }
  return undefined;
}

function buildPresetInput(values: Record<string, unknown>): SchedulePresetInput {
  const preset = String(values.preset ?? "");
  const trigger = resolveOptionalTrigger({
    cron: typeof values.cron === "string" ? values.cron : undefined,
    interval: typeof values.interval === "string" ? values.interval : undefined,
  });
  const common = {
    preset,
    name: typeof values.name === "string" ? values.name : undefined,
    enabled: true,
    ...(trigger ? { trigger } : {}),
  };

  switch (preset) {
    case "daily_brief":
    case "weekly_review":
    case "dream_consolidation":
      return {
        ...common,
        preset,
        context_sources: Array.isArray(values["context-source"])
          ? (values["context-source"] as string[])
          : typeof values["context-source"] === "string"
            ? [values["context-source"] as string]
            : [],
      };
    case "goal_probe":
      if (typeof values["data-source-id"] !== "string" || values["data-source-id"].length === 0) {
        throw new Error("--data-source-id is required for the goal_probe preset");
      }
      return {
        ...common,
        preset: "goal_probe",
        data_source_id: values["data-source-id"] as string,
        probe_dimension: typeof values["probe-dimension"] === "string"
          ? values["probe-dimension"] as string
          : undefined,
        query_params: {},
        detector_mode: (typeof values["detector-mode"] === "string"
          ? values["detector-mode"]
          : "diff") as "threshold" | "diff" | "presence",
        threshold_value: typeof values["threshold-value"] === "string"
          ? parseFloat(values["threshold-value"] as string)
          : undefined,
        baseline_window: typeof values["baseline-window"] === "string"
          ? parseInt(values["baseline-window"] as string, 10)
          : 5,
        llm_on_change: values["llm-on-change"] !== false,
        llm_prompt_template: typeof values["llm-prompt-template"] === "string"
          ? values["llm-prompt-template"] as string
          : undefined,
      };
    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

async function scheduleAdd(engine: ScheduleEngine, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      preset: { type: "string" },
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
      "data-source-id": { type: "string" },
      "detector-mode": { type: "string" },
      "threshold-value": { type: "string" },
      "baseline-window": { type: "string" },
      "probe-dimension": { type: "string" },
      "llm-on-change": { type: "boolean", default: true },
      "llm-prompt-template": { type: "string" },
      "context-source": { type: "string", multiple: true },
    },
    strict: false,
  });

  if (values.preset) {
    const presetInput = buildPresetInput(values);
    const entry = await engine.addEntry(buildSchedulePresetEntry(presetInput));
    console.log(`Added preset schedule entry: ${entry.id} (${entry.name})`);
    return;
  }

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
    metadata: {
      source: "manual",
      dependency_hints: [],
    },
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
  const entries = engine.getEntries();
  const match = entries.find((entry) => entry.id === id || entry.id.startsWith(id));
  if (!match) {
    console.error(`No schedule entry found matching: ${id}`);
    return;
  }
  await engine.removeEntry(match.id);
  console.log(`Removed schedule entry: ${match.id} (${match.name})`);
}

function schedulePresetList(): void {
  const definitions = listSchedulePresetDefinitions();
  for (const definition of definitions) {
    const trigger = definition.defaultTrigger.type === "cron"
      ? definition.defaultTrigger.expression
      : `every ${definition.defaultTrigger.seconds}s`;
    console.log(`${definition.key}`);
    console.log(`  ${definition.description}`);
    console.log(`  default trigger: ${trigger}`);
    console.log(`  dependencies: ${definition.dependencyHints.join(", ") || "none"}`);
  }
}

async function scheduleSuggestions(
  baseDir: string,
  engine: ScheduleEngine,
  argv: string[],
): Promise<void> {
  const store = new DreamScheduleSuggestionStore(baseDir);
  const action = argv[0] ?? "list";

  switch (action) {
    case "list": {
      const suggestions = await store.list();
      if (suggestions.length === 0) {
        console.log("No dream schedule suggestions.");
        return;
      }
      for (const suggestion of suggestions) {
        console.log(
          `  ${suggestion.id.slice(0, 8)}  [${suggestion.status}] ${suggestion.type}  goal=${suggestion.goalId ?? "-"}  proposal=${suggestion.proposal}`
        );
        console.log(`    ${suggestion.reason}`);
        if (suggestion.applied_entry_id) {
          console.log(`    applied entry: ${suggestion.applied_entry_id}`);
        }
      }
      return;
    }
    case "apply": {
      const id = argv[1];
      if (!id) {
        console.error("Error: dream suggestion ID is required");
        return;
      }
      const { entry, duplicate } = await store.applySuggestion(id, engine);
      console.log(
        duplicate
          ? `Matched existing schedule entry: ${entry.id} (${entry.name})`
          : `Applied dream suggestion to schedule entry: ${entry.id} (${entry.name})`
      );
      return;
    }
    case "reject":
    case "dismiss": {
      const id = argv[1];
      if (!id) {
        console.error("Error: dream suggestion ID is required");
        return;
      }
      const reason = argv.slice(2).join(" ").trim() || undefined;
      const suggestion = await store.markDecision(id, action === "reject" ? "rejected" : "dismissed", reason);
      console.log(`Marked dream suggestion ${suggestion.id} as ${suggestion.status}`);
      return;
    }
    default:
      console.error("Usage: pulseed schedule suggestions <list|apply|reject|dismiss> [id]");
  }
}
