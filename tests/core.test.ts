import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import {
  ObservationEngine,
  StateManager,
  MockEmbeddingClient,
  MockLLMClient,
  aggregateValues,
  combineDriveScores,
  cosineSimilarity,
  calculateDimensionGap,
  extractJSON,
  getNestedValue,
  rankDimensions,
  scoreAllDimensions,
  SessionManager,
  SatisficingJudge,
  TrustManager,
  StrategyManager,
  StallDetector,
  TaskLifecycle,
} from "../src/index.js";
import type { Goal } from "../src/types/goal.js";
import type { DriveConfig, DriveContext } from "../src/types/drive.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm/llm-client.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function makeGoal(goalId = "goal-core"): Goal {
  const now = new Date().toISOString();
  return {
    id: goalId,
    parent_id: null,
    node_type: "goal",
    title: "Core test goal",
    description: "Improve code quality",
    status: "active",
    dimensions: [
      {
        name: "coverage",
        label: "Coverage",
        current_value: 2,
        threshold: { type: "min", value: 5 },
        confidence: 0.4,
        observation_method: {
          type: "manual",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: now,
        history: [],
        weight: 1,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1,
    created_at: now,
    updated_at: now,
  };
}

function createMockLLMClient(responseContent: string): ILLMClient {
  return {
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      return {
        content: responseContent,
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/);
      return schema.parse(JSON.parse(match?.[1] ?? content));
    },
  };
}

afterEach(() => {
  // No-op hook retained so each test can clean up its own temp directory explicitly.
});

describe("core functionality", () => {
  it("observe records a self-report observation and preserves the current value", async () => {
    const tmpDir = makeTempDir();
    try {
      const stateManager = new StateManager(tmpDir);
      const goal = makeGoal("goal-observe");
      await stateManager.saveGoal(goal);

      const engine = new ObservationEngine(stateManager);
      await engine.observe(goal.id, []);

      const updatedGoal = await stateManager.loadGoal(goal.id);
      const observationLog = await stateManager.loadObservationLog(goal.id);

      expect(updatedGoal?.dimensions[0]?.current_value).toBe(2);
      expect(observationLog?.entries).toHaveLength(1);
      expect(observationLog?.entries[0]?.layer).toBe("self_report");
      expect(observationLog?.entries[0]?.extracted_value).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gap calculates the expected raw, normalized, and weighted values", () => {
    const result = calculateDimensionGap(
      {
        name: "coverage",
        current_value: 3,
        threshold: { type: "min", value: 10 },
        confidence: 0.5,
        uncertainty_weight: null,
      },
      1
    );

    expect(result.raw_gap).toBe(7);
    expect(result.normalized_gap).toBe(0.7);
    // 0.7 * (1 + 0.5 * 1.0) = 1.05, clamped to 1.0 by [0,1] invariant
    expect(result.normalized_weighted_gap).toBeCloseTo(1.0, 10);
  });

  it("score returns the expected drive score for a simple gap vector", () => {
    const config: DriveConfig = {
      decay_floor: 0.3,
      recovery_time_hours: 24,
      deadline_horizon_hours: 168,
      urgency_steepness: 3,
      urgency_override_threshold: 10,
      half_life_hours: 12,
    };

    const context: DriveContext = {
      time_since_last_attempt: { coverage: 0 },
      deadlines: { coverage: null },
      opportunities: {},
    };

    const scores = scoreAllDimensions(
      {
        goal_id: "goal-score",
        gaps: [
          {
            dimension_name: "coverage",
            raw_gap: 0.8,
            normalized_gap: 0.8,
            normalized_weighted_gap: 0.8,
            confidence: 0.9,
            uncertainty_weight: 1,
          },
        ],
        timestamp: new Date().toISOString(),
      },
      context,
      config
    );

    expect(scores).toHaveLength(1);
    expect(scores[0]?.dimension_name).toBe("coverage");
    expect(scores[0]?.dominant_drive).toBe("dissatisfaction");
    expect(scores[0]?.final_score).toBeCloseTo(0.24, 10);
  });

  it("task generates and persists a task for the requested dimension", async () => {
    const tmpDir = makeTempDir();
    try {
      const stateManager = new StateManager(tmpDir);
      const goal = makeGoal("goal-task");
      await stateManager.saveGoal(goal);

      const llmClient = createMockLLMClient(`\`\`\`json
{
  "work_description": "Add unit tests for coverage scoring",
  "rationale": "Coverage scoring needs regression protection",
  "approach": "Create focused Vitest cases for the scoring logic",
  "success_criteria": [
    {
      "description": "The new scoring tests pass",
      "verification_method": "Run vitest for the new test file",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["tests/core.test.ts"],
    "out_of_scope": ["production code changes"],
    "blast_radius": "tests only"
  },
  "constraints": ["Keep the test deterministic"],
  "reversibility": "reversible",
  "estimated_duration": { "value": 30, "unit": "minutes" }
}
\`\`\``);

      const lifecycle = new TaskLifecycle(
        stateManager,
        llmClient,
        new SessionManager(stateManager),
        new TrustManager(stateManager),
        new StrategyManager(stateManager, llmClient),
        new StallDetector(stateManager)
      );

      const task = await lifecycle.generateTask(goal.id, "coverage");
      const persisted = await stateManager.readRaw(`tasks/${goal.id}/${task.id}.json`) as
        | { primary_dimension?: string; work_description?: string; status?: string }
        | null;

      expect(task.primary_dimension).toBe("coverage");
      expect(task.work_description).toBe("Add unit tests for coverage scoring");
      expect(task.status).toBe("pending");
      expect(persisted?.primary_dimension).toBe("coverage");
      expect(persisted?.work_description).toBe("Add unit tests for coverage scoring");
      expect(persisted?.status).toBe("pending");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("extracts JSON from a fenced markdown response", () => {
    const content = `Before
\`\`\`json
{"status":"ok","count":2}
\`\`\`
After`;

    expect(extractJSON(content)).toBe('{"status":"ok","count":2}');
  });

  it("mock llm client returns configured responses in order", async () => {
    const llm = new MockLLMClient(['{"step":1}', '{"step":2}']);

    const first = await llm.sendMessage([{ role: "user", content: "first" }]);
    const second = await llm.sendMessage([{ role: "user", content: "second" }]);

    expect(first.content).toBe('{"step":1}');
    expect(second.content).toBe('{"step":2}');
    expect(llm.callCount).toBe(2);
  });

  it("reads nested values from plain objects", () => {
    const value = getNestedValue(
      { metrics: { quality: { coverage: 87 } } },
      "metrics.quality.coverage"
    );

    expect(value).toBe(87);
  });

  it("returns undefined for missing nested paths", () => {
    const value = getNestedValue({ metrics: { quality: {} } }, "metrics.quality.score");

    expect(value).toBeUndefined();
  });

  it("computes cosine similarity for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("creates deterministic unit-length mock embeddings", async () => {
    const client = new MockEmbeddingClient(8);

    const a = await client.embed("pulseed");
    const b = await client.embed("pulseed");

    expect(a).toEqual(b);
    expect(client.cosineSimilarity(a, b)).toBeCloseTo(1, 10);
  });

  it("aggregates values using average and all-required semantics", () => {
    expect(aggregateValues([0.5, 0.75, 1], "avg")).toBeCloseTo(0.75, 10);
    expect(aggregateValues([1, 0.8, 0.9], "all_required")).toBeCloseTo(0.8, 10);
  });

  it("uses the deadline score when urgency crosses the override threshold", () => {
    const combined = combineDriveScores(
      {
        dimension_name: "coverage",
        normalized_weighted_gap: 0.8,
        decay_factor: 0.5,
        score: 0.4,
      },
      {
        dimension_name: "coverage",
        normalized_weighted_gap: 0.8,
        urgency: 12,
        score: 0.9,
      },
      {
        dimension_name: "coverage",
        opportunity_value: 0.2,
        freshness_decay: 1,
        score: 0.2,
      },
      {
        decay_floor: 0.3,
        recovery_time_hours: 24,
        deadline_horizon_hours: 168,
        urgency_steepness: 3,
        urgency_override_threshold: 10,
        half_life_hours: 12,
      }
    );

    expect(combined.final_score).toBe(0.9);
    expect(combined.dominant_drive).toBe("deadline");
  });

  it("ranks dimensions by descending final score", () => {
    const ranked = rankDimensions([
      {
        dimension_name: "quality",
        dissatisfaction: 0.2,
        deadline: 0.1,
        opportunity: 0.3,
        final_score: 0.3,
        dominant_drive: "opportunity",
      },
      {
        dimension_name: "coverage",
        dissatisfaction: 0.7,
        deadline: 0.2,
        opportunity: 0.1,
        final_score: 0.7,
        dominant_drive: "dissatisfaction",
      },
    ]);

    expect(ranked.map((score) => score.dimension_name)).toEqual(["coverage", "quality"]);
  });

  it("applies the satisficing confidence ceiling for medium-confidence progress", () => {
    const tmpDir = makeTempDir();
    try {
      const judge = new SatisficingJudge(new StateManager(tmpDir));

      expect(judge.applyProgressCeiling(0.95, 0.6)).toBe(0.85);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
