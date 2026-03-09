import { describe, it, expect } from 'vitest';
import {
  detectIrreversible,
  IRREVERSIBLE_PATTERNS,
  run,
} from '../../src/hooks/pre-tool-use.js';

// ---------------------------------------------------------------------------
// detectIrreversible
// ---------------------------------------------------------------------------

describe('detectIrreversible', () => {
  it('returns null for safe commands', () => {
    expect(detectIrreversible('ls -la')).toBeNull();
    expect(detectIrreversible('cat README.md')).toBeNull();
    expect(detectIrreversible('npm install')).toBeNull();
    expect(detectIrreversible('git status')).toBeNull();
    expect(detectIrreversible('git pull')).toBeNull();
    expect(detectIrreversible('git commit -m "fix"')).toBeNull();
  });

  it('detects git push', () => {
    expect(detectIrreversible('git push origin main')).not.toBeNull();
    expect(detectIrreversible('git push')).not.toBeNull();
  });

  it('detects rm -rf', () => {
    expect(detectIrreversible('rm -rf /tmp/stuff')).not.toBeNull();
    expect(detectIrreversible('rm -rf .')).not.toBeNull();
  });

  it('detects curl POST/PUT/DELETE/PATCH', () => {
    expect(detectIrreversible('curl -X POST https://api.example.com/data')).not.toBeNull();
    expect(detectIrreversible('curl -X PUT https://api.example.com/resource/1')).not.toBeNull();
    expect(detectIrreversible('curl -X DELETE https://api.example.com/item')).not.toBeNull();
    expect(detectIrreversible('curl -X PATCH https://api.example.com/partial')).not.toBeNull();
  });

  it('does NOT flag curl GET', () => {
    expect(detectIrreversible('curl -X GET https://api.example.com/data')).toBeNull();
    expect(detectIrreversible('curl https://example.com')).toBeNull();
  });

  it('detects docker push and docker rm', () => {
    expect(detectIrreversible('docker push myimage:latest')).not.toBeNull();
    expect(detectIrreversible('docker rm mycontainer')).not.toBeNull();
  });

  it('does NOT flag docker build or docker run', () => {
    expect(detectIrreversible('docker build -t myapp .')).toBeNull();
    expect(detectIrreversible('docker run -d myapp')).toBeNull();
  });

  it('detects npm publish', () => {
    expect(detectIrreversible('npm publish')).not.toBeNull();
    expect(detectIrreversible('npm publish --access public')).not.toBeNull();
  });

  it('detects deploy keyword', () => {
    expect(detectIrreversible('deploy to production')).not.toBeNull();
    expect(detectIrreversible('Deploy the application')).not.toBeNull();
  });

  it('detects DROP TABLE', () => {
    expect(detectIrreversible('DROP TABLE users;')).not.toBeNull();
    expect(detectIrreversible('drop table sessions')).not.toBeNull();
  });

  it('detects DELETE FROM', () => {
    expect(detectIrreversible('DELETE FROM orders WHERE id = 1;')).not.toBeNull();
    expect(detectIrreversible('delete from logs')).not.toBeNull();
  });

  it('is case-insensitive for curl methods', () => {
    expect(detectIrreversible('curl -X post https://example.com')).not.toBeNull();
  });

  it('exports IRREVERSIBLE_PATTERNS as a non-empty array of RegExp', () => {
    expect(Array.isArray(IRREVERSIBLE_PATTERNS)).toBe(true);
    expect(IRREVERSIBLE_PATTERNS.length).toBeGreaterThan(0);
    for (const p of IRREVERSIBLE_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

describe('run()', () => {
  // --- Safe actions ---

  it('passes safe Bash commands with exit 0', () => {
    const result = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    expect(result.exitCode).toBe(0);
    expect(result.stderrMessage).toBeUndefined();
  });

  it('passes safe Write tool calls with exit 0', () => {
    const result = run({
      tool_name: 'Write',
      tool_input: { file_path: '/project/src/index.ts', content: 'export {}' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('passes safe Read tool calls with exit 0', () => {
    const result = run({ tool_name: 'Read', tool_input: { file_path: 'src/index.ts' } });
    expect(result.exitCode).toBe(0);
  });

  // --- Irreversible Bash commands ---

  it('blocks git push via Bash command field', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderrMessage).toContain('[Motive]');
    expect(result.stderrMessage).toContain('irreversible');
  });

  it('blocks rm -rf via Bash', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ./dist' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks curl POST via Bash', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'curl -X POST https://api.example.com/create' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks docker push via Bash', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'docker push myrepo/myimage:latest' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks npm publish via Bash', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'npm publish --access public' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks deploy keyword in command', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'deploy --env production' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks DROP TABLE in SQL string values', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'psql -c "DROP TABLE users;"' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks DELETE FROM in nested tool_input values', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { query: 'DELETE FROM orders' },
    });
    expect(result.exitCode).toBe(2);
  });

  // --- Pattern not in command field but in other fields ---

  it('blocks irreversible pattern found in non-command fields', () => {
    const result = run({
      tool_name: 'Write',
      tool_input: { file_path: 'run.sh', content: 'git push origin main' },
    });
    expect(result.exitCode).toBe(2);
  });

  // --- Constraint violations ---

  it('blocks Write with path traversal', () => {
    const result = run({
      tool_name: 'Write',
      tool_input: { file_path: '/etc/../etc/passwd', content: 'root:x:0:0' },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderrMessage).toContain('path traversal');
  });

  it('allows Write with normal absolute path (no traversal)', () => {
    const result = run({
      tool_name: 'Write',
      tool_input: { file_path: '/project/src/main.ts', content: '' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('allows Write with relative path', () => {
    const result = run({
      tool_name: 'Write',
      tool_input: { file_path: 'src/main.ts', content: '' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('blocks Edit with path traversal', () => {
    const result = run({
      tool_name: 'Edit',
      tool_input: { file_path: '/app/../../../etc/passwd', old_string: 'a', new_string: 'b' },
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks NotebookEdit with path traversal', () => {
    const result = run({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/home/../etc/hosts', new_source: '' },
    });
    expect(result.exitCode).toBe(2);
  });

  // --- stderr message content ---

  it('stderr message mentions the blocked tool name', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    });
    expect(result.stderrMessage).toContain('Bash');
  });

  it('stderr message mentions human review', () => {
    const result = run({
      tool_name: 'Bash',
      tool_input: { command: 'npm publish' },
    });
    expect(result.stderrMessage).toContain('human');
  });
});
