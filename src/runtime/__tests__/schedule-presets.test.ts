import { describe, expect, it } from "vitest";
import {
  SchedulePresetInputSchema,
  buildSchedulePresetEntry,
  getSchedulePresetDefinition,
  listSchedulePresetDefinitions,
} from "../schedule-presets.js";

describe("schedule-presets", () => {
  it("lists the supported reusable presets", () => {
    expect(listSchedulePresetDefinitions().map((definition) => definition.key)).toEqual([
      "daily_brief",
      "weekly_review",
      "dream_consolidation",
      "goal_probe",
    ]);
  });

  it("builds the daily brief preset as a reflection cron entry", () => {
    const entry = buildSchedulePresetEntry(SchedulePresetInputSchema.parse({
      preset: "daily_brief",
    }));

    expect(entry).toEqual(expect.objectContaining({
      name: "Daily brief",
      layer: "cron",
      metadata: expect.objectContaining({
        source: "preset",
        preset_key: "daily_brief",
      }),
      cron: expect.objectContaining({
        job_kind: "reflection",
        reflection_kind: "morning_planning",
        output_format: "notification",
      }),
    }));
  });

  it("builds the goal probe preset as a probe entry", () => {
    const entry = buildSchedulePresetEntry(SchedulePresetInputSchema.parse({
      preset: "goal_probe",
      data_source_id: "source-1",
      probe_dimension: "open_issue_count",
      detector_mode: "threshold",
      threshold_value: 0.8,
      baseline_window: 7,
    }));

    expect(entry).toEqual(expect.objectContaining({
      name: "Goal probe",
      layer: "probe",
      metadata: expect.objectContaining({
        source: "preset",
        preset_key: "goal_probe",
      }),
      probe: expect.objectContaining({
        data_source_id: "source-1",
        probe_dimension: "open_issue_count",
        change_detector: expect.objectContaining({
          mode: "threshold",
          threshold_value: 0.8,
          baseline_window: 7,
        }),
      }),
    }));
  });

  it("uses the preset default trigger when none is provided", () => {
    const definition = getSchedulePresetDefinition("weekly_review");
    const entry = buildSchedulePresetEntry(SchedulePresetInputSchema.parse({
      preset: "weekly_review",
    }));

    expect(entry.trigger).toEqual(definition.defaultTrigger);
  });

  it("rejects missing required preset input", () => {
    const parsed = SchedulePresetInputSchema.safeParse({
      preset: "goal_probe",
    });

    expect(parsed.success).toBe(false);
  });
});
