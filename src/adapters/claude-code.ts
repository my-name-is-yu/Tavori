import { spawn } from 'child_process';

// ---- Irreversible Action Detection ----

const IRREVERSIBLE_PATTERNS = [
  /git\s+push/i,
  /rm\s+-rf/i,
  /drop\s+table/i,
  /npm\s+publish/i,
  /docker\s+push/i,
];

export function detectIrreversibleActions(output: string): string[] {
  return IRREVERSIBLE_PATTERNS
    .filter(p => p.test(output))
    .map(p => p.source);
}

// ---- Types ----

export interface SessionOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ---- Runner ----

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function runSession(
  task: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SessionOutput> {
  return new Promise((resolve) => {
    const args = ['--print', '--dangerously-skip-permissions', task];
    const proc = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Force kill after 5 seconds if process doesn't exit
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + '\n' + err.message,
        timedOut,
      });
    });
  });
}
