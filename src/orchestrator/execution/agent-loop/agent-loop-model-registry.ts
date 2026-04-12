import type {
  AgentLoopModelInfo,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
} from "./agent-loop-model.js";
import { formatAgentLoopModelRef } from "./agent-loop-model.js";

export class StaticAgentLoopModelRegistry implements AgentLoopModelRegistry {
  private readonly models: Map<string, AgentLoopModelInfo>;
  private readonly defaultRef: AgentLoopModelRef;

  constructor(models: AgentLoopModelInfo[], defaultRef?: AgentLoopModelRef) {
    if (models.length === 0) {
      throw new Error("StaticAgentLoopModelRegistry requires at least one model.");
    }
    this.models = new Map(models.map((model) => [formatAgentLoopModelRef(model.ref), model]));
    this.defaultRef = defaultRef ?? models[0].ref;
  }

  async list(): Promise<AgentLoopModelInfo[]> {
    return [...this.models.values()];
  }

  async get(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo> {
    const model = this.models.get(formatAgentLoopModelRef(ref));
    if (!model) {
      throw new Error(`AgentLoop model not found: ${formatAgentLoopModelRef(ref)}`);
    }
    return model;
  }

  async defaultModel(): Promise<AgentLoopModelRef> {
    return this.defaultRef;
  }
}
