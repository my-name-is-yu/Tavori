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
let mockSm: {
  loadGoal: (id: string) => Promise<unknown>;
};

vi.mock('../../web/src/lib/pulseed-client', () => ({
  getStateManager: () => mockSm,
}));

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => tmpDir ?? original.homedir(),
  };
});

const { GET } = await import('../../web/src/app/api/decisions/route.js');

describe('GET /api/decisions', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-web-decisions-'));
    mockSm = {
      loadGoal: async () => null,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when decisions directory does not exist', async () => {
    const res = await GET();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('returns decisions from JSON files', async () => {
    const decisionsDir = path.join(tmpDir, '.pulseed', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    const decision = {
      id: 'd1',
      goal_id: 'goal-1',
      decision: 'PIVOT',
      timestamp: '2026-01-02T00:00:00Z',
      strategy_id: 's1',
      what_worked: ['approach A'],
      what_failed: ['approach B'],
      suggested_next: ['try C'],
    };
    fs.writeFileSync(path.join(decisionsDir, 'd1.json'), JSON.stringify(decision));

    const res = await GET();
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('d1');
    expect(body[0].decision).toBe('PIVOT');
    expect(body[0].strategy_id).toBe('s1');
    expect(body[0].what_worked).toEqual(['approach A']);
  });

  it('skips records without decision field', async () => {
    const decisionsDir = path.join(tmpDir, '.pulseed', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    const valid = { id: 'd1', goal_id: 'g1', decision: 'REFINE', timestamp: '2026-01-01T00:00:00Z' };
    const invalid = { id: 'd2', goal_id: 'g2', timestamp: '2026-01-01T00:00:00Z' }; // missing decision
    fs.writeFileSync(path.join(decisionsDir, 'd1.json'), JSON.stringify(valid));
    fs.writeFileSync(path.join(decisionsDir, 'd2.json'), JSON.stringify(invalid));

    const res = await GET();
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('d1');
  });

  it('sorts decisions by timestamp descending', async () => {
    const decisionsDir = path.join(tmpDir, '.pulseed', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    const older = { id: 'd1', goal_id: 'g1', decision: 'PIVOT', timestamp: '2026-01-01T00:00:00Z' };
    const newer = { id: 'd2', goal_id: 'g1', decision: 'REFINE', timestamp: '2026-01-03T00:00:00Z' };
    fs.writeFileSync(path.join(decisionsDir, 'd1.json'), JSON.stringify(older));
    fs.writeFileSync(path.join(decisionsDir, 'd2.json'), JSON.stringify(newer));

    const res = await GET();
    const body = await res.json();
    expect(body[0].id).toBe('d2'); // most recent first
    expect(body[1].id).toBe('d1');
  });

  it('limits to 10 decisions', async () => {
    const decisionsDir = path.join(tmpDir, '.pulseed', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    for (let i = 0; i < 15; i++) {
      const d = {
        id: `d${i}`,
        goal_id: 'g1',
        decision: 'PIVOT',
        timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      };
      fs.writeFileSync(path.join(decisionsDir, `d${i}.json`), JSON.stringify(d));
    }

    const res = await GET();
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(10);
  });

  it('resolves goal_name from state manager', async () => {
    const decisionsDir = path.join(tmpDir, '.pulseed', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    mockSm.loadGoal = async (id: string) =>
      id === 'goal-abc' ? { id: 'goal-abc', name: 'My Goal' } : null;

    const d = { id: 'd1', goal_id: 'goal-abc', decision: 'PIVOT', timestamp: '2026-01-01T00:00:00Z' };
    fs.writeFileSync(path.join(decisionsDir, 'd1.json'), JSON.stringify(d));

    const res = await GET();
    const body = await res.json();
    expect(body[0].goal_name).toBe('My Goal');
  });
});
