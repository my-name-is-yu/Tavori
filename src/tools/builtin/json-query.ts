import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const JsonQueryInputSchema = z.object({
  file_path: z.string().min(1),
  query: z.string().min(1),
});
export type JsonQueryInput = z.infer<typeof JsonQueryInputSchema>;

export class JsonQueryTool implements ITool<JsonQueryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "json_query", aliases: ["jq", "json_read"],
    permissionLevel: "read_only", isReadOnly: true, isDestructive: false,
    shouldDefer: true, alwaysLoad: false, maxConcurrency: 0,
    maxOutputChars: 8000, tags: ["filesystem", "observation", "knowledge"],
  };
  readonly inputSchema = JsonQueryInputSchema;

  description(): string {
    return 'Query a JSON file using dot-notation path (e.g., "dependencies.zod", "scripts.build").';
  }

  async call(input: JsonQueryInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const filePath = path.isAbsolute(input.file_path) ? input.file_path : path.resolve(context.cwd, input.file_path);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const json = JSON.parse(content);
      const value = this.queryPath(json, input.query);
      return { success: true, data: value, summary: `${input.query} = ${JSON.stringify(value ?? null).slice(0, 200)}`, durationMs: Date.now() - startTime };
    } catch (err) {
      return { success: false, data: null, summary: `JSON query failed: ${(err as Error).message}`, error: (err as Error).message, durationMs: Date.now() - startTime };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> { return { status: "allowed" }; }
  isConcurrencySafe(): boolean { return true; }

  private queryPath(obj: unknown, query: string): unknown {
    const parts = query.split(".").flatMap((part) => {
      const match = part.match(/^(.+?)\[(\d+)]$/);
      if (match) return [match[1], match[2]];
      return [part];
    });
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === "object") { current = (current as Record<string, unknown>)[part]; }
      else return undefined;
    }
    return current;
  }
}
