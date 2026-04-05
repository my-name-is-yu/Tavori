// ─── App ───
//
// Root Ink component that composes Dashboard + Chat and manages shared state.
// Layout: horizontal split — Dashboard sidebar (left, ~30%) + Chat (right, ~70%).
// Uses the useLoop() hook internally for loop state management.
// Routes chat input through IntentRecognizer → ActionHandler.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useInput, useStdout } from "ink";
import { theme } from "./theme.js";
import { Dashboard, statusLabel } from "./dashboard.js";
import { Chat, type ChatMessage } from "./chat.js";
import { HelpOverlay } from "./help-overlay.js";
import { ApprovalOverlay } from "./approval-overlay.js";
import { ReportView } from "./report-view.js";
import type { Report } from "../../base/types/report.js";
import { useLoop } from "./use-loop.js";
import type { ActionHandler } from "./actions.js";
import type { IntentRecognizer } from "./intent-recognizer.js";
import type { CoreLoop } from "../../orchestrator/loop/core-loop.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";
import type { Task } from "../../base/types/task.js";
import type { ChatRunner } from "../../interface/chat/chat-runner.js";

const MAX_MESSAGES = 200;

export interface ApprovalRequest {
  task: Task;
  resolve: (approved: boolean) => void;
}

interface AppProps {
  coreLoop: CoreLoop;
  stateManager: StateManager;
  trustManager: TrustManager;
  actionHandler: ActionHandler;
  intentRecognizer: IntentRecognizer;
  chatRunner?: ChatRunner;
  onApprovalReady?: (requestFn: (req: ApprovalRequest) => void) => void;
  cwd?: string;
  gitBranch?: string;
  providerName?: string;
}

const StatusBar: React.FC<{
  goalCount: number;
  trustScore: number;
  status: string;
  iteration: number;
}> = ({ goalCount, trustScore, status, iteration }) => (
  <Box
    borderStyle="single"
    borderColor={theme.border}
    paddingX={1}
    justifyContent="space-between"
  >
    <Text dimColor>
      Active: {goalCount}  Trust: {trustScore >= 0 ? "+" : ""}
      {trustScore}  Status: {statusLabel(status)}  Iter: {iteration}
    </Text>
    <Text dimColor>d:dashboard  ?:help  Ctrl-C× 2:quit</Text>
  </Box>
);

export function App({
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
}: AppProps) {
  // ── Terminal dimensions ──
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const [showSidebar, setShowSidebar] = useState(false);

  // ── Loop state via hook ──
  const { loopState, start, stop, getController } = useLoop(coreLoop, stateManager, trustManager);

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
  const [goalNames, setGoalNames] = useState<string[]>([]);
  const [reportToShow, setReportToShow] = useState<Report | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const approvalRequestRef = useRef<ApprovalRequest | null>(null);

  // Ctrl-C double-press exit state
  const [ctrlCPending, setCtrlCPending] = useState(false);

  // Expose setApprovalRequest to entry.ts via callback prop
  useEffect(() => {
    if (onApprovalReady) {
      onApprovalReady((req: ApprovalRequest) => {
        approvalRequestRef.current = req;
        setApprovalRequest(req);
      });
    }
  }, [onApprovalReady]);

  // Start ChatRunner session on mount (persists history across turns)
  useEffect(() => {
    if (chatRunner) {
      chatRunner.startSession(process.cwd());
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
  // exitOnCtrlC:false is set on render() in entry.ts, so Ctrl-C reaches useInput as input="c", key.ctrl=true
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (ctrlCPending) {
        // Second Ctrl-C — stop loop and exit
        coreLoop.stop();
        process.exit(0);
      }
      setCtrlCPending(true);
      // Auto-clear the pending flag after 3 seconds
      setTimeout(() => setCtrlCPending(false), 3000);
      return;
    }

    // Any other input cancels the pending Ctrl-C
    if (ctrlCPending) {
      setCtrlCPending(false);
    }

    // F1 key toggles help overlay (in addition to '?' shortcut via chat).
    // F1 sends escape sequences: "OP" (xterm) or "[11~" (vt100).
    if (
      input === "OP" ||
      input === "[11~" ||
      input === "[[A"
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
        // Slash commands go through IntentRecognizer -> ActionHandler
        if (input.startsWith("/")) {
          // Recognize intent
          const intent = await intentRecognizer.recognize(input);

          // Execute action
          const result = await actionHandler.handle(intent);

          // Handle help overlay signal — do not add messages to chat
          if (result.showHelp) {
            setShowHelp(true);
            return;
          }

          // Handle report overlay signal — do not add messages to chat
          if (result.showReport) {
            setReportToShow(result.showReport);
            return;
          }

          // Add response messages
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

          // Handle dashboard toggle signal
          if (result.toggleDashboard === "toggle") {
            setShowSidebar(prev => !prev);
          }

          // Handle loop signals
          if (result.startLoop) {
            start(result.startLoop.goalId);
          }
          if (result.stopLoop) {
            // Reject any pending approval before stopping
            if (approvalRequestRef.current) {
              approvalRequestRef.current.resolve(false);
              approvalRequestRef.current = null;
              setApprovalRequest(null);
            }
            stop();
          }
        } else if (chatRunner) {
          // Free-form text goes through ChatRunner for live LLM chat
          const result = await chatRunner.execute(input, process.cwd());

          setMessages((prev) => [
            ...prev,
            {
              id: randomUUID(),
              role: "pulseed" as const,
              text: result.output || "(no response)",
              timestamp: new Date(),
              messageType: result.success ? ("info" as const) : ("error" as const),
            },
          ].slice(-MAX_MESSAGES));
        } else {
          // No chatRunner available — fall through to intent recognizer
          const intent = await intentRecognizer.recognize(input);
          const result = await actionHandler.handle(intent);
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
    [intentRecognizer, actionHandler, chatRunner, start, stop, isProcessing]
  );

  // Expose controller for SIGINT shutdown in entry.ts
  // (called once, ref is stable)
  useEffect(() => {
    // nothing — getController() is available synchronously when needed
  }, [getController]);

  // goalCount: 1 when there is an active goal in the loop, 0 otherwise
  const goalCount = loopState.goalId !== null ? 1 : 0;

  // ─── Sidebar layout ───
  // Horizontal split: Dashboard sidebar (~30%) on the left, Chat (~70%) on the right.
  // Overlays (approval, help) replace the chat pane when active.

  return (
    <Box flexDirection="column" height={termRows}>
      {/* App header */}
      <Box>
        <Text bold color={theme.header}>[ PULSEED ]</Text>
        {(cwd || gitBranch || providerName) && (
          <Text dimColor>
            {"  "}
            {cwd ?? ""}
            {gitBranch ? ` (${gitBranch})` : ""}
            {providerName ? `  ${providerName}` : ""}
          </Text>
        )}
      </Box>

      {/* Main content: sidebar + chat */}
      <Box flexDirection="row" flexGrow={1}>
        {/* ── Left sidebar: Dashboard (hidden when terminal is too narrow) ── */}
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
          ) : reportToShow !== null ? (
            <ReportView report={reportToShow} onDismiss={() => setReportToShow(null)} />
          ) : showHelp ? (
            <HelpOverlay onDismiss={() => setShowHelp(false)} />
          ) : (
            <Chat messages={messages} onSubmit={handleInput} onClear={handleClear} isProcessing={isProcessing} goalNames={goalNames} />
          )}
        </Box>
      </Box>

      <StatusBar
        goalCount={goalCount}
        trustScore={loopState.trustScore}
        status={loopState.status}
        iteration={loopState.iteration}
      />
      {ctrlCPending && (
        <Box paddingX={1}>
          <Text color={theme.warning}>(Press Ctrl-C once more to quit)</Text>
        </Box>
      )}
    </Box>
  );
}
