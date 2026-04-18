import { z } from "zod";
import type { InteractiveAutomationCapability, InteractiveAutomationProviderFamily, InteractiveAutomationRegistry } from "../../runtime/interactive-automation/index.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolDescriptionContext, ToolMetadata, ToolResult } from "../types.js";

const TAGS = ["automation", "interactive"];
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_DENIED_APPS = ["Password Manager", "Banking", "System Settings"];

export interface InteractiveAutomationToolPolicy {
  requireApproval: "always" | "write" | "destructive";
  allowedApps?: readonly string[];
  deniedApps?: readonly string[];
}

export const DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY: InteractiveAutomationToolPolicy = {
  requireApproval: "always",
  deniedApps: DEFAULT_DENIED_APPS,
};

const ProviderInputSchema = z.object({
  providerId: z.string().optional(),
});

export const DesktopListAppsInputSchema = ProviderInputSchema;
export type DesktopListAppsInput = z.infer<typeof DesktopListAppsInputSchema>;

export const DesktopGetAppStateInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
});
export type DesktopGetAppStateInput = z.infer<typeof DesktopGetAppStateInputSchema>;

export const DesktopClickInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
  elementId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  clickCount: z.number().int().positive().default(1),
});
export type DesktopClickInput = z.infer<typeof DesktopClickInputSchema>;

export const DesktopTypeTextInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
  text: z.string(),
});
export type DesktopTypeTextInput = z.infer<typeof DesktopTypeTextInputSchema>;

export const ResearchWebInputSchema = ProviderInputSchema.extend({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  domains: z.array(z.string().min(1)).optional(),
});
export type ResearchWebInput = z.infer<typeof ResearchWebInputSchema>;

export const ResearchAnswerInputSchema = ProviderInputSchema.extend({
  question: z.string().min(1),
  model: z.string().optional(),
});
export type ResearchAnswerInput = z.infer<typeof ResearchAnswerInputSchema>;

export const BrowserRunWorkflowInputSchema = ProviderInputSchema.extend({
  task: z.string().min(1),
  startUrl: z.string().url().optional(),
  sessionId: z.string().optional(),
});
export type BrowserRunWorkflowInput = z.infer<typeof BrowserRunWorkflowInputSchema>;

export const BrowserGetStateInputSchema = ProviderInputSchema.extend({
  sessionId: z.string().optional(),
});
export type BrowserGetStateInput = z.infer<typeof BrowserGetStateInputSchema>;

abstract class AutomationTool<TInput> implements ITool<TInput> {
  abstract readonly metadata: ToolMetadata;
  abstract readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;

  constructor(
    protected readonly registry: InteractiveAutomationRegistry,
    protected readonly policy: InteractiveAutomationToolPolicy = DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY,
  ) {}

  abstract description(context?: ToolDescriptionContext): string;
  abstract call(input: TInput, context: ToolCallContext): Promise<ToolResult>;
  abstract checkPermissions(input: TInput, context: ToolCallContext): Promise<PermissionCheckResult>;
  abstract isConcurrencySafe(input: TInput): boolean;

  protected resolveProvider(input: { providerId?: string }, family: InteractiveAutomationProviderFamily, capability: InteractiveAutomationCapability) {
    return this.registry.resolve({
      providerId: input.providerId,
      family,
      capability,
    });
  }

  protected fail(summary: string, startTime: number): ToolResult {
    return {
      success: false,
      data: null,
      summary,
      error: summary,
      durationMs: Date.now() - startTime,
    };
  }

  protected success(data: unknown, summary: string, startTime: number): ToolResult {
    return {
      success: true,
      data,
      summary,
      durationMs: Date.now() - startTime,
    };
  }

  protected async availableOrFail(provider: { id: string; isAvailable: () => Promise<{ available: boolean; reason?: string }> } | undefined, startTime: number): Promise<ToolResult | null> {
    if (!provider) {
      return this.fail("No matching interactive automation provider is registered", startTime);
    }
    const availability = await provider.isAvailable();
    if (!availability.available) {
      return this.fail(`${provider.id} is unavailable: ${availability.reason ?? "unknown reason"}`, startTime);
    }
    return null;
  }

  protected checkDesktopMutationPolicy(app: string, action: string): PermissionCheckResult {
    const appName = app.trim();
    const allowedApps = this.policy.allowedApps ?? [];
    if (allowedApps.length > 0 && !matchesAnyApp(appName, allowedApps)) {
      return {
        status: "denied",
        reason: `${action} is not allowed for ${appName}; it is not in the interactive automation allowed_apps list`,
      };
    }

    if (matchesAnyApp(appName, this.policy.deniedApps ?? DEFAULT_DENIED_APPS)) {
      return {
        status: "denied",
        reason: `${action} is denied for protected app ${appName}`,
      };
    }

    if (this.policy.requireApproval === "always" || this.policy.requireApproval === "write") {
      return { status: "needs_approval", reason: `${action} in ${appName} requires approval` };
    }

    return { status: "allowed" };
  }
}

function matchesAnyApp(app: string, patterns: readonly string[]): boolean {
  const normalized = app.toLowerCase();
  return patterns.some((pattern) => {
    const candidate = pattern.trim().toLowerCase();
    return candidate.length > 0 && normalized.includes(candidate);
  });
}

export class DesktopListAppsTool extends AutomationTool<DesktopListAppsInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_list_apps",
    aliases: ["list_desktop_apps"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopListAppsInputSchema;

  description(): string {
    return "List desktop applications visible to the configured interactive automation provider.";
  }

  async call(input: DesktopListAppsInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_state");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.listApps) return this.fail(`${provider?.id ?? "provider"} does not support listing apps`, startTime);
    const apps = await provider.listApps();
    return this.success({ providerId: provider.id, apps }, `Found ${apps.length} desktop app(s) via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: DesktopListAppsInput): boolean {
    return true;
  }
}

export class DesktopGetAppStateTool extends AutomationTool<DesktopGetAppStateInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_get_app_state",
    aliases: ["get_desktop_app_state"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopGetAppStateInputSchema;

  description(): string {
    return "Inspect the current state of a desktop application through an automation provider.";
  }

  async call(input: DesktopGetAppStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_state");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.getAppState) return this.fail(`${provider?.id ?? "provider"} does not support app state`, startTime);
    const state = await provider.getAppState({ app: input.app });
    return this.success({ providerId: provider.id, state }, `Read state for ${input.app} via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: DesktopGetAppStateInput): boolean {
    return true;
  }
}

export class DesktopClickTool extends AutomationTool<DesktopClickInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_click",
    aliases: ["click_desktop"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopClickInputSchema;

  description(): string {
    return "Click a desktop coordinate or accessibility element through an automation provider.";
  }

  async call(input: DesktopClickInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_input");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.click) return this.fail(`${provider?.id ?? "provider"} does not support clicks`, startTime);
    const result = await provider.click({
      app: input.app,
      elementId: input.elementId,
      x: input.x,
      y: input.y,
      button: input.button,
      clickCount: input.clickCount,
    });
    return result.success
      ? this.success({ providerId: provider.id, result }, `Clicked ${input.app} via ${provider.id}`, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(input: DesktopClickInput): Promise<PermissionCheckResult> {
    return this.checkDesktopMutationPolicy(input.app, "Desktop click");
  }

  isConcurrencySafe(_input: DesktopClickInput): boolean {
    return false;
  }
}

export class DesktopTypeTextTool extends AutomationTool<DesktopTypeTextInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_type_text",
    aliases: ["type_desktop_text"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopTypeTextInputSchema;

  description(): string {
    return "Type text into a desktop application through an automation provider.";
  }

  async call(input: DesktopTypeTextInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_input");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.typeText) return this.fail(`${provider?.id ?? "provider"} does not support text input`, startTime);
    const result = await provider.typeText({ app: input.app, text: input.text });
    return result.success
      ? this.success({ providerId: provider.id, result }, `Typed ${input.text.length} character(s) into ${input.app} via ${provider.id}`, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(input: DesktopTypeTextInput): Promise<PermissionCheckResult> {
    const policyResult = this.checkDesktopMutationPolicy(input.app, `Typing ${input.text.length} character(s)`);
    if (policyResult.status === "needs_approval") {
      return {
        status: "needs_approval",
        reason: `Typing ${input.text.length} character(s) into ${input.app} requires approval`,
      };
    }
    return policyResult;
  }

  isConcurrencySafe(_input: DesktopTypeTextInput): boolean {
    return false;
  }
}

export class ResearchWebTool extends AutomationTool<ResearchWebInput> {
  readonly metadata: ToolMetadata = {
    name: "research_web",
    aliases: ["web_research"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "research"],
  };
  readonly inputSchema = ResearchWebInputSchema;

  description(): string {
    return "Run web research through the configured research automation provider.";
  }

  async call(input: ResearchWebInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "research", "web_research");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.researchWeb) return this.fail(`${provider?.id ?? "provider"} does not support web research`, startTime);
    const result = await provider.researchWeb({
      query: input.query,
      maxResults: input.maxResults,
      domains: input.domains,
    });
    return this.success({ providerId: provider.id, ...result }, `Found ${result.results.length} research result(s) via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ResearchWebInput): boolean {
    return true;
  }
}

export class ResearchAnswerWithSourcesTool extends AutomationTool<ResearchAnswerInput> {
  readonly metadata: ToolMetadata = {
    name: "research_answer_with_sources",
    aliases: ["answer_with_sources"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "research"],
  };
  readonly inputSchema = ResearchAnswerInputSchema;

  description(): string {
    return "Answer a research question with citations through the configured research provider.";
  }

  async call(input: ResearchAnswerInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "research", "web_research");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.answerWithSources) return this.fail(`${provider?.id ?? "provider"} does not support sourced answers`, startTime);
    const result = await provider.answerWithSources({ question: input.question, model: input.model });
    return this.success({ providerId: provider.id, ...result }, `Answered with ${result.citations.length} citation(s) via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ResearchAnswerInput): boolean {
    return true;
  }
}

export class BrowserRunWorkflowTool extends AutomationTool<BrowserRunWorkflowInput> {
  readonly metadata: ToolMetadata = {
    name: "browser_run_workflow",
    aliases: ["run_browser_workflow"],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "browser"],
  };
  readonly inputSchema = BrowserRunWorkflowInputSchema;

  description(): string {
    return "Ask the configured browser automation provider to run a browser workflow.";
  }

  async call(input: BrowserRunWorkflowInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "browser", "browser_control");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.runBrowserWorkflow) return this.fail(`${provider?.id ?? "provider"} does not support browser workflows`, startTime);
    const result = await provider.runBrowserWorkflow({
      task: input.task,
      startUrl: input.startUrl,
      sessionId: input.sessionId,
    });
    return result.success
      ? this.success({ providerId: provider.id, result }, result.summary, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(input: BrowserRunWorkflowInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: `Browser workflow requires approval: ${input.task.slice(0, 120)}` };
  }

  isConcurrencySafe(_input: BrowserRunWorkflowInput): boolean {
    return false;
  }
}

export class BrowserGetStateTool extends AutomationTool<BrowserGetStateInput> {
  readonly metadata: ToolMetadata = {
    name: "browser_get_state",
    aliases: ["get_browser_state"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "browser"],
  };
  readonly inputSchema = BrowserGetStateInputSchema;

  description(): string {
    return "Read state from the configured browser automation provider.";
  }

  async call(input: BrowserGetStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "browser", "browser_control");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.getBrowserState) return this.fail(`${provider?.id ?? "provider"} does not support browser state`, startTime);
    const result = await provider.getBrowserState({ sessionId: input.sessionId });
    return result.success
      ? this.success({ providerId: provider.id, result }, result.summary, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: BrowserGetStateInput): boolean {
    return true;
  }
}
