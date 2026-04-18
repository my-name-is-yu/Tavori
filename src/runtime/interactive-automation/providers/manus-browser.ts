import type {
  AutomationEnvironment,
  BrowserStateInput,
  BrowserWorkflowInput,
  BrowserWorkflowResult,
  InteractiveAutomationCapability,
  InteractiveAutomationProvider,
  ProviderAvailability,
} from "../types.js";
import type { AutomationFetch } from "./perplexity-research.js";

export interface ManusBrowserProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: AutomationFetch;
}

const DEFAULT_BASE_URL = "https://api.manus.im";

export class ManusBrowserProvider implements InteractiveAutomationProvider {
  readonly id = "manus_browser";
  readonly family = "browser" as const;
  readonly capabilities: readonly InteractiveAutomationCapability[] = [
    "browser_control",
    "cloud_browser",
    "local_browser_session",
    "agentic_workflow",
  ];

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: AutomationFetch;

  constructor(options: ManusBrowserProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env["MANUS_API_KEY"];
    this.baseUrl = (options.baseUrl ?? process.env["MANUS_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (!this.apiKey) {
      return { available: false, reason: "MANUS_API_KEY is not configured" };
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

  async runBrowserWorkflow(input: BrowserWorkflowInput): Promise<BrowserWorkflowResult> {
    this.assertAvailable();
    const response = await this.fetchJson(`${this.baseUrl}/browser/workflows`, {
      task: input.task,
      start_url: input.startUrl,
      session_id: input.sessionId,
    });
    return normalizeBrowserResult(response, "Manus browser workflow submitted");
  }

  async getBrowserState(input: BrowserStateInput): Promise<BrowserWorkflowResult> {
    this.assertAvailable();
    const query = input.sessionId ? `?session_id=${encodeURIComponent(input.sessionId)}` : "";
    const response = await this.fetchJson(`${this.baseUrl}/browser/state${query}`, undefined, "GET");
    return normalizeBrowserResult(response, "Manus browser state fetched");
  }

  private assertAvailable(): void {
    if (!this.apiKey) {
      throw new Error("MANUS_API_KEY is not configured");
    }
  }

  private async fetchJson(url: string, body?: unknown, method = "POST"): Promise<unknown> {
    const response = await this.fetchFn(url, {
      method,
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new Error(`Manus request failed with HTTP ${response.status}`);
    }

    return response.json();
  }
}

function normalizeBrowserResult(raw: unknown, fallbackSummary: string): BrowserWorkflowResult {
  const source = raw as Record<string, unknown>;
  const success = typeof source["success"] === "boolean" ? source["success"] as boolean : true;
  const summary = typeof source["summary"] === "string" ? source["summary"] as string : fallbackSummary;
  const sessionId = typeof source["session_id"] === "string"
    ? source["session_id"] as string
    : typeof source["sessionId"] === "string"
      ? source["sessionId"] as string
      : undefined;
  const error = typeof source["error"] === "string" ? source["error"] as string : undefined;
  return {
    success,
    summary,
    ...(sessionId ? { sessionId } : {}),
    data: raw,
    ...(error ? { error } : {}),
  };
}
