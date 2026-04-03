// ─── pulseed chat command ───

import React, { useState, useCallback, useEffect } from "react";
import { render, useApp } from "ink";
import { parseArgs } from "node:util";

import { StateManager } from "../../state/state-manager.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient, buildAdapterRegistry } from "../../llm/provider-factory.js";
import { loadProviderConfig } from "../../llm/provider-config.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import type { ChatRunner } from "../../chat/chat-runner.js";
import { Chat, type ChatMessage } from "../../tui/chat.js";
import { EthicsGate } from "../../traits/ethics-gate.js";
import { ObservationEngine } from "../../observation/observation-engine.js";
import { GoalNegotiator } from "../../goal/goal-negotiator.js";
import { EscalationHandler } from "../../chat/escalation.js";

const logger = getCliLogger();

// ─── Interactive REPL component ───

interface ChatAppProps {
  chatRunner: ChatRunner;
  cwd: string;
  timeoutMs: number;
}

function ChatApp({ chatRunner, cwd, timeoutMs }: ChatAppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "pulseed",
      text: "Chat mode — type a task, /help for commands, /exit to quit.",
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    chatRunner.startSession(cwd);
  }, []);

  const onSubmit = useCallback(
    async (input: string) => {
      if (!input.trim() || isProcessing) return;

      if (input.trim().toLowerCase() === "/exit") {
        exit();
        return;
      }

      setMessages((prev) => [
        ...prev,
        { role: "user" as const, text: input, timestamp: new Date() },
      ]);
      setIsProcessing(true);

      try {
        const result = await chatRunner.execute(input, cwd, timeoutMs);
        setMessages((prev) => [
          ...prev,
          {
            role: "pulseed" as const,
            text: result.output || "(no output)",
            timestamp: new Date(),
            messageType: result.success ? ("info" as const) : ("error" as const),
          },
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            role: "pulseed" as const,
            text: `Error: ${message}`,
            timestamp: new Date(),
            messageType: "error" as const,
          },
        ]);
      } finally {
        setIsProcessing(false);
      }
    },
    [chatRunner, cwd, timeoutMs, isProcessing, exit]
  );

  return React.createElement(Chat, { messages, onSubmit, isProcessing });
}

// ─── Command handler ───

export async function cmdChat(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  let values: { adapter?: string; timeout?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        adapter: { type: "string" },
        timeout: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { adapter?: string; timeout?: string }; positionals: string[] };
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    logger.error(formatOperationError("parse chat command arguments", err));
    return 1;
  }

  const task = positionals[0];

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const timeoutMs = values.timeout !== undefined ? parseInt(values.timeout, 10) : 120_000;

  let adapterType = values.adapter;
  if (!adapterType) {
    try {
      const providerConfig = await loadProviderConfig();
      adapterType = providerConfig.adapter;
    } catch {
      adapterType = "claude_code_cli";
    }
  }

  try {
    const llmClient = await buildLLMClient();
    const adapterRegistry = await buildAdapterRegistry(llmClient);
    const adapter = adapterRegistry.getAdapter(adapterType);

    // Build escalation deps (optional — /track works only when LLM is available)
    let escalationHandler: EscalationHandler | undefined;
    try {
      const ethicsGate = new EthicsGate(stateManager, llmClient);
      const observationEngine = new ObservationEngine(stateManager, [], llmClient);
      const goalNegotiator = new GoalNegotiator(stateManager, llmClient, ethicsGate, observationEngine);
      escalationHandler = new EscalationHandler({ stateManager, llmClient, goalNegotiator });
    } catch {
      // Non-fatal: /track will show "not available" if escalation fails to init
      logger.warn("Escalation handler could not be initialized — /track will be unavailable");
    }

    const { ChatRunner } = await import("../../chat/chat-runner.js");
    const chatRunner = new ChatRunner({ adapter, stateManager, llmClient, escalationHandler });

    // Non-interactive: single turn
    if (task) {
      const result = await chatRunner.execute(task, process.cwd(), timeoutMs);
      if (result.output) {
        process.stdout.write(result.output + "\n");
      }
      return result.success ? 0 : 1;
    }

    // Interactive REPL
    const { waitUntilExit } = render(
      React.createElement(ChatApp, { chatRunner, cwd: process.cwd(), timeoutMs })
    );
    await waitUntilExit();
    return 0;
  } catch (err) {
    logger.error(formatOperationError("execute chat command", err));
    return 1;
  }
}
