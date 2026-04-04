import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../types.js";

export const HttpFetchInputSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().default(30_000),
  maxResponseBytes: z.number().default(1_048_576),
});
export type HttpFetchInput = z.infer<typeof HttpFetchInputSchema>;
export interface HttpFetchOutput { statusCode: number; headers: Record<string, string>; body: string; ok: boolean; }

export class HttpFetchTool implements ITool<HttpFetchInput, HttpFetchOutput> {
  readonly metadata: ToolMetadata = {
    name: "http_fetch", aliases: ["fetch", "curl", "http"],
    permissionLevel: "read_only", isReadOnly: true, isDestructive: false,
    shouldDefer: true, alwaysLoad: false, maxConcurrency: 5,
    maxOutputChars: 8000, tags: ["network", "observation", "knowledge"],
  };
  readonly inputSchema = HttpFetchInputSchema;

  description(): string {
    return "Make read-only HTTP requests (GET/HEAD) to fetch data from URLs.";
  }

  async call(input: HttpFetchInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      const response = await fetch(input.url, { method: input.method, headers: input.headers, signal: controller.signal });
      clearTimeout(timeout);
      const body = input.method === "HEAD" ? "" : await response.text();
      const truncatedBody = body.length > input.maxResponseBytes ? body.slice(0, input.maxResponseBytes) + "\n[truncated]" : body;
      const output: HttpFetchOutput = { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body: truncatedBody, ok: response.ok };
      return {
        success: response.ok, data: output,
        summary: `${input.method} ${input.url} -> ${response.status} (${truncatedBody.length} bytes)`,
        error: response.ok ? undefined : `HTTP ${response.status}: ${truncatedBody.slice(0, 200)}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false, data: { statusCode: 0, headers: {}, body: "", ok: false },
        summary: `HTTP fetch failed: ${(err as Error).message}`, error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: HttpFetchInput): Promise<PermissionCheckResult> {
    const url = new URL(input.url);
    const isInternal = ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname) || url.hostname.startsWith("192.168.") || url.hostname.startsWith("10.");
    if (isInternal) return { status: "needs_approval", reason: `Fetching from internal address: ${input.url}` };
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean { return true; }
}
