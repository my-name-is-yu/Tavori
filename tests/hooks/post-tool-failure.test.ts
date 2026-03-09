import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StateManager } from '../../src/state/manager.js';
import { processPostToolFailure } from '../../src/hooks/post-tool-failure.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `motiva-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpRoot: string;
let manager: StateManager;

beforeEach(() => {
  tmpRoot = makeTmpDir();
  manager = new StateManager(tmpRoot);
  manager.init();
});

// ---------------------------------------------------------------------------
// Failure counter increments
// ---------------------------------------------------------------------------

describe('post-tool-failure: failure counter', () => {
  it('increments failure counter from 0 to 1 on first failure', async () => {
    const result = await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);

    expect(result.failureCount).toBe(1);
    const state = manager.loadState();
    expect(state.stall_state.consecutive_failures['Bash']).toBe(1);
  });

  it('increments counter correctly across multiple invocations', async () => {
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    const result = await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);

    expect(result.failureCount).toBe(3);
    const state = manager.loadState();
    expect(state.stall_state.consecutive_failures['Bash']).toBe(3);
  });

  it('tracks counters independently per tool', async () => {
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Read' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);

    const state = manager.loadState();
    expect(state.stall_state.consecutive_failures['Bash']).toBe(2);
    expect(state.stall_state.consecutive_failures['Read']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No stall below threshold
// ---------------------------------------------------------------------------

describe('post-tool-failure: below stall threshold', () => {
  it('does not detect stall on first failure', async () => {
    const result = await processPostToolFailure({ tool_name: 'Write' }, tmpRoot);

    expect(result.stallDetected).toBe(false);
    expect(result.stallResult).toBeNull();
    expect(result.recoveryMessage).toBeNull();
  });

  it('does not detect stall on second failure', async () => {
    await processPostToolFailure({ tool_name: 'Write' }, tmpRoot);
    const result = await processPostToolFailure({ tool_name: 'Write' }, tmpRoot);

    expect(result.stallDetected).toBe(false);
    expect(result.recoveryMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stall detection at threshold
// ---------------------------------------------------------------------------

describe('post-tool-failure: stall detection at threshold (3)', () => {
  it('detects stall on 3rd consecutive failure', async () => {
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    const result = await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);

    expect(result.stallDetected).toBe(true);
    expect(result.stallResult).not.toBeNull();
    expect(result.stallResult!.tool_name).toBe('Bash');
    expect(result.stallResult!.failure_count).toBe(3);
  });

  it('continues detecting stall on 4th and subsequent failures', async () => {
    await processPostToolFailure({ tool_name: 'Read' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Read' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Read' }, tmpRoot); // threshold
    const result = await processPostToolFailure({ tool_name: 'Read' }, tmpRoot); // 4th

    expect(result.stallDetected).toBe(true);
    expect(result.failureCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Stall state persistence
// ---------------------------------------------------------------------------

describe('post-tool-failure: stall state in MotiveState', () => {
  it('updates last_stall_at when stall is detected', async () => {
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);

    const state = manager.loadState();
    expect(state.stall_state.last_stall_at).not.toBeNull();
  });

  it('increments stall_count when stall is detected', async () => {
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);

    const state = manager.loadState();
    expect(state.stall_state.stall_count).toBe(1);
  });

  it('stall_count does not increment when below threshold', async () => {
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Edit' }, tmpRoot);

    const state = manager.loadState();
    expect(state.stall_state.stall_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recovery message generation
// ---------------------------------------------------------------------------

describe('post-tool-failure: recovery message', () => {
  async function triggerStall(toolName: string, error?: string): Promise<import('../../src/hooks/post-tool-failure.js').PostToolFailureResult> {
    await processPostToolFailure({ tool_name: toolName, error }, tmpRoot);
    await processPostToolFailure({ tool_name: toolName, error }, tmpRoot);
    return processPostToolFailure({ tool_name: toolName, error }, tmpRoot);
  }

  it('recovery message is null when no stall', async () => {
    const result = await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    expect(result.recoveryMessage).toBeNull();
  });

  it('generates recovery message when stall is detected', async () => {
    const result = await triggerStall('Bash');
    expect(result.recoveryMessage).not.toBeNull();
    expect(typeof result.recoveryMessage).toBe('string');
    expect(result.recoveryMessage!.length).toBeGreaterThan(0);
  });

  it('recovery message contains tool name', async () => {
    const result = await triggerStall('Bash');
    expect(result.recoveryMessage).toContain('Bash');
  });

  it('recovery message contains failure count', async () => {
    const result = await triggerStall('Bash');
    expect(result.recoveryMessage).toContain('3');
  });

  it('recovery message mentions cause for Read → information_deficit', async () => {
    const result = await triggerStall('Read');
    expect(result.recoveryMessage).toMatch(/information_deficit/i);
  });

  it('recovery message mentions permission_deficit for Bash with permission error', async () => {
    const result = await triggerStall('Bash', 'permission denied');
    expect(result.recoveryMessage).toMatch(/permission_deficit/i);
  });

  it('recovery message mentions capability_deficit for Write', async () => {
    const result = await triggerStall('Write');
    expect(result.recoveryMessage).toMatch(/capability_deficit/i);
  });

  it('recovery message mentions recovery type for investigate strategy', async () => {
    const result = await triggerStall('Read');
    expect(result.recoveryMessage).toMatch(/investigate/i);
  });

  it('recovery message mentions recovery type for escalate strategy', async () => {
    const result = await triggerStall('Bash', 'permission denied');
    expect(result.recoveryMessage).toMatch(/escalate/i);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('post-tool-failure: logging', () => {
  it('appends an entry to log.jsonl on each failure', async () => {
    await processPostToolFailure({ tool_name: 'Bash', error: 'exit code 1' }, tmpRoot);

    const logPath = join(tmpRoot, '.motive', 'log.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.event).toBe('post_tool_failure');
    expect(entry.tool_name).toBe('Bash');
    expect(entry.error).toBe('exit code 1');
  });

  it('log entry includes stall_detected=true when stall fires', async () => {
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);

    const logPath = join(tmpRoot, '.motive', 'log.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.stall_detected).toBe(true);
  });

  it('log entry includes stall_detected=false when no stall', async () => {
    await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);

    const logPath = join(tmpRoot, '.motive', 'log.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.stall_detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handles missing/empty state gracefully
// ---------------------------------------------------------------------------

describe('post-tool-failure: edge cases', () => {
  it('works when no state file exists yet (fresh project)', async () => {
    // init() already created state; remove state file to simulate fresh project
    const stateFile = join(tmpRoot, '.motive', 'state.json');
    require('node:fs').unlinkSync(stateFile);

    const result = await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    expect(result.failureCount).toBe(1);
  });

  it('handles undefined error field gracefully', async () => {
    const result = await processPostToolFailure({ tool_name: 'Bash' }, tmpRoot);
    expect(result.failureCount).toBe(1);
    expect(result.stallDetected).toBe(false);
  });
});
