import React, { useCallback, useMemo, useState } from "react";
import { randomUUID } from "node:crypto";
import { Box, Text, useStdout } from "ink";
import { Chat, type ChatMessage } from "./chat.js";
import { FullscreenChat } from "./fullscreen-chat.js";
import { formatShellOutput, extractBashCommand } from "./bash-mode.js";
import { execFileNoThrow } from "../../base/utils/execFileNoThrow.js";
import { theme } from "./theme.js";
import { getTuiDebugLogPath } from "./debug-log.js";

interface TUITestAppProps {
  cwd: string;
  gitBranch: string;
  noFlicker: boolean;
  controlStream?: Pick<NodeJS.WriteStream, "write">;
}

function createSystemMessage(
  text: string,
  messageType: ChatMessage["messageType"] = "info",
): ChatMessage {
  return {
    id: randomUUID(),
    role: "pulseed",
    text,
    timestamp: new Date(),
    messageType,
  };
}

export function TUITestApp({ cwd, gitBranch, noFlicker, controlStream }: TUITestAppProps) {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const termCols = stdout?.columns ?? 80;
  const [messages, setMessages] = useState<ChatMessage[]>([
    createSystemMessage(
      [
        "TUI test mode.",
        "Only shell input is enabled.",
        "Type !ls and scroll to inspect the input box behavior.",
        `Debug log: ${getTuiDebugLogPath()}`,
      ].join("\n"),
    ),
  ]);
  const [isProcessing, setIsProcessing] = useState(false);

  const goalNames = useMemo(() => [] as string[], []);

  const handleClear = useCallback(() => {
    setMessages([
      createSystemMessage("TUI test log cleared. Type !ls to add more output."),
    ]);
  }, []);

  const handleInput = useCallback(async (input: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: randomUUID(),
        role: "user",
        text: input,
        timestamp: new Date(),
      },
    ]);

    const shellCommand = extractBashCommand(input);
    if (shellCommand === null) {
      setMessages((prev) => [
        ...prev,
        createSystemMessage("TUI test mode only accepts shell commands starting with !", "warning"),
      ]);
      return;
    }

    if (!shellCommand) {
      setMessages((prev) => [
        ...prev,
        createSystemMessage("Shell command required after !", "warning"),
      ]);
      return;
    }

    setIsProcessing(true);

    const shell = process.env.SHELL ?? "/bin/zsh";
    const result = await execFileNoThrow(shell, ["-c", shellCommand], {
      cwd: process.cwd(),
      timeoutMs: 120_000,
      env: process.env,
    });

    const text = formatShellOutput(shellCommand, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
    });

    setMessages((prev) => [
      ...prev,
      createSystemMessage(
        text,
        (result.exitCode ?? 1) === 0 ? "info" : "error",
      ),
    ]);
    setIsProcessing(false);
  }, []);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingX={1} flexDirection="column">
        <Text color={theme.header} bold>
          PulSeed TUI test
        </Text>
        <Text dimColor>
          {cwd}{gitBranch ? `  ·  ${gitBranch}` : ""}  ·  no-flicker:{noFlicker ? "on" : "off"}
        </Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {noFlicker ? (
            <FullscreenChat
              messages={messages}
              onSubmit={handleInput}
              onClear={handleClear}
              isProcessing={isProcessing}
              goalNames={goalNames}
              availableRows={Math.max(1, termRows - 8)}
              availableCols={termCols}
            />
          ) : (
            <Chat
              messages={messages}
              onSubmit={handleInput}
              onClear={handleClear}
              isProcessing={isProcessing}
              goalNames={goalNames}
              noFlicker={false}
              availableRows={Math.max(1, termRows - 8)}
              availableCols={termCols}
              controlStream={controlStream}
            />
          )}
        </Box>
      </Box>

      <Box
        borderStyle="single"
        borderColor={theme.border}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text dimColor>test mode  shell only  repeat !ls to build scrollback</Text>
        <Text dimColor>Ctrl-C× 2:quit</Text>
      </Box>
    </Box>
  );
}
