// ─── App ───
//
// Root Ink component that composes Dashboard + Chat and manages shared state.
// Layout: horizontal split — Dashboard sidebar (left, ~30%) + Chat (right, ~70%).
// Uses the useLoop() hook internally for loop state management.
// Routes chat input through IntentRecognizer → ActionHandler.
//
// Supports two modes:
// - Daemon mode: daemonClient is provided, coreLoop is absent. Events come via SSE.
// - Standalone mode: coreLoop is provided, runs in-process.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "./theme.js";
import { Dashboard, statusLabel } from "./dashboard.js";
import { Chat, type ChatMessage } from "./chat.js";
import { HelpOverlay } from "./help-overlay.js";
import { SettingsOverlay } from "./settings-overlay.js";
import { ApprovalOverlay } from "./approval-overlay.js";
import { ReportView } from "./report-view.js";
import { SEEDY_PIXEL } from "./seedy-art.js";
import { FlickerOverlay } from "./flicker-overlay.js";
import { extractBashCommand, formatShellOutput } from "./bash-mode.js";
import type { Report } from "../../base/types/report.js";
import { useLoop } from "./use-loop.js";
import type { LoopState } from "./use-loop.js";
import type { ActionHandler } from "./actions.js";
import type { IntentRecognizer } from "./intent-recognizer.js";
import type { CoreLoop } from "../../orchestrator/loop/core-loop.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";
import type { Task } from "../../base/types/task.js";
import type { ChatRunner } from "../../interface/chat/chat-runner.js";
import type { DaemonClient } from "../../runtime/daemon-client.js";
import { ShellTool } from "../../tools/system/ShellTool/ShellTool.js";
import { getPulseedVersion } from "../../base/utils/pulseed-meta.js";
import { applyChatEventToMessages } from "../chat/chat-event-state.js";

const MAX_MESSAGES = 200;
const PULSEED_VERSION = getPulseedVersion(import.meta.url);

export interface ApprovalRequest {
  task: Task;
  resolve: (approved: boolean) => void;
}

interface AppProps {
  // Daemon mode (thin client — events via SSE, commands via REST)
  daemonClient?: DaemonClient;
  // Standalone mode (in-process CoreLoop)
  coreLoop?: CoreLoop;
  trustManager?: TrustManager;
  actionHandler?: ActionHandler;
  intentRecognizer?: IntentRecognizer;
  chatRunner?: ChatRunner;
  onApprovalReady?: (requestFn: (req: ApprovalRequest) => void) => void;
  // Shared
  stateManager: StateManager;
  cwd?: string;
  gitBranch?: string;
  providerName?: string;
  noFlicker?: boolean;
}

const StatusBar: React.FC<{
  goalCount: number;
  trustScore: number;
  status: string;
  iteration: number;
  daemonConnected?: boolean;
}> = ({ goalCount, trustScore, status, iteration, daemonConnected }) => (
  <Box
    borderStyle="single"
    borderColor={theme.border}
    paddingX={1}
    justifyContent="space-between"
  >
    <Text dimColor>
      Active: {goalCount}  Trust: {trustScore >= 0 ? "+" : ""}
      {trustScore}  Status: {statusLabel(status)}  Iter: {iteration}
      {daemonConnected !== undefined && (daemonConnected ? "  [daemon]" : "  [disconnected]")}
    </Text>
    <Text dimColor>d:dashboard  ?:help  Ctrl-C× 2:quit</Text>
  </Box>
);

// ─── Default idle loop state for daemon mode ───

const IDLE_LOOP_STATE: LoopState = {
  running: false,
  goalId: null,
  iteration: 0,
  status: "idle",
  dimensions: [],
  trustScore: 0,
  startedAt: null,
  lastResult: null,
};

export function App({
  daemonClient,
  coreLoop,
  stateManager,
  trustManager,
  actionHandler,
  intentRecognizer,
  chatRunner,
  onApprovalReady,
  cwd,
  gitBranch,
  providerName,
  noFlicker,
}: AppProps) {
  const isDaemonMode = daemonClient !== undefined && coreLoop === undefined;

  // ── Terminal dimensions ──
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const [showSidebar, setShowSidebar] = useState(false);

  // ── Loop state ──
  // In standalone mode, useLoop() manages state via CoreLoop.
  // In daemon mode, we maintain local state updated via SSE events.
  const standaloneHook = (!isDaemonMode && coreLoop && trustManager)
    ? useLoop(coreLoop, stateManager, trustManager)
    : null;

  const [daemonLoopState, setDaemonLoopState] = useState<LoopState>(IDLE_LOOP_STATE);
  const [daemonConnected, setDaemonConnected] = useState(false);

  const loopState = isDaemonMode ? daemonLoopState : (standaloneHook?.loopState ?? IDLE_LOOP_STATE);
  const startLoop = isDaemonMode
    ? (goalId: string) => { daemonClient!.startGoal(goalId).catch(() => {}); }
    : (standaloneHook?.start ?? (() => {}));
  const stopLoop = isDaemonMode
    ? () => {
        if (daemonLoopState.goalId) {
          daemonClient!.stopGoal(daemonLoopState.goalId).catch(() => {});
        }
      }
    : (standaloneHook?.stop ?? (() => {}));

  // ── Daemon SSE event listeners ──
  useEffect(() => {
    if (!isDaemonMode || !daemonClient) return;

    const onConnected = () => setDaemonConnected(true);
    const onDisconnected = () => setDaemonConnected(false);

    const onLoopUpdate = (data: unknown) => {
      const d = data as Record<string, unknown>;
      setDaemonLoopState((prev) => ({
        ...prev,
        running: (d.running as boolean) ?? prev.running,
        goalId: (d.goalId as string | null) ?? prev.goalId,
        iteration: (d.iteration as number) ?? prev.iteration,
        status: (d.status as string) ?? prev.status,
        trustScore: (d.trustScore as number) ?? prev.trustScore,
      }));
    };

    const onApproval = (data: unknown) => {
      const d = data as Record<string, unknown>;
      const task = d.task as Task;
      const requestId = d.requestId as string;
      const goalId = d.goalId as string;

      approvalRequestRef.current = {
        task,
        resolve: (approved: boolean) => {
          daemonClient.approve(goalId, requestId, approved).catch(() => {});
        },
      };
      setApprovalRequest(approvalRequestRef.current);
    };

    daemonClient.on("_connected", onConnected);
    daemonClient.on("_disconnected", onDisconnected);
    daemonClient.on("loop_update", onLoopUpdate);
    daemonClient.on("approval_required", onApproval);

    return () => {
      daemonClient.off("_connected", onConnected);
      daemonClient.off("_disconnected", onDisconnected);
      daemonClient.off("loop_update", onLoopUpdate);
      daemonClient.off("approval_required", onApproval);
    };
  }, [isDaemonMode, daemonClient]);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: randomUUID(),
      role: "pulseed",
      text: "What would you like to do? Type '/help' for available commands.",
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [showFlicker, setShowFlicker] = useState(false);
  const [goalNames, setGoalNames] = useState<string[]>([]);
  const [reportToShow, setReportToShow] = useState<Report | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const approvalRequestRef = useRef<ApprovalRequest | null>(null);

  // Ctrl-C double-press exit state
  const [ctrlCPending, setCtrlCPending] = useState(false);

  // Expose setApprovalRequest to entry.ts via callback prop (standalone mode)
  const showApprovalRequest = useCallback((req: ApprovalRequest) => {
    approvalRequestRef.current = req;
    setApprovalRequest(req);
  }, []);

  useEffect(() => {
    if (onApprovalReady) {
      onApprovalReady(showApprovalRequest);
    }
  }, [onApprovalReady, showApprovalRequest]);

  // Start ChatRunner session on mount (standalone mode)
  useEffect(() => {
    if (chatRunner) {
      chatRunner.startSession(process.cwd());
      chatRunner.onEvent = (event) => {
        setMessages((prev) => applyChatEventToMessages(prev, event, MAX_MESSAGES) as ChatMessage[]);
      };
    }
  }, [chatRunner]);

  // Pre-load active/waiting goal names for fuzzy completion in Chat
  useEffect(() => {
    (async () => {
      try {
        const ids = await stateManager.listGoalIds();
        const names: string[] = [];
        for (const id of ids) {
          const goal = await stateManager.loadGoal(id);
          if (goal && (goal.status === "active" || goal.status === "waiting")) {
            names.push(goal.title);
          }
        }
        setGoalNames(names);
      } catch {
        // Non-critical — goal completion simply won't show suggestions
      }
    })();
  }, [stateManager]);

  // Handle Ctrl-C via useInput (raw mode — SIGINT does not fire when Ink holds the terminal)
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (ctrlCPending) {
        // Second Ctrl-C — disconnect and exit
        if (isDaemonMode && daemonClient) {
          daemonClient.disconnect();
        } else if (coreLoop) {
          coreLoop.stop();
        }
        process.exit(0);
      }
      setCtrlCPending(true);
      setTimeout(() => setCtrlCPending(false), 3000);
      return;
    }

    // Any other input cancels the pending Ctrl-C
    if (ctrlCPending) {
      setCtrlCPending(false);
    }

    // F1 key toggles help overlay
    if (
      input === "OP" ||
      input === "[11~" ||
      input === "[[A"
    ) {
      setShowHelp((prev) => !prev);
    }
  }, { isActive: reportToShow === null && approvalRequest === null });

  const handleClear = useCallback(() => {
    setMessages([
      {
        id: randomUUID(),
        role: "pulseed" as const,
        text: "Chat cleared. Type '/help' for available commands.",
        timestamp: new Date(),
        messageType: "info" as const,
      },
    ]);
  }, []);

  const handleInput = useCallback(
    async (input: string) => {
      if (isProcessing) return;
      // Add user message
      setMessages((prev) => [...prev, { id: randomUUID(), role: "user" as const, text: input, timestamp: new Date() }].slice(-MAX_MESSAGES));
      setIsProcessing(true);

      try {
        // Local-only commands — no LLM round-trip needed
        const trimmedInput = input.trim().toLowerCase();
        if (trimmedInput === "/flicker") {
          setShowFlicker(true);
          return;
        }

        const bashCommand = extractBashCommand(input);
        if (bashCommand !== null) {
          if (!bashCommand) {
            setMessages((prev) => [...prev, {
              id: randomUUID(),
              role: "pulseed" as const,
              text: "Shell command required after !",
              timestamp: new Date(),
              messageType: "warning" as const,
            }].slice(-MAX_MESSAGES));
            return;
          }

          const shellInput = { command: bashCommand, cwd: process.cwd(), timeoutMs: 120_000 };
          const shellTool = new ShellTool();
          const result = await shellTool.call(shellInput, {
            cwd: process.cwd(),
            goalId: "shell-mode",
            trustBalance: 0,
            preApproved: true,
            approvalFn: async () => true,
            trusted: true,
          });
          const shellOutput = result.data as { stdout?: string; stderr?: string; exitCode?: number } | null;
          const text = shellOutput
            ? formatShellOutput(bashCommand, {
                stdout: shellOutput.stdout ?? "",
                stderr: shellOutput.stderr ?? "",
                exitCode: shellOutput.exitCode ?? (result.success ? 0 : 1),
              })
            : (result.error ? `Error: ${result.error}` : "Shell command completed.");

          setMessages((prev) => [...prev, {
            id: randomUUID(),
            role: "pulseed" as const,
            text,
            timestamp: new Date(),
            messageType: result.success ? ("info" as const) : ("error" as const),
          }].slice(-MAX_MESSAGES));
          return;
        }

        // Slash commands go through IntentRecognizer -> ActionHandler (standalone)
        // or through daemon REST API (daemon mode)
        if (input.startsWith("/") && intentRecognizer && actionHandler) {
          const intent = await intentRecognizer.recognize(input);
          const result = await actionHandler.handle(intent);

          if (result.showHelp) {
            setShowHelp(true);
            return;
          }

          if (trimmedInput === "/settings" || trimmedInput === "/config") {
            setShowSettings(true);
            return;
          }

          if (result.showReport) {
            setReportToShow(result.showReport);
            return;
          }

          setMessages((prev) => [
            ...prev,
            ...result.messages.map((text) => ({
              id: randomUUID(),
              role: "pulseed" as const,
              text,
              timestamp: new Date(),
              messageType: result.messageType ?? ("info" as const),
            })),
          ].slice(-MAX_MESSAGES));

          if (result.toggleDashboard === "toggle") {
            setShowSidebar(prev => !prev);
          }

          if (result.startLoop) {
            startLoop(result.startLoop.goalId);
          }
          if (result.stopLoop) {
            if (approvalRequestRef.current) {
              approvalRequestRef.current.resolve(false);
              approvalRequestRef.current = null;
              setApprovalRequest(null);
            }
            stopLoop();
          }
        } else if (input.startsWith("/") && isDaemonMode) {
          // Daemon mode: handle basic slash commands locally
          const trimmed = input.trim().toLowerCase();
          if (trimmed === "/help" || trimmed === "/?") {
            setShowHelp(true);
          } else if (trimmed === "/settings" || trimmed === "/config") {
            setShowSettings(true);
          } else if (trimmed === "/dashboard" || trimmed === "/d") {
            setShowSidebar(prev => !prev);
          } else if (trimmed === "/flicker") {
            setShowFlicker(true);
          } else if (trimmed.startsWith("/start ")) {
            const goalId = input.slice(7).trim();
            if (goalId) {
              startLoop(goalId);
              setMessages((prev) => [...prev, {
                id: randomUUID(), role: "pulseed" as const,
                text: `Starting goal: ${goalId}`, timestamp: new Date(), messageType: "info" as const,
              }].slice(-MAX_MESSAGES));
            }
          } else if (trimmed === "/stop") {
            stopLoop();
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: "Stop signal sent to daemon.", timestamp: new Date(), messageType: "info" as const,
            }].slice(-MAX_MESSAGES));
          } else {
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: `Unknown command: ${input}. Type /help for available commands.`,
              timestamp: new Date(), messageType: "warning" as const,
            }].slice(-MAX_MESSAGES));
          }
        } else if (isDaemonMode && daemonClient && daemonLoopState.goalId) {
          // Daemon mode: free-form text → daemon chat endpoint
          try {
            await daemonClient.chat(daemonLoopState.goalId, input);
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: "Message sent to daemon.", timestamp: new Date(), messageType: "info" as const,
            }].slice(-MAX_MESSAGES));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setMessages((prev) => [...prev, {
              id: randomUUID(), role: "pulseed" as const,
              text: `Chat error: ${msg}`, timestamp: new Date(), messageType: "error" as const,
            }].slice(-MAX_MESSAGES));
          }
        } else if (chatRunner) {
          // Standalone mode: free-form text goes through ChatRunner
          await chatRunner.execute(input, process.cwd());
        } else {
          // Fallback: no chat capability
          setMessages((prev) => [...prev, {
            id: randomUUID(), role: "pulseed" as const,
            text: isDaemonMode
              ? "No active goal. Use /start <goal-id> to begin."
              : "Chat is not available. Use slash commands (/help).",
            timestamp: new Date(), messageType: "info" as const,
          }].slice(-MAX_MESSAGES));
        }
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
        ].slice(-MAX_MESSAGES));
      } finally {
        setIsProcessing(false);
      }
    },
    [intentRecognizer, actionHandler, chatRunner, daemonClient, isDaemonMode, daemonLoopState.goalId, startLoop, stopLoop, isProcessing]
  );

  // goalCount: 1 when there is an active goal in the loop, 0 otherwise
  const goalCount = loopState.goalId !== null ? 1 : 0;

  // ─── Sidebar layout ───
  return (
    <Box flexDirection="column" height={termRows}>
      {/* App banner — Claude Code style */}
      <Box flexDirection="row" paddingY={0}>
        {/* Seedy pixel art (left) */}
        <Box marginRight={2}>
          <Text>{SEEDY_PIXEL}</Text>
        </Box>
        {/* Info text (right, vertically centered) */}
        <Box flexDirection="column" justifyContent="center">
          <Box>
            <Text bold color={theme.brand}>PulSeed</Text>
            <Text dimColor> v{PULSEED_VERSION}</Text>
          </Box>
          <Text dimColor>
            daemon: {isDaemonMode ? "on" : "off"}{providerName ? ` · ${providerName}` : ""}
          </Text>
          {cwd && (
            <Text dimColor>{cwd}</Text>
          )}
        </Box>
      </Box>

      {/* Main content: sidebar + chat */}
      <Box flexDirection="row" flexGrow={1}>
        {/* ── Left sidebar: Dashboard ── */}
        {showSidebar && (
          <Box
            flexDirection="column"
            width="30%"
            borderStyle="single"
            borderColor={theme.border}
            paddingX={1}
            overflow="hidden"
          >
            <Dashboard state={loopState} />
          </Box>
        )}

        {/* ── Right pane: Chat / overlays ── */}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {approvalRequest !== null ? (
            <ApprovalOverlay
              task={approvalRequest.task}
              onDecision={(approved) => {
                approvalRequest.resolve(approved);
                approvalRequestRef.current = null;
                setApprovalRequest(null);
              }}
            />
          ) : showSettings ? (
            <SettingsOverlay onClose={() => setShowSettings(false)} />
          ) : showFlicker ? (
            <FlickerOverlay onClose={() => setShowFlicker(false)} />
          ) : reportToShow !== null ? (
            <ReportView report={reportToShow} onDismiss={() => setReportToShow(null)} />
          ) : showHelp ? (
            <HelpOverlay onDismiss={() => setShowHelp(false)} />
          ) : (
            <Chat messages={messages} onSubmit={handleInput} onClear={handleClear} isProcessing={isProcessing} goalNames={goalNames} noFlicker={noFlicker} />
          )}
        </Box>
      </Box>

      <StatusBar
        goalCount={goalCount}
        trustScore={loopState.trustScore}
        status={loopState.status}
        iteration={loopState.iteration}
        daemonConnected={isDaemonMode ? daemonConnected : undefined}
      />
      {ctrlCPending && (
        <Box paddingX={1}>
          <Text color={theme.warning}>(Press Ctrl-C once more to quit)</Text>
        </Box>
      )}
    </Box>
  );
}
