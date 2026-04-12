import type { AgentLoopMessage } from "./agent-loop-model.js";
import type { AgentLoopHistory } from "./agent-loop-history.js";

export type AgentLoopCompactionPhase = "pre_turn" | "mid_turn" | "standalone_turn";
export type AgentLoopCompactionReason = "context_limit" | "model_downshift" | "manual";

export interface AgentLoopCompactionInput {
  history: AgentLoopHistory;
  maxMessages?: number;
  phase?: AgentLoopCompactionPhase;
  reason?: AgentLoopCompactionReason;
}

export interface AgentLoopCompactionResult {
  history: AgentLoopHistory;
  compacted: boolean;
  summary?: string;
}

export interface AgentLoopCompactor {
  compact(input: AgentLoopCompactionInput): Promise<AgentLoopCompactionResult>;
}

export class NoopAgentLoopCompactor implements AgentLoopCompactor {
  async compact(input: AgentLoopCompactionInput): Promise<AgentLoopCompactionResult> {
    return { history: input.history, compacted: false };
  }
}

export const AGENT_LOOP_COMPACTION_SUMMARY_PREFIX = "Summary of earlier agentloop context:";

export interface ExtractiveAgentLoopCompactorOptions {
  defaultMaxMessages?: number;
  maxSummaryChars?: number;
}

export class ExtractiveAgentLoopCompactor implements AgentLoopCompactor {
  private readonly defaultMaxMessages: number;
  private readonly maxSummaryChars: number;

  constructor(options: ExtractiveAgentLoopCompactorOptions = {}) {
    this.defaultMaxMessages = options.defaultMaxMessages ?? 8;
    this.maxSummaryChars = options.maxSummaryChars ?? 6000;
  }

  async compact(input: AgentLoopCompactionInput): Promise<AgentLoopCompactionResult> {
    const maxMessages = Math.max(3, input.maxMessages ?? this.defaultMaxMessages);
    const messages = input.history.messages;
    if (messages.length <= maxMessages) {
      return { history: input.history, compacted: false };
    }

    const systemMessages = messages.filter((message) => message.role === "system");
    const nonSystemMessages = messages.filter((message) => message.role !== "system");
    const tailCount = Math.max(2, maxMessages - systemMessages.length - 1);
    const rawTail = nonSystemMessages.slice(-tailCount);
    const tail = rawTail.filter((message) => !isCompactionSummaryMessage(message));
    const tailSet = new Set(rawTail);
    const summarized = nonSystemMessages
      .filter((message) => !tailSet.has(message))
      .filter((message) => !isCompactionSummaryMessage(message));

    if (summarized.length === 0) {
      return {
        history: { messages: [...systemMessages, ...tail], compacted: input.history.compacted },
        compacted: false,
      };
    }

    const summary = this.buildSummary(summarized, input);
    const replacement: AgentLoopMessage[] = [
      ...systemMessages,
      { role: "user", content: `${AGENT_LOOP_COMPACTION_SUMMARY_PREFIX}\n${summary}` },
      ...tail,
    ];

    return {
      history: { messages: replacement, compacted: true },
      compacted: true,
      summary,
    };
  }

  private buildSummary(
    messages: AgentLoopMessage[],
    input: AgentLoopCompactionInput,
  ): string {
    const header = [
      `phase: ${input.phase ?? "standalone_turn"}`,
      `reason: ${input.reason ?? "context_limit"}`,
      "Preserve task intent, tool results, files, failures, and pending constraints.",
    ].join("\n");
    const body = messages.map((message, index) => {
      const label = [index + 1, message.role, message.toolName ? `tool=${message.toolName}` : ""]
        .filter(Boolean)
        .join(" ");
      return `- ${label}: ${preview(message.content, 900)}`;
    }).join("\n");
    return preview(`${header}\n${body}`, this.maxSummaryChars);
  }
}

function isCompactionSummaryMessage(message: AgentLoopMessage): boolean {
  return message.role === "user" && message.content.startsWith(AGENT_LOOP_COMPACTION_SUMMARY_PREFIX);
}

function preview(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
