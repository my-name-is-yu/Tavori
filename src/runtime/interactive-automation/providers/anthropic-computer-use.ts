import type {
  AutomationEnvironment,
  InteractiveAutomationCapability,
  InteractiveAutomationProvider,
  ProviderAvailability,
} from "../types.js";

export interface AnthropicComputerUseProviderOptions {
  apiKey?: string;
}

export class AnthropicComputerUseProvider implements InteractiveAutomationProvider {
  readonly id = "anthropic_computer_use";
  readonly family = "agent" as const;
  readonly capabilities: readonly InteractiveAutomationCapability[] = [
    "desktop_state",
    "desktop_input",
    "agentic_workflow",
  ];

  private readonly apiKey?: string;

  constructor(options: AnthropicComputerUseProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (!this.apiKey) {
      return { available: false, reason: "ANTHROPIC_API_KEY is not configured" };
    }
    return {
      available: false,
      reason: "Anthropic computer-use controller is registered but no PulSeed computer environment bridge is implemented yet",
    };
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
}
