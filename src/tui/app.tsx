// ─── App ───
//
// Root Ink component that composes Dashboard + Chat and manages shared state.
// Layout: horizontal split — Dashboard sidebar (left, ~30%) + Chat (right, ~70%).
// Uses the useLoop() hook internally for loop state management.
// Routes chat input through IntentRecognizer → ActionHandler.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { Dashboard } from "./dashboard.js";
import { Chat, type ChatMessage } from "./chat.js";
import { HelpOverlay } from "./help-overlay.js";
import { ApprovalOverlay } from "./approval-overlay.js";
import { useLoop } from "./use-loop.js";
import type { ActionHandler } from "./actions.js";
import type { IntentRecognizer } from "./intent-recognizer.js";
import type { CoreLoop } from "../core-loop.js";
import type { StateManager } from "../state-manager.js";
import type { TrustManager } from "../trust-manager.js";
import type { Task } from "../types/task.js";

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
  onApprovalReady?: (requestFn: (req: ApprovalRequest) => void) => void;
}

const StatusBar: React.FC<{
  goalCount: number;
  trustScore: number;
  status: string;
  iteration: number;
}> = ({ goalCount, trustScore, status, iteration }) => (
  <Box
    borderStyle="single"
    borderColor="gray"
    paddingX={1}
    justifyContent="space-between"
  >
    <Text dimColor>
      Active: {goalCount}  Trust: {trustScore >= 0 ? "+" : ""}
      {trustScore}  Status: {status}  Iter: {iteration}
    </Text>
    <Text dimColor>?:help  Ctrl-C:quit</Text>
  </Box>
);

export function App({
  coreLoop,
  stateManager,
  trustManager,
  actionHandler,
  intentRecognizer,
  onApprovalReady,
}: AppProps) {
  // ── Loop state via hook ──
  const { loopState, start, stop, getController } = useLoop(coreLoop, stateManager, trustManager);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "motiva",
      text: "What would you like to do? Type '/help' for available commands.",
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const approvalRequestRef = useRef<ApprovalRequest | null>(null);

  // Expose setApprovalRequest to entry.ts via callback prop
  useEffect(() => {
    if (onApprovalReady) {
      onApprovalReady((req: ApprovalRequest) => {
        approvalRequestRef.current = req;
        setApprovalRequest(req);
      });
    }
  }, [onApprovalReady]);

  // F1 key toggles help overlay (in addition to '?' shortcut via chat).
  // F1 sends escape sequences: "\u001bOP" (xterm) or "\u001b[11~" (vt100).
  // isActive:false when help is shown — HelpOverlay handles its own ESC key,
  // and we avoid competing with TextInput for input events during normal chat.
  useInput((rawInput) => {
    if (
      rawInput === "\u001bOP" ||
      rawInput === "\u001b[11~" ||
      rawInput === "\u001b[[A"
    ) {
      setShowHelp((prev) => !prev);
    }
  }, { isActive: !showHelp && approvalRequest === null });

  const handleInput = useCallback(
    async (input: string) => {
      // Add user message
      setMessages((prev) => [...prev, { role: "user" as const, text: input, timestamp: new Date() }].slice(-MAX_MESSAGES));
      setIsProcessing(true);

      // Recognize intent
      const intent = await intentRecognizer.recognize(input);

      // Execute action
      const result = await actionHandler.handle(intent);

      // Handle help overlay signal — do not add messages to chat
      if (result.showHelp) {
        setShowHelp(true);
        setIsProcessing(false);
        return;
      }

      // Add response messages
      setMessages((prev) => [
        ...prev,
        ...result.messages.map((text) => ({
          role: "motiva" as const,
          text,
          timestamp: new Date(),
          messageType: (text.startsWith("Failed") || text.startsWith("Error"))
            ? ("error" as const)
            : ("info" as const),
        })),
      ].slice(-MAX_MESSAGES));

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

      setIsProcessing(false);
    },
    [intentRecognizer, actionHandler, start, stop]
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
    <Box flexDirection="column" height={process.stdout.rows || 24}>
      {/* App header */}
      <Text bold color="blue">
        [ MOTIVA ]
      </Text>

      {/* Main content: sidebar + chat */}
      <Box flexDirection="row" flexGrow={1}>
        {/* ── Left sidebar: Dashboard ── */}
        <Box
          flexDirection="column"
          width="30%"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Dashboard state={loopState} />
        </Box>

        {/* ── Right pane: Chat / overlays ── */}
        <Box flexDirection="column" flexGrow={1}>
          {approvalRequest !== null ? (
            <ApprovalOverlay
              task={approvalRequest.task}
              onDecision={(approved) => {
                approvalRequest.resolve(approved);
                approvalRequestRef.current = null;
                setApprovalRequest(null);
              }}
            />
          ) : showHelp ? (
            <HelpOverlay onDismiss={() => setShowHelp(false)} />
          ) : (
            <Chat messages={messages} onSubmit={handleInput} isProcessing={isProcessing} />
          )}
        </Box>
      </Box>

      <StatusBar
        goalCount={goalCount}
        trustScore={loopState.trustScore}
        status={loopState.status}
        iteration={loopState.iteration}
      />
    </Box>
  );
}
