export type InteractiveAutomationProviderFamily =
  | "desktop"
  | "browser"
  | "agent"
  | "research";

export type InteractiveAutomationCapability =
  | "desktop_state"
  | "desktop_input"
  | "browser_control"
  | "cloud_browser"
  | "local_browser_session"
  | "web_research"
  | "agentic_workflow"
  | "code_workspace";

export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

export interface AutomationEnvironment {
  providerId: string;
  family: InteractiveAutomationProviderFamily;
  capabilities: InteractiveAutomationCapability[];
  available: boolean;
  reason?: string;
}

export interface DesktopAppSummary {
  name: string;
  appId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface GetAppStateInput {
  app: string;
}

export interface AppStateSnapshot {
  app: string;
  title?: string;
  screenshotPath?: string;
  accessibilityTree?: unknown;
  elements?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface ClickInput {
  app: string;
  elementId?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface TypeTextInput {
  app: string;
  text: string;
}

export interface PressKeyInput {
  app: string;
  key: string;
}

export interface ScrollInput {
  app: string;
  direction: "up" | "down" | "left" | "right";
  elementId?: string;
  pages?: number;
}

export interface DragInput {
  app: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface SetValueInput {
  app: string;
  elementId: string;
  value: string;
}

export interface AutomationActionResult {
  success: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

export interface ResearchWebInput {
  query: string;
  maxResults?: number;
  domains?: string[];
}

export interface ResearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
}

export interface ResearchWebResult {
  query: string;
  results: ResearchResultItem[];
  citations?: string[];
  raw?: unknown;
}

export interface ResearchAnswerInput {
  question: string;
  model?: string;
}

export interface ResearchAnswerResult {
  answer: string;
  citations: string[];
  raw?: unknown;
}

export interface BrowserWorkflowInput {
  task: string;
  startUrl?: string;
  sessionId?: string;
}

export interface BrowserStateInput {
  sessionId?: string;
}

export interface BrowserWorkflowResult {
  success: boolean;
  summary: string;
  sessionId?: string;
  data?: unknown;
  error?: string;
}

export interface InteractiveAutomationProvider {
  readonly id: string;
  readonly family: InteractiveAutomationProviderFamily;
  readonly capabilities: readonly InteractiveAutomationCapability[];

  isAvailable(): Promise<ProviderAvailability>;
  describeEnvironment(): Promise<AutomationEnvironment>;

  listApps?(): Promise<DesktopAppSummary[]>;
  getAppState?(input: GetAppStateInput): Promise<AppStateSnapshot>;
  click?(input: ClickInput): Promise<AutomationActionResult>;
  typeText?(input: TypeTextInput): Promise<AutomationActionResult>;
  pressKey?(input: PressKeyInput): Promise<AutomationActionResult>;
  scroll?(input: ScrollInput): Promise<AutomationActionResult>;
  drag?(input: DragInput): Promise<AutomationActionResult>;
  setValue?(input: SetValueInput): Promise<AutomationActionResult>;

  researchWeb?(input: ResearchWebInput): Promise<ResearchWebResult>;
  answerWithSources?(input: ResearchAnswerInput): Promise<ResearchAnswerResult>;

  runBrowserWorkflow?(input: BrowserWorkflowInput): Promise<BrowserWorkflowResult>;
  getBrowserState?(input: BrowserStateInput): Promise<BrowserWorkflowResult>;
}

export function unavailableAction(providerId: string, reason: string): AutomationActionResult {
  return {
    success: false,
    summary: `${providerId} is unavailable: ${reason}`,
    error: reason,
  };
}
