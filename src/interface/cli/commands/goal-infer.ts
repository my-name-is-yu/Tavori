// ─── goal-infer.ts: LLM-powered dimension inference for goal add ───

import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getCliLogger } from "../cli-logger.js";
import { ThresholdTypeEnum } from "../../base/types/core.js";

// ─── Types ───

export interface InferredDimension {
  name: string;
  type: "min" | "max" | "range" | "present" | "match";
  value: string;
}

// ─── Zod schema ───

const InferredDimensionSchema = z.object({
  name: z.string(),
  type: ThresholdTypeEnum,
  value: z.string(),
});

const InferredDimensionsSchema = z.array(InferredDimensionSchema);

// ─── Prompt builder ───

function buildInferPrompt(title: string): string {
  return `Given this goal title, suggest 1-5 measurable dimensions for tracking progress.

Threshold types:
- min: value must be >= X (e.g. test coverage >= 80%)
- max: value must be <= X (e.g. bug count <= 5)
- range: value must be between low,high (e.g. "10,20")
- present: boolean check — something must exist (value: "true" or "false")
- match: exact match required (e.g. status must equal "published")

Goal: "${title}"

Return a JSON array only, no explanation:
[{"name": "snake_case_name", "type": "min|max|range|present|match", "value": "threshold_value"}]`;
}

// ─── Sanitizer ───

function sanitizeDimensions(raw: unknown[]): unknown[] {
  const validTypes = ThresholdTypeEnum.options;
  return raw.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null &&
    validTypes.includes(String((item as Record<string, unknown>)["type"]) as typeof validTypes[number])
  );
}

// ─── Main function ───

export async function inferDimensionsFromTitle(
  title: string,
  llmClient: ILLMClient
): Promise<InferredDimension[]> {
  const logger = getCliLogger();
  const prompt = buildInferPrompt(title);

  let content: string;
  try {
    const response = await llmClient.sendMessage([{ role: "user", content: prompt }], {
      max_tokens: 512,
      temperature: 0,
    });
    content = response.content;
  } catch (err) {
    logger.warn(`inferDimensionsFromTitle: LLM call failed — ${String(err)}`);
    return [];
  }

  try {
    const raw = llmClient.parseJSON(content, z.array(z.unknown()));
    const sanitized = sanitizeDimensions(raw);
    const result = InferredDimensionsSchema.safeParse(sanitized);
    if (!result.success) {
      logger.warn(`inferDimensionsFromTitle: validation failed — ${result.error.message}`);
      return [];
    }
    return result.data;
  } catch (err) {
    logger.warn(`inferDimensionsFromTitle: parse failed — ${String(err)}`);
    return [];
  }
}

// ─── Formatter ───

export function formatInferredDimensions(dims: InferredDimension[]): string {
  return dims
    .map((d, i) => `  ${i + 1}. ${d.name}  [${d.type}]  threshold: ${d.value}`)
    .join("\n");
}
