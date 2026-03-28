// ─── JiraDataSourceAdapter ───
//
// A PulSeed data source plugin that queries Jira REST API for issue counts.
// Uses JQL (expression field) to search issues and returns the result count.
// Uses native fetch — no external dependencies required.
// Authentication: Basic Auth (email + API token).

import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

// ─── Adapter ───

export class JiraDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "http_api" as const;
  readonly config: DataSourceConfig;

  private baseUrl: string | null = null;
  private authHeader: string | null = null;
  private connected = false;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    const url = this.config.connection.url ?? this.config.connection_string;
    if (!url) {
      throw new Error(
        `JiraDataSourceAdapter [${this.sourceId}]: connection.url (Jira base URL) is required`
      );
    }

    const email = this.config.connection.headers?.["X-Jira-Email"]
      ?? process.env["JIRA_EMAIL"]
      ?? "";
    const token = this.config.connection.headers?.["X-Jira-Token"]
      ?? process.env["JIRA_API_TOKEN"]
      ?? "";

    if (!email || !token) {
      throw new Error(
        `JiraDataSourceAdapter [${this.sourceId}]: Jira email and API token are required`
      );
    }

    this.baseUrl = url.replace(/\/$/, "");
    this.authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
    this.connected = true;
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    if (!this.connected || !this.baseUrl || !this.authHeader) {
      throw new Error(
        `JiraDataSourceAdapter [${this.sourceId}]: not connected — call connect() first`
      );
    }

    const jql = params.expression;
    if (!jql) {
      throw new Error(
        `JiraDataSourceAdapter [${this.sourceId}]: query.expression (JQL) is required`
      );
    }

    const url = `${this.baseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=0`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `JiraDataSourceAdapter [${this.sourceId}]: Jira API returned ${response.status}: ${body}`
      );
    }

    const raw: unknown = await response.json();
    const total = (raw as Record<string, unknown>)["total"];
    const value: number | null = typeof total === "number" ? total : null;

    return {
      value,
      raw,
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.connected || !this.baseUrl || !this.authHeader) return false;

    try {
      const response = await fetch(`${this.baseUrl}/rest/api/2/myself`, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.baseUrl = null;
    this.authHeader = null;
    this.connected = false;
  }
}
