import type {
  AppStateSnapshot,
  AutomationActionResult,
  AutomationEnvironment,
  ClickInput,
  DesktopAppSummary,
  DragInput,
  GetAppStateInput,
  InteractiveAutomationCapability,
  InteractiveAutomationProvider,
  PressKeyInput,
  ProviderAvailability,
  ScrollInput,
  SetValueInput,
  TypeTextInput,
} from "../types.js";
import { unavailableAction } from "../types.js";

export interface CodexAppComputerUseBridge {
  listApps(): Promise<DesktopAppSummary[]>;
  getAppState(input: GetAppStateInput): Promise<AppStateSnapshot>;
  click(input: ClickInput): Promise<AutomationActionResult>;
  typeText(input: TypeTextInput): Promise<AutomationActionResult>;
  pressKey?(input: PressKeyInput): Promise<AutomationActionResult>;
  scroll?(input: ScrollInput): Promise<AutomationActionResult>;
  drag?(input: DragInput): Promise<AutomationActionResult>;
  setValue?(input: SetValueInput): Promise<AutomationActionResult>;
}

const UNAVAILABLE_REASON = "Codex app Computer Use bridge is not available in this runtime";

export class CodexAppAutomationProvider implements InteractiveAutomationProvider {
  readonly id = "codex_app";
  readonly family = "desktop" as const;
  readonly capabilities: readonly InteractiveAutomationCapability[] = [
    "desktop_state",
    "desktop_input",
  ];

  constructor(private readonly bridge?: CodexAppComputerUseBridge) {}

  async isAvailable(): Promise<ProviderAvailability> {
    return this.bridge
      ? { available: true }
      : { available: false, reason: UNAVAILABLE_REASON };
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

  async listApps(): Promise<DesktopAppSummary[]> {
    if (!this.bridge) return [];
    return this.bridge.listApps();
  }

  async getAppState(input: GetAppStateInput): Promise<AppStateSnapshot> {
    if (!this.bridge) {
      return { app: input.app, metadata: { available: false, reason: UNAVAILABLE_REASON } };
    }
    return this.bridge.getAppState(input);
  }

  async click(input: ClickInput): Promise<AutomationActionResult> {
    return this.bridge ? this.bridge.click(input) : unavailableAction(this.id, UNAVAILABLE_REASON);
  }

  async typeText(input: TypeTextInput): Promise<AutomationActionResult> {
    return this.bridge ? this.bridge.typeText(input) : unavailableAction(this.id, UNAVAILABLE_REASON);
  }

  async pressKey(input: PressKeyInput): Promise<AutomationActionResult> {
    return this.bridge?.pressKey
      ? this.bridge.pressKey(input)
      : unavailableAction(this.id, UNAVAILABLE_REASON);
  }

  async scroll(input: ScrollInput): Promise<AutomationActionResult> {
    return this.bridge?.scroll
      ? this.bridge.scroll(input)
      : unavailableAction(this.id, UNAVAILABLE_REASON);
  }

  async drag(input: DragInput): Promise<AutomationActionResult> {
    return this.bridge?.drag
      ? this.bridge.drag(input)
      : unavailableAction(this.id, UNAVAILABLE_REASON);
  }

  async setValue(input: SetValueInput): Promise<AutomationActionResult> {
    return this.bridge?.setValue
      ? this.bridge.setValue(input)
      : unavailableAction(this.id, UNAVAILABLE_REASON);
  }
}
