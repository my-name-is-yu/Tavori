import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isJwtExpired, readCodexOAuthToken, loadProviderConfig } from "../src/llm/provider-config.js";

// ─── isJwtExpired ───

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("isJwtExpired", () => {
  it("returns false for a token with a future exp", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isJwtExpired(makeJwt({ exp: future }))).toBe(false);
  });

  it("returns true for a token with a past exp", () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(isJwtExpired(makeJwt({ exp: past }))).toBe(true);
  });

  it("returns true when exp is absent (missing exp treated as expired)", () => {
    // No exp field → treat as expired (security policy)
    expect(isJwtExpired(makeJwt({ sub: "user" }))).toBe(true);
  });

  it("returns true for a malformed token", () => {
    expect(isJwtExpired("not-a-jwt")).toBe(true);
  });
});

// ─── readCodexOAuthToken ───

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn() };
});

const fsp = await import("node:fs/promises");
const mockReadFile = vi.mocked(fsp.readFile);

describe("readCodexOAuthToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the access_token from a valid auth.json", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({ exp: future, sub: "user" });
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: token, refresh_token: "rt_abc" },
      last_refresh: "2026-01-01T00:00:00Z",
    });
    // @ts-expect-error — overloaded signature; we only need utf-8 read
    mockReadFile.mockResolvedValueOnce(authJson);

    const result = await readCodexOAuthToken();
    expect(result).toBe(token);
  });

  it("returns undefined when the file does not exist", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await readCodexOAuthToken();
    expect(result).toBeUndefined();
  });

  it("returns undefined when the token is expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = makeJwt({ exp: past });
    const authJson = JSON.stringify({
      tokens: { access_token: token },
    });
    // @ts-expect-error — overloaded signature
    mockReadFile.mockResolvedValueOnce(authJson);

    const result = await readCodexOAuthToken();
    expect(result).toBeUndefined();
  });

  it("returns undefined when tokens.access_token is missing", async () => {
    const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: {} });
    // @ts-expect-error — overloaded signature
    mockReadFile.mockResolvedValueOnce(authJson);

    const result = await readCodexOAuthToken();
    expect(result).toBeUndefined();
  });
});

// ─── loadProviderConfig — OAuth fallback (integration-style) ───

describe("loadProviderConfig OAuth fallback", () => {
  let origKey: string | undefined;

  beforeEach(() => {
    origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it("loadProviderConfig uses OAuth token when no API key", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString("base64url");
    const validToken = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;

    const providerJsonPath = path.join(os.homedir(), ".pulseed", "provider.json");
    const authJsonPath = path.join(os.homedir(), ".codex", "auth.json");

    const providerJson = JSON.stringify({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
    });
    const authJson = JSON.stringify({
      tokens: { access_token: validToken },
    });

    // @ts-expect-error — overloaded signature; we only need utf-8 read
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (filePath === providerJsonPath) return providerJson;
      if (filePath === authJsonPath) return authJson;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    // Also mock fsp.access so loadProviderConfig thinks provider.json exists
    const fspModule = await import("node:fs/promises");
    const accessSpy = vi.spyOn(fspModule, "access").mockResolvedValue(undefined);

    const config = await loadProviderConfig();
    expect(config.api_key).toBe(validToken);

    accessSpy.mockRestore();
  });
});
