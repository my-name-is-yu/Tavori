import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const HttpFetchInputSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().default(30_000),
  maxResponseBytes: z.number().default(1_048_576),
});
export type HttpFetchInput = z.infer<typeof HttpFetchInputSchema>;
export interface HttpFetchOutput { statusCode: number; headers: Record<string, string>; body: string; ok: boolean; }

const MAX_REDIRECTS = 5;

export interface ValidatedDestination {
  address: string;
  family: 4 | 6;
}

export interface HttpFetchTransportRequest {
  url: URL;
  method: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  destination: ValidatedDestination;
}

export type HttpFetchTransport = (request: HttpFetchTransportRequest) => Promise<HttpFetchOutput>;

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function formatIPv4(octets: number[]): string {
  return octets.join(".");
}

function parseIPv6Bytes(address: string): number[] | null {
  const withoutZone = address.toLowerCase().split("%")[0]!;
  const pieces = withoutZone.split("::");
  if (pieces.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (part === "") return [];
    const hextets: number[] = [];
    for (const segment of part.split(":")) {
      if (segment.includes(".")) {
        const octets = parseIPv4(segment);
        if (!octets) return null;
        hextets.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      hextets.push(Number.parseInt(segment, 16));
    }
    return hextets;
  };

  const head = parsePart(pieces[0]!);
  const tail = pieces.length === 2 ? parsePart(pieces[1]!) : [];
  if (!head || !tail) return null;
  const zeroCount = pieces.length === 2 ? 8 - head.length - tail.length : 0;
  if (zeroCount < 0) return null;
  const hextets = pieces.length === 2 ? [...head, ...Array.from({ length: zeroCount }, () => 0), ...tail] : head;
  if (hextets.length !== 8 || hextets.some((hextet) => hextet < 0 || hextet > 0xffff)) return null;

  return hextets.flatMap((hextet) => [(hextet >> 8) & 0xff, hextet & 0xff]);
}

function ipv4FromBytes(bytes: number[], offset: number): string {
  return formatIPv4(bytes.slice(offset, offset + 4));
}

function isZeroSlice(bytes: number[], start: number, end: number): boolean {
  return bytes.slice(start, end).every((byte) => byte === 0);
}

function isBlockedAddress(address: string): boolean {
  const normalizedAddress = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const family = isIP(normalizedAddress);
  if (family === 4) {
    const octets = parseIPv4(normalizedAddress);
    if (!octets) return false;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const bytes = parseIPv6Bytes(normalizedAddress);
    if (!bytes) return false;
    if (bytes.every((byte) => byte === 0)) return true; // ::/128
    if (isZeroSlice(bytes, 0, 15) && bytes[15] === 1) return true; // ::1/128
    if (isZeroSlice(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isBlockedAddress(ipv4FromBytes(bytes, 12)); // ::ffff:0:0/96
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && isZeroSlice(bytes, 4, 12)) {
      return isBlockedAddress(ipv4FromBytes(bytes, 12)); // 64:ff9b::/96 NAT64
    }
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
      return isBlockedAddress(ipv4FromBytes(bytes, 2)); // 2002::/16 6to4
    }
    if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // fec0::/10
    if (bytes[0] === 0xff) return true; // ff00::/8
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32
    return false;
  }
  return false;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const normalizedHostname = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(normalizedHostname)) return [normalizedHostname];
  const records = await lookup(normalizedHostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function validateDestination(url: URL): Promise<ValidatedDestination> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  const addresses = await resolveHostAddresses(url.hostname);
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${url.toString()}`);
  }
  if (addresses.some((address) => isBlockedAddress(address))) {
    throw new Error(`Fetching from internal or private address: ${url.toString()}`);
  }
  const address = addresses[0]!;
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error(`Unable to resolve host: ${url.toString()}`);
  }
  return { address, family };
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return normalized;
}

export function defaultHttpFetchTransport(request: HttpFetchTransportRequest): Promise<HttpFetchOutput> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const client = request.url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: request.url.protocol,
        hostname: request.url.hostname,
        port: request.url.port,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers: request.headers,
        signal: controller.signal,
        family: request.destination.family,
        lookup: (_hostname, options, callback) => {
          const cb = callback as (...args: unknown[]) => void;
          if (typeof options === "object" && options !== null && "all" in options && options.all === true) {
            cb(null, [{ address: request.destination.address, family: request.destination.family }]);
            return;
          }
          cb(null, request.destination.address, request.destination.family);
        },
      },
      (res) => {
        res.setEncoding("utf-8");
        const headers = normalizeHeaders(res.headers);
        let body = "";
        let truncated = false;
        res.on("data", (chunk: string) => {
          if (request.method === "HEAD" || truncated) return;
          const remaining = request.maxResponseBytes - body.length;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          body += chunk.slice(0, remaining);
          if (chunk.length > remaining) truncated = true;
        });
        res.on("end", () => {
          clearTimeout(timeout);
          const outputBody = truncated ? `${body}\n[truncated]` : body;
          const statusCode = res.statusCode ?? 0;
          resolve({
            statusCode,
            headers,
            body: outputBody,
            ok: statusCode >= 200 && statusCode < 300,
          });
        });
      },
    );

    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

export class HttpFetchTool implements ITool<HttpFetchInput, HttpFetchOutput> {
  readonly metadata: ToolMetadata = {
    name: "http_fetch", aliases: ["fetch", "curl", "http"],
    permissionLevel: PERMISSION_LEVEL, isReadOnly: true, isDestructive: false,
    shouldDefer: true, alwaysLoad: false, maxConcurrency: 5,
    maxOutputChars: MAX_OUTPUT_CHARS, tags: [...TAGS], requiresNetwork: true,
  };
  readonly inputSchema = HttpFetchInputSchema;

  constructor(private readonly transport: HttpFetchTransport = defaultHttpFetchTransport) {}

  description(): string {
    return DESCRIPTION;
  }

  async call(input: HttpFetchInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    let currentUrl = new URL(input.url);
    try {
      let response: HttpFetchOutput | null = null;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const destination = await validateDestination(currentUrl);
        response = await this.transport({
          url: currentUrl,
          method: input.method,
          headers: input.headers,
          timeoutMs: input.timeoutMs,
          maxResponseBytes: input.maxResponseBytes,
          destination,
        });
        const location = response.headers["location"];
        if (!isRedirect(response.statusCode) || !location) break;
        if (redirects === MAX_REDIRECTS) {
          throw new Error(`Too many redirects fetching ${input.url}`);
        }
        currentUrl = new URL(location, currentUrl);
      }

      if (!response) {
        throw new Error(`HTTP fetch failed: ${input.url}`);
      }
      return {
        success: response.ok, data: response,
        summary: `${input.method} ${input.url} -> ${response.statusCode} (${response.body.length} bytes)`,
        error: response.ok ? undefined : `HTTP ${response.statusCode}: ${response.body.slice(0, 200)}`,
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
    try {
      await validateDestination(url);
    } catch (err) {
      return { status: "needs_approval", reason: (err as Error).message };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: HttpFetchInput): boolean { return true; }
}
