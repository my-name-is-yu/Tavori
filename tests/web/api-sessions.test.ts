import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      _body: data,
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

let tmpDir: string;

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => tmpDir ?? original.homedir(),
  };
});

const { GET } = await import('../../web/src/app/api/sessions/route.js');

describe('GET /api/sessions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-web-sessions-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when sessions directory does not exist', async () => {
    const res = await GET();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('returns sessions from JSON files', async () => {
    const sessionsDir = path.join(tmpDir, '.pulseed', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const session1 = {
      id: 's1',
      goal_id: 'goal-1',
      status: 'completed',
      started_at: '2026-01-01T00:00:00Z',
    };
    const session2 = {
      id: 's2',
      goal_id: 'goal-2',
      status: 'running',
      started_at: '2026-01-02T00:00:00Z',
    };

    fs.writeFileSync(path.join(sessionsDir, 's1.json'), JSON.stringify(session1));
    fs.writeFileSync(path.join(sessionsDir, 's2.json'), JSON.stringify(session2));

    const res = await GET();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    const ids = body.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('skips non-JSON files', async () => {
    const sessionsDir = path.join(tmpDir, '.pulseed', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    fs.writeFileSync(path.join(sessionsDir, 's1.json'), JSON.stringify({ id: 's1' }));
    fs.writeFileSync(path.join(sessionsDir, 'README.txt'), 'ignore me');

    const res = await GET();
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('s1');
  });

  it('skips malformed JSON files', async () => {
    const sessionsDir = path.join(tmpDir, '.pulseed', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    fs.writeFileSync(path.join(sessionsDir, 'good.json'), JSON.stringify({ id: 'good' }));
    fs.writeFileSync(path.join(sessionsDir, 'bad.json'), 'not valid json{{{');

    const res = await GET();
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('good');
  });
});
