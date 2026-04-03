import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import type { Goal } from "../src/types/goal.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import { z } from "zod";
import { makeTempDir } from "./helpers/temp-dir.js";
import { randomUUID } from "node:crypto";

// ─── Prompt Capture Mock ───

class PromptCaptureMockLLM implements ILLMClient {
  capturedMessages: { role: string; content: string }[] = [];
  responseScore = 0.5;

  async sendMessage(
    messages: { role: string; content: string }[]
  ): Promise<{ content: string; usage: { input_tokens: number; output_tokens: number }; stop_reason: string }> {
    this.capturedMessages = messages;
    return {
      content: JSON.stringify({ score: this.responseScore, reason: "test" }),
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "end_turn",
    };
  }

  parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
    return schema.parse(JSON.parse(content));
  }
}

// ─── Helpers ───

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: overrides.description ?? "Reduce TODOs to zero",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "todo_count",
        label: "TODO Count",
        current_value: 3,
        threshold: { type: "min", value: 0 },
        confidence: 0.5,
        last_updated: now,
        history: [],
        observation_method: {
          type: "llm_review",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "independent_review",
        },
      },
    ],
    constraints: [],
    created_at: now,
    updated_at: now,
    satisficing_threshold: 0.8,
    priority: 5,
    tags: [],
    metadata: {},
  };
}

// ─── Tests ───

describe("observeWithLLM prompt quality", () => {
  it("prompt contains FEW-SHOT CALIBRATION section", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      "some workspace content",
      null,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    expect(promptContent).toContain("FEW-SHOT CALIBRATION");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("prompt contains CRITICAL RULES section", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      "some workspace content",
      null,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    expect(promptContent).toContain("CRITICAL RULES");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("when workspace context is absent, prompt contains Score MUST be 0.0 warning", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    // Inject a no-op gitContextFetcher so git diff fallback does not supply context
    const engine = new ObservationEngine(stateManager, [], mockLLM, undefined, {
      gitContextFetcher: () => "",
    });

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      undefined, // no workspace context
      null,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    expect(promptContent).toContain("Score MUST be 0.0");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("when workspace context is present, prompt contains the context content", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const workspaceContent = "src/foo.ts:42: TODO fix this auth bug";

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      workspaceContent,
      null,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    expect(promptContent).toContain(workspaceContent);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("prompt contains previous score value when provided", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      "some content",
      0.42,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    expect(promptContent).toContain("0.42");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("prompt contains Previous score: none when no previous score", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      "some content",
      null,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    expect(promptContent).toContain("Previous score: none");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("prompt does NOT contain Japanese characters", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      "some content",
      null,
      true
    );

    const promptContent = mockLLM.capturedMessages[0]!.content;
    // Japanese Unicode block: U+3000-U+9FFF
    expect(promptContent).not.toMatch(/[\u3000-\u9FFF]/);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("mock LLM returning score 0.0 produces extracted value 0.0 for min threshold value 0", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    mockLLM.responseScore = 0.0;
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const goal = makeGoal();
    await stateManager.saveGoal(goal);

    const entry = await engine.observeWithLLM(
      goal.id,
      "todo_count",
      goal.description,
      "TODO Count",
      JSON.stringify({ type: "min", value: 0 }),
      "some content",
      null,
      true
    );

    expect(entry.extracted_value).toBe(0.0);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("mock LLM returning score 1.0 produces extracted value matching target threshold for min threshold > 1", async () => {
    const tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    const mockLLM = new PromptCaptureMockLLM();
    mockLLM.responseScore = 1.0;
    const engine = new ObservationEngine(stateManager, [], mockLLM);

    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      parent_id: null,
      node_type: "goal",
      title: "Test Goal",
      description: "Reach 100 test count",
      status: "active",
      dimensions: [
        {
          name: "test_count",
          label: "Test Count",
          current_value: 0,
          threshold: { type: "min", value: 100 },
          confidence: 0.5,
          last_updated: now,
          history: [],
          observation_method: {
            type: "llm_review",
            source: "test",
            schedule: null,
            endpoint: null,
            confidence_tier: "independent_review",
          },
        },
      ],
      constraints: [],
      created_at: now,
      updated_at: now,
      satisficing_threshold: 0.8,
      priority: 5,
      tags: [],
      metadata: {},
    };
    await stateManager.saveGoal(goal);

    const entry = await engine.observeWithLLM(
      goal.id,
      "test_count",
      goal.description,
      "Test Count",
      JSON.stringify({ type: "min", value: 100 }),
      "100 tests passing",
      null,
      true
    );

    // score=1.0 * threshold.value=100 => 100
    expect(entry.extracted_value).toBe(100);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
