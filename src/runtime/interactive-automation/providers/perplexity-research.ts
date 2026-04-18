import type {
  AutomationEnvironment,
  InteractiveAutomationCapability,
  InteractiveAutomationProvider,
  ProviderAvailability,
  ResearchAnswerInput,
  ResearchAnswerResult,
  ResearchResultItem,
  ResearchWebInput,
  ResearchWebResult,
} from "../types.js";

export type AutomationFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PerplexityResearchProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: AutomationFetch;
}

const DEFAULT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_MODEL = "sonar";

export class PerplexityResearchProvider implements InteractiveAutomationProvider {
  readonly id = "perplexity_research";
  readonly family = "research" as const;
  readonly capabilities: readonly InteractiveAutomationCapability[] = ["web_research"];

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: AutomationFetch;

  constructor(options: PerplexityResearchProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env["PERPLEXITY_API_KEY"];
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? process.env["PERPLEXITY_BASE_URL"] ?? DEFAULT_BASE_URL);
    this.model = options.model ?? process.env["PERPLEXITY_MODEL"] ?? DEFAULT_MODEL;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (!this.apiKey) {
      return { available: false, reason: "PERPLEXITY_API_KEY is not configured" };
    }
    return { available: true };
  }

  async describeEnvironment(): Promise<AutomationEnvironment> {
    const availability = await this.isAvailable();
    return {
      providerId: this.id,
      family: this.family,
      capabilities: [...this.capabilities],
      available: availability.available,
      ...(availability.reason ? { reason: availability.reason } : {}),
    };
  }

  async researchWeb(input: ResearchWebInput): Promise<ResearchWebResult> {
    this.assertAvailable();
    const response = await this.fetchJson(`${this.baseUrl}/search`, {
      query: input.query,
      max_results: input.maxResults,
      domains: input.domains,
    });
    return {
      query: input.query,
      results: normalizeSearchResults(response),
      citations: collectCitations(response),
      raw: response,
    };
  }

  async answerWithSources(input: ResearchAnswerInput): Promise<ResearchAnswerResult> {
    this.assertAvailable();
    const response = await this.fetchJson(`${this.baseUrl}/chat/completions`, {
      model: input.model ?? this.model,
      messages: [{ role: "user", content: input.question }],
    });
    return {
      answer: extractAnswer(response),
      citations: collectCitations(response),
      raw: response,
    };
  }

  private assertAvailable(): void {
    if (!this.apiKey) {
      throw new Error("PERPLEXITY_API_KEY is not configured");
    }
  }

  private async fetchJson(url: string, body: unknown): Promise<unknown> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Perplexity request failed with HTTP ${response.status}`);
    }

    return response.json();
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeSearchResults(raw: unknown): ResearchResultItem[] {
  const source = raw as Record<string, unknown>;
  const candidates =
    Array.isArray(source["results"]) ? source["results"]
      : Array.isArray(source["data"]) ? source["data"]
        : [];

  return candidates
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      title: stringOrFallback(item["title"], stringOrFallback(item["name"], "Untitled")),
      url: stringOrFallback(item["url"], ""),
      snippet: optionalString(item["snippet"] ?? item["text"] ?? item["description"]),
      source: optionalString(item["source"]),
    }))
    .filter((item) => item.url.length > 0);
}

function extractAnswer(raw: unknown): string {
  const source = raw as Record<string, unknown>;
  const choices = source["choices"];
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (typeof content === "string") return content;
  }
  const answer = source["answer"];
  return typeof answer === "string" ? answer : "";
}

function collectCitations(raw: unknown): string[] {
  const source = raw as Record<string, unknown>;
  const citations = source["citations"];
  if (Array.isArray(citations)) {
    return citations.filter((item): item is string => typeof item === "string");
  }
  return normalizeSearchResults(raw).map((item) => item.url);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
