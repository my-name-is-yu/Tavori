import { StateManager } from '../state/manager.js';
import { StallDetectionEngine } from '../engines/stall-detection.js';
import type { StallResult } from '../engines/stall-detection.js';

export interface PostToolFailureInput {
  tool_name: string;
  error?: string;
}

export interface PostToolFailureResult {
  stallDetected: boolean;
  stallResult: StallResult | null;
  failureCount: number;
  recoveryMessage: string | null;
}

function buildRecoveryMessage(stall: StallResult): string {
  return [
    `[Motiva] Stall detected: "${stall.tool_name}" has failed ${stall.failure_count} times consecutively.`,
    `Cause: ${stall.cause}.`,
    `Recovery (${stall.recovery.type}): ${stall.recovery.description}`,
  ].join(' ');
}

export async function processPostToolFailure(
  input: PostToolFailureInput,
  projectRoot?: string,
): Promise<PostToolFailureResult> {
  const root = projectRoot ?? process.cwd();
  const manager = new StateManager(root);
  const state = manager.loadState();

  // Reconstruct stall engine from persisted counters so each hook invocation
  // reflects the full history of failures — not just the current process.
  const stallEngine = new StallDetectionEngine();
  for (const [tool, count] of Object.entries(state.stall_state.consecutive_failures)) {
    for (let i = 0; i < count; i++) {
      stallEngine.onFailure(tool);
    }
  }

  // Record this failure
  const stallResult = stallEngine.onFailure(input.tool_name, input.error);

  // Persist updated failure counter
  const newCount = stallEngine.getFailureCount(input.tool_name);
  state.stall_state.consecutive_failures[input.tool_name] = newCount;

  if (stallResult) {
    state.stall_state.last_stall_at = new Date().toISOString();
    state.stall_state.stall_count = (state.stall_state.stall_count ?? 0) + 1;
  }

  manager.saveState(state);

  // Log failure
  manager.appendLog({
    event: 'post_tool_failure',
    tool_name: input.tool_name,
    error: input.error ?? null,
    failure_count: newCount,
    stall_detected: stallResult !== null,
    timestamp: new Date().toISOString(),
  });

  const recoveryMessage = stallResult ? buildRecoveryMessage(stallResult) : null;

  return {
    stallDetected: stallResult !== null,
    stallResult,
    failureCount: newCount,
    recoveryMessage,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: PostToolFailureInput = { tool_name: 'Unknown' };
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput) as PostToolFailureInput;
    } catch {
      // Unparseable stdin — use defaults
    }
  }

  const result = await processPostToolFailure(input);

  if (result.recoveryMessage) {
    process.stdout.write(result.recoveryMessage + '\n');
  }

  process.exit(0);
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('post-tool-failure.ts') ||
    process.argv[1].endsWith('post-tool-failure.js'))
) {
  main().catch(() => process.exit(1));
}
