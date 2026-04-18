import type {
  AppStateSnapshot,
  AutomationActionResult,
  AutomationEnvironment,
  BrowserStateInput,
  BrowserWorkflowInput,
  BrowserWorkflowResult,
  ClickInput,
  DesktopAppSummary,
  DragInput,
  GetAppStateInput,
  InteractiveAutomationCapability,
  InteractiveAutomationProvider,
  InteractiveAutomationProviderFamily,
  PressKeyInput,
  ProviderAvailability,
  ResearchAnswerInput,
  ResearchAnswerResult,
  ResearchWebInput,
  ResearchWebResult,
  ScrollInput,
  SetValueInput,
  TypeTextInput,
} from "../types.js";
import { unavailableAction } from "../types.js";

const NOOP_REASON = "no interactive automation provider is configured";

export class NoopInteractiveAutomationProvider implements InteractiveAutomationProvider {
  readonly id = "noop";
  readonly family: InteractiveAutomationProviderFamily = "agent";
  readonly capabilities: readonly InteractiveAutomationCapability[] = [];

  async isAvailable(): Promise<ProviderAvailability> {
    return { available: false, reason: NOOP_REASON };
  }

  async describeEnvironment(): Promise<AutomationEnvironment> {
    return {
      providerId: this.id,
      family: this.family,
      capabilities: [...this.capabilities],
      available: false,
      reason: NOOP_REASON,
    };
  }

  async listApps(): Promise<DesktopAppSummary[]> {
    return [];
  }

  async getAppState(input: GetAppStateInput): Promise<AppStateSnapshot> {
    return {
      app: input.app,
      metadata: { available: false, reason: NOOP_REASON },
    };
  }

  async click(_input: ClickInput): Promise<AutomationActionResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async typeText(_input: TypeTextInput): Promise<AutomationActionResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async pressKey(_input: PressKeyInput): Promise<AutomationActionResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async scroll(_input: ScrollInput): Promise<AutomationActionResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async drag(_input: DragInput): Promise<AutomationActionResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async setValue(_input: SetValueInput): Promise<AutomationActionResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async researchWeb(input: ResearchWebInput): Promise<ResearchWebResult> {
    return { query: input.query, results: [], raw: { available: false, reason: NOOP_REASON } };
  }

  async answerWithSources(_input: ResearchAnswerInput): Promise<ResearchAnswerResult> {
    return { answer: "", citations: [], raw: { available: false, reason: NOOP_REASON } };
  }

  async runBrowserWorkflow(_input: BrowserWorkflowInput): Promise<BrowserWorkflowResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }

  async getBrowserState(_input: BrowserStateInput): Promise<BrowserWorkflowResult> {
    return unavailableAction(this.id, NOOP_REASON);
  }
}
