import type {
  InteractiveAutomationCapability,
  InteractiveAutomationProvider,
  InteractiveAutomationProviderFamily,
} from "./types.js";

export interface ResolveAutomationProviderInput {
  providerId?: string;
  family?: InteractiveAutomationProviderFamily;
  capability?: InteractiveAutomationCapability;
}

export interface InteractiveAutomationRegistryOptions {
  defaultProviders?: Partial<Record<InteractiveAutomationProviderFamily, string>>;
}

export class InteractiveAutomationRegistry {
  private readonly providers = new Map<string, InteractiveAutomationProvider>();
  private readonly defaultProviders: Partial<Record<InteractiveAutomationProviderFamily, string>>;

  constructor(options: InteractiveAutomationRegistryOptions = {}) {
    this.defaultProviders = { ...options.defaultProviders };
  }

  register(provider: InteractiveAutomationProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Interactive automation provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): InteractiveAutomationProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): InteractiveAutomationProvider[] {
    return [...this.providers.values()];
  }

  setDefaultProvider(family: InteractiveAutomationProviderFamily, providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Interactive automation provider "${providerId}" is not registered`);
    }
    this.defaultProviders[family] = providerId;
  }

  resolve(input: ResolveAutomationProviderInput): InteractiveAutomationProvider | undefined {
    if (input.providerId) {
      return this.providers.get(input.providerId);
    }

    if (input.family) {
      if (hasConfiguredDefault(this.defaultProviders, input.family)) {
        const defaultId = this.defaultProviders[input.family];
        const defaultProvider = defaultId ? this.providers.get(defaultId) : undefined;
        if (!defaultProvider) {
          return undefined;
        }
        if (providerMatches(defaultProvider, input) || defaultProvider.id === "noop") {
          return defaultProvider;
        }
        return undefined;
      }
    }

    return this.list().find((provider) => providerMatches(provider, input));
  }
}

function hasConfiguredDefault(
  defaults: Partial<Record<InteractiveAutomationProviderFamily, string>>,
  family: InteractiveAutomationProviderFamily,
): boolean {
  return Object.prototype.hasOwnProperty.call(defaults, family);
}

function providerMatches(
  provider: InteractiveAutomationProvider,
  input: ResolveAutomationProviderInput,
): boolean {
  if (input.family && provider.family !== input.family) return false;
  if (input.capability && !provider.capabilities.includes(input.capability)) return false;
  return true;
}
