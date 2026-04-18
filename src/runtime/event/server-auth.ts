import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "../logger.js";
import { writeJsonError } from "./server-http.js";

const DAEMON_TOKEN_FILENAME = "daemon-token.json";

export class EventServerAuth {
  private readonly authToken = randomBytes(32).toString("base64url");

  constructor(
    private readonly host: string,
    private readonly eventsDir: string,
    private readonly getPort: () => number,
    private readonly logger?: Logger
  ) {}

  getToken(): string {
    return this.authToken;
  }

  async persistAuthToken(): Promise<void> {
    const tokenPath = this.getAuthTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    const payload = {
      token: this.authToken,
      host: this.host,
      port: this.getPort(),
      pid: process.pid,
      created_at: new Date().toISOString(),
    };
    await fsp.writeFile(tokenPath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fsp.chmod(tokenPath, 0o600).catch(() => undefined);
  }

  async removeAuthTokenFile(): Promise<void> {
    const tokenPath = this.getAuthTokenPath();
    try {
      const raw = await fsp.readFile(tokenPath, "utf-8");
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (parsed.token !== this.authToken) return;
      await fsp.unlink(tokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn(`EventServer: failed to remove auth token file: ${String(err)}`);
      }
    }
  }

  authorizeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.isAllowedHost(req.headers.host)) {
      writeJsonError(res, 403, "Forbidden host");
      return false;
    }

    if (!this.isAllowedOrigin(req.headers.origin)) {
      writeJsonError(res, 403, "Forbidden origin");
      return false;
    }

    const fetchSite = this.singleHeader(req.headers["sec-fetch-site"])?.toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      writeJsonError(res, 403, "Forbidden browser request");
      return false;
    }

    if (!this.hasValidAuth(req.headers.authorization)) {
      writeJsonError(res, 401, "Unauthorized");
      return false;
    }

    if (req.method === "POST" && !this.hasJsonContentType(req.headers["content-type"])) {
      writeJsonError(res, 415, "Content-Type must be application/json");
      return false;
    }

    return true;
  }

  private getAuthTokenPath(): string {
    return path.join(path.dirname(this.eventsDir), DAEMON_TOKEN_FILENAME);
  }

  private hasValidAuth(header: string | string[] | undefined): boolean {
    const value = this.singleHeader(header);
    if (!value?.startsWith("Bearer ")) return false;
    const candidate = value.slice("Bearer ".length).trim();
    const expected = Buffer.from(this.authToken);
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private hasJsonContentType(header: string | string[] | undefined): boolean {
    const value = this.singleHeader(header);
    return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
  }

  private isAllowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const hostname = this.parseHostname(hostHeader);
    if (!hostname) return false;
    return this.isAllowedHostname(hostname);
  }

  private isAllowedOrigin(originHeader: string | string[] | undefined): boolean {
    const origin = this.singleHeader(originHeader);
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:") return false;
      if (!this.isAllowedHostname(parsed.hostname)) return false;
      const originPort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
      return originPort === this.getPort();
    } catch {
      return false;
    }
  }

  private isAllowedHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    return normalized === this.host.toLowerCase()
      || normalized === "127.0.0.1"
      || normalized === "localhost"
      || normalized === "::1";
  }

  private parseHostname(hostHeader: string): string | null {
    try {
      return new URL(`http://${hostHeader}`).hostname;
    } catch {
      return null;
    }
  }

  private singleHeader(header: string | string[] | undefined): string | undefined {
    return Array.isArray(header) ? header[0] : header;
  }
}
