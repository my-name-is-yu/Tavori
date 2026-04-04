import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { generateTaskGroup } from "../task/task-generation.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";

// ─── Spy LLM Client ───

function createSpyLLMClient(response: string): ILLMClient & {
  lastMessages: LLMMessage[];
  lastOptions?: LLMRequestOptions;
} {
  const client = {
    lastMessages: [] as LLMMessage[],
    lastOptions: undefined as LLMRequestOptions | undefined,
    async sendMessage(
      messages: LLMMessage[],
      options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      client.lastMessages = messages;
      client.lastOptions = options;
      return {
        content: response,
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) ?? [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
  return client;
}

// ─── Fixtures ───

const VALID_TASK_GROUP_RESPONSE = `\`\`\`json
{
  "subtasks": [
    {
      "work_description": "Add unit tests for the auth module",
      "rationale": "Improve coverage",
      "approach": "Use vitest",
      "target_dimension": "test_coverage",
      "success_criteria": [
        { "description": "All auth flows have tests", "verification_method": "Run vitest", "is_blocking": true }
      ],
      "scope_boundary": {
        "in_scope": ["tests/auth.test.ts"],
        "out_of_scope": ["src/auth/"],
        "blast_radius": "tests/ directory only"
      },
      "constraints": [],
      "reversibility": "reversible"
    },
    {
      "work_description": "Refactor auth module for clarity",
      "rationale": "Reduce complexity",
      "approach": "Extract helpers",
      "target_dimension": "code_quality",
      "success_criteria": [
        { "description": "Cyclomatic complexity reduced", "verification_method": "Run complexity analysis", "is_blocking": true }
      ],
      "scope_boundary": {
        "in_scope": ["src/auth/"],
        "out_of_scope": ["tests/"],
        "blast_radius": "src/auth/ directory only"
      },
      "constraints": [],
      "reversibility": "reversible"
    }
  ],
  "dependencies": [],
  "file_ownership": { "0": ["tests/auth.test.ts"], "1": ["src/auth/index.ts"] },
  "shared_context": "Auth module refactor sprint"
}
\`\`\``;

// ─── Tests ───

describe("generateTaskGroup", () => {
  it("returns a TaskGroup on valid LLM response", async () => {
    const client = createSpyLLMClient(VALID_TASK_GROUP_RESPONSE);
    const result = await generateTaskGroup(client, {
      goalDescription: "Improve auth module",
      targetDimension: "test_coverage",
      currentState: "60%",
      gap: 0.4,
      availableAdapters: ["claude-code-cli"],
    });

    expect(result).not.toBeNull();
    expect(result?.subtasks).toHaveLength(2);
    expect(result?.shared_context).toBe("Auth module refactor sprint");
  });

  it("includes contextBlock in the prompt when provided", async () => {
    const client = createSpyLLMClient(VALID_TASK_GROUP_RESPONSE);
    const contextBlock = "<lesson>Avoid touching auth middleware directly</lesson>";

    await generateTaskGroup(client, {
      goalDescription: "Improve auth module",
      targetDimension: "test_coverage",
      currentState: "60%",
      gap: 0.4,
      availableAdapters: ["claude-code-cli"],
      contextBlock,
    });

    expect(client.lastMessages).toHaveLength(1);
    const promptContent = client.lastMessages[0]?.content as string;
    expect(promptContent).toContain("Relevant context from past experience:");
    expect(promptContent).toContain(contextBlock);
  });

  it("does NOT include context section in the prompt when contextBlock is absent", async () => {
    const client = createSpyLLMClient(VALID_TASK_GROUP_RESPONSE);

    await generateTaskGroup(client, {
      goalDescription: "Improve auth module",
      targetDimension: "test_coverage",
      currentState: "60%",
      gap: 0.4,
      availableAdapters: ["claude-code-cli"],
    });

    const promptContent = client.lastMessages[0]?.content as string;
    expect(promptContent).not.toContain("Relevant context from past experience:");
  });

  it("returns null on LLM error", async () => {
    const errorClient: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        throw new Error("Network error");
      },
      parseJSON<T>(_content: string, schema: z.ZodSchema<T>): T {
        return schema.parse({});
      },
    };

    const result = await generateTaskGroup(errorClient, {
      goalDescription: "Improve auth module",
      targetDimension: "test_coverage",
      currentState: "60%",
      gap: 0.4,
      availableAdapters: ["claude-code-cli"],
    });

    expect(result).toBeNull();
  });

  it("returns null on invalid LLM JSON response", async () => {
    const client = createSpyLLMClient("not valid json at all");

    const result = await generateTaskGroup(client, {
      goalDescription: "Improve auth module",
      targetDimension: "test_coverage",
      currentState: "60%",
      gap: 0.4,
      availableAdapters: ["claude-code-cli"],
    });

    expect(result).toBeNull();
  });

  it("contextBlock appears after goal/gap info and before JSON instructions", async () => {
    const client = createSpyLLMClient(VALID_TASK_GROUP_RESPONSE);
    const contextBlock = "<reflection>Previous attempt failed due to missing mocks</reflection>";

    await generateTaskGroup(client, {
      goalDescription: "Fix test suite",
      targetDimension: "test_pass_rate",
      currentState: "80%",
      gap: 0.2,
      availableAdapters: ["shell"],
      contextBlock,
    });

    const promptContent = client.lastMessages[0]?.content as string;
    const contextIdx = promptContent.indexOf("Relevant context from past experience:");
    const jsonInstructionIdx = promptContent.indexOf("Respond with a JSON object");
    const gapIdx = promptContent.indexOf("Gap to close:");

    expect(contextIdx).toBeGreaterThan(gapIdx);
    expect(contextIdx).toBeLessThan(jsonInstructionIdx);
  });
});
