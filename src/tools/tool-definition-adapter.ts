import { zodToJsonSchema } from "zod-to-json-schema";
import type { ITool } from "./types.js";
import type { ToolDefinition } from "../base/llm/llm-client.js";

/**
 * Convert a single ITool instance to a ToolDefinition (JSON schema format)
 * that the LLM client understands for function calling.
 */
export function toToolDefinition(tool: ITool): ToolDefinition {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, { target: "openApi3" });
  // zodToJsonSchema may wrap in { $schema, ... } — extract the relevant parts
  const parameters: Record<string, unknown> = {};
  if (typeof jsonSchema === "object" && jsonSchema !== null) {
    const schema = jsonSchema as Record<string, unknown>;
    parameters.type = schema.type ?? "object";
    if (schema.properties) parameters.properties = schema.properties;
    if (schema.required) parameters.required = schema.required;
    if (schema.additionalProperties !== undefined) {
      parameters.additionalProperties = schema.additionalProperties;
    }
  }
  // Ensure we always have a valid object schema
  if (!parameters.type) {
    parameters.type = "object";
    parameters.properties = {};
    parameters.required = [];
  }

  return {
    type: "function",
    function: {
      name: tool.metadata.name,
      description: tool.description(),
      parameters,
    },
  };
}

/**
 * Convert an array of ITool instances to ToolDefinition array.
 */
export function toToolDefinitions(tools: ITool[]): ToolDefinition[] {
  return tools.map(toToolDefinition);
}
