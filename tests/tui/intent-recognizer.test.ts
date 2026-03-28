import { describe, it, expect } from "vitest";
import { z } from "zod";
import { IntentRecognizer } from "../../src/tui/intent-recognizer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/llm/llm-client.js";
import { createSingleMockLLMClient as makeMockLLMClient } from "../helpers/mock-llm.js";

// ─── Keyword matching ───

describe("IntentRecognizer — keyword matching", () => {
  const recognizer = new IntentRecognizer(); // no LLM

  it("recognizes loop_stop: '/stop'", async () => {
    const result = await recognizer.recognize("/stop");
    expect(result.intent).toBe("loop_stop");
    expect(result.raw).toBe("/stop");
  });

  it("recognizes loop_stop: '/quit'", async () => {
    const result = await recognizer.recognize("/quit");
    expect(result.intent).toBe("loop_stop");
  });

  it("recognizes loop_start: '/run'", async () => {
    const result = await recognizer.recognize("/run");
    expect(result.intent).toBe("loop_start");
  });

  it("recognizes loop_start: '/start'", async () => {
    const result = await recognizer.recognize("/start");
    expect(result.intent).toBe("loop_start");
  });

  it("recognizes status: '/status'", async () => {
    const result = await recognizer.recognize("/status");
    expect(result.intent).toBe("status");
  });

  it("recognizes report: '/report'", async () => {
    const result = await recognizer.recognize("/report");
    expect(result.intent).toBe("report");
  });

  it("recognizes goal_list: '/goals'", async () => {
    const result = await recognizer.recognize("/goals");
    expect(result.intent).toBe("goal_list");
  });

  it("recognizes help: '/help'", async () => {
    const result = await recognizer.recognize("/help");
    expect(result.intent).toBe("help");
  });

  it("recognizes help: '?'", async () => {
    const result = await recognizer.recognize("?");
    expect(result.intent).toBe("help");
  });

  it("returns unknown for unrecognized input without LLM", async () => {
    const result = await recognizer.recognize("READMEを書いてほしい");
    expect(result.intent).toBe("unknown");
    expect(result.raw).toBe("READMEを書いてほしい");
  });

  it("preserves original raw input", async () => {
    const input = "  /stop  ";
    const result = await recognizer.recognize(input);
    expect(result.raw).toBe(input);
  });

  // ─── Bare words without / prefix are NOT commands ───

  it("bare 'help' is NOT the help command (treated as unknown without LLM)", async () => {
    const result = await recognizer.recognize("help");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'run' is NOT the run command (treated as unknown without LLM)", async () => {
    const result = await recognizer.recognize("run");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'stop' is NOT the stop command (treated as unknown without LLM)", async () => {
    const result = await recognizer.recognize("stop");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'status' is NOT the status command (treated as unknown without LLM)", async () => {
    const result = await recognizer.recognize("status");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'report' is NOT the report command (treated as unknown without LLM)", async () => {
    const result = await recognizer.recognize("report");
    expect(result.intent).toBe("unknown");
  });

  it("bare 'goals' is NOT the goal_list command (treated as unknown without LLM)", async () => {
    const result = await recognizer.recognize("goals");
    expect(result.intent).toBe("unknown");
  });

  it("natural sentence 'how does help work?' is NOT the help command", async () => {
    const result = await recognizer.recognize("how does help work?");
    expect(result.intent).toBe("unknown");
  });

  it("natural sentence 'how do I run this?' is NOT the run command", async () => {
    const result = await recognizer.recognize("how do I run this?");
    expect(result.intent).toBe("unknown");
  });

  it("recognizes dashboard: '/dashboard'", async () => {
    const result = await recognizer.recognize("/dashboard");
    expect(result.intent).toBe("dashboard");
  });

  it("recognizes dashboard case-insensitively: '/Dashboard'", async () => {
    const result = await recognizer.recognize("/Dashboard");
    expect(result.intent).toBe("dashboard");
  });
});

// ─── LLM fallback ───

describe("IntentRecognizer — LLM fallback", () => {
  it("returns chat intent with response for conversational input", async () => {
    const mockResponse = JSON.stringify({
      intent: "chat",
      response: "PulSeed manages goals with measurable dimensions. You currently have no active goals.",
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("What can PulSeed do?");
    expect(result.intent).toBe("chat");
    expect(result.response).toBe("PulSeed manages goals with measurable dimensions. You currently have no active goals.");
  });

  it("returns goal_create intent with description in params when user clearly wants to create a goal", async () => {
    const mockResponse = JSON.stringify({
      intent: "goal_create",
      response: "Creating goal: write a README",
      params: { description: "READMEを書く" },
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("READMEを書いてほしい");
    expect(result.intent).toBe("goal_create");
    expect(result.params?.["description"]).toBe("READMEを書く");
  });

  it("LLM fallback returns loop_start intent with goalId param", async () => {
    const mockResponse = JSON.stringify({
      intent: "loop_start",
      response: "Starting goal goal-123.",
      params: { goalId: "goal-123" },
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("goal-123を実行してください");
    expect(result.intent).toBe("loop_start");
    expect(result.params?.["goalId"]).toBe("goal-123");
  });

  it("falls back to unknown on LLM error", async () => {
    const llm: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        throw new Error("LLM unavailable");
      },
      parseJSON<T>(_c: string, _s: z.ZodSchema<T>): T {
        throw new Error("unreachable");
      },
    };
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("something unknown");
    expect(result.intent).toBe("unknown");
  });

  it("chat intent populates response field on RecognizedIntent", async () => {
    const mockResponse = JSON.stringify({
      intent: "chat",
      response: "You can use 'run' to start the goal loop.",
    });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("how do I start?");
    expect(result.response).toBe("You can use 'run' to start the goal loop.");
    expect(result.params?.["response"]).toBe("You can use 'run' to start the goal loop.");
  });

  it("returns unknown intent when LLM responds with 'unknown'", async () => {
    const mockResponse = JSON.stringify({ intent: "unknown" });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("some ambiguous input");
    expect(result.intent).toBe("unknown");
  });

  it("does not include empty params object when no params returned", async () => {
    const mockResponse = JSON.stringify({ intent: "chat", response: "Hello!" });
    const llm = makeMockLLMClient(mockResponse);
    const recognizer = new IntentRecognizer(llm);

    const result = await recognizer.recognize("hi");
    // params will contain the response string but not description/goalId keys
    expect(result.params?.["description"]).toBeUndefined();
    expect(result.params?.["goalId"]).toBeUndefined();
  });
});
