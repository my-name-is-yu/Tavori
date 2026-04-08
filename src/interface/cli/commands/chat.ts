// ─── pulseed chat command ───

import React, { useState, useCallback, useEffect } from "react";
import { render, useApp } from "ink";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

import { StateManager } from "../../../base/state/state-manager.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient, buildAdapterRegistry } from "../../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../../base/llm/provider-config.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import type { ChatRunner } from "../../chat/chat-runner.js";
import { Chat, type ChatMessage } from "../../tui/chat.js";
import { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import { GoalNegotiator } from "../../../orchestrator/goal/goal-negotiator.js";
import { EscalationHandler } from "../../chat/escalation.js";
import { DaemonClient, isDaemonRunning } from "../../../runtime/daemon-client.js";
import { applyChatEventToMessages } from "../../chat/chat-event-state.js";

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
      id: randomUUID(),
      role: "pulseed",
      text: "Chat mode — type a task, /help for commands, /exit to quit.",
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);

  const pushNotification = useCallback(
    (text: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: randomUUID(),
          role: "pulseed" as const,
          text,
          timestamp: new Date(),
          messageType: "info" as const,
        },
      ]);
    },
    []
  );

  useEffect(() => {
    chatRunner.startSession(cwd);
    // Wire notification callback so /tend daemon events appear in chat
    chatRunner.onNotification = pushNotification;
    chatRunner.onEvent = (event) => {
      setMessages((prev) => applyChatEventToMessages(prev, event, 200) as ChatMessage[]);
    };
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
        { id: randomUUID(), role: "user" as const, text: input, timestamp: new Date() },
      ]);
      setIsProcessing(true);

      try {
        await chatRunner.execute(input, cwd, timeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
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

    // Build escalation + tend deps (optional — /track and /tend work only when LLM is available)
    let escalationHandler: EscalationHandler | undefined;
    let goalNegotiatorForTend: GoalNegotiator | undefined;
    try {
      const ethicsGate = new EthicsGate(stateManager, llmClient);
      const observationEngine = new ObservationEngine(stateManager, [], llmClient);
      const goalNegotiator = new GoalNegotiator(stateManager, llmClient, ethicsGate, observationEngine);
      escalationHandler = new EscalationHandler({ stateManager, llmClient, goalNegotiator });
      goalNegotiatorForTend = goalNegotiator;
    } catch {
      // Non-fatal: /track and /tend will show "not available" if deps fail to init
      logger.warn("Escalation handler could not be initialized — /track and /tend will be unavailable");
    }

    // Build daemon client for /tend (optional — degrades gracefully if daemon not running)
    let daemonClient: DaemonClient | undefined;
    let daemonBaseUrl: string | undefined;
    try {
      const pulseedDir = process.env["PULSEED_DIR"] ?? `${process.env["HOME"] ?? "~"}/.pulseed`;
      const daemonInfo = await isDaemonRunning(pulseedDir);
      if (daemonInfo.running) {
        daemonClient = new DaemonClient({ host: "127.0.0.1", port: daemonInfo.port });
        daemonBaseUrl = `http://127.0.0.1:${daemonInfo.port}`;
      }
    } catch {
      // Non-fatal: /tend will show "daemon not available" message
    }

    const { ChatRunner } = await import("../../chat/chat-runner.js");
    const chatRunner = new ChatRunner({
      adapter,
      stateManager,
      llmClient,
      escalationHandler,
      goalNegotiator: goalNegotiatorForTend,
      daemonClient,
      daemonBaseUrl,
    });

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
