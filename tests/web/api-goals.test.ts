import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// --- Mock next/server before any imports that depend on it ---
vi.mock('next/server', () => {
  return {
    NextResponse: {
      json: (data: unknown, init?: { status?: number }) => ({
        _body: data,
        status: init?.status ?? 200,
        json: async () => data,
      }),
    },
    NextRequest: class {},
  };
});

// Mock pulseed-client with a factory so we can swap the impl per test
let mockSm: {
  listGoalIds: () => Promise<string[]>;
  loadGoal: (id: string) => Promise<unknown>;
  loadGapHistory: (id: string) => Promise<unknown[]>;
};

vi.mock('../../web/src/lib/pulseed-client', () => ({
  getStateManager: () => mockSm,
}));

// Import route handlers AFTER mocks are set up
const { GET: getGoals } = await import('../../web/src/app/api/goals/route.js');
const { GET: getGoalById } = await import('../../web/src/app/api/goals/[id]/route.js');
const { GET: getGapHistory } = await import('../../web/src/app/api/goals/[id]/gap-history/route.js');

// tasks route uses homedir() directly — mock os module
let tmpDir: string;

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => tmpDir ?? original.homedir(),
  };
});

const { GET: getTasks } = await import('../../web/src/app/api/goals/[id]/tasks/route.js');

const sampleGoal = {
  id: 'goal-1',
  title: 'Test Goal',
  status: 'active',
  dimensions: [],
};

const sampleGapHistory = [
  { timestamp: '2026-01-01T00:00:00Z', gap: 0.4, goal_id: 'goal-1' },
  { timestamp: '2026-01-02T00:00:00Z', gap: 0.3, goal_id: 'goal-1' },
];

function makeRequest(id: string) {
  return {
    params: Promise.resolve({ id }),
  } as Parameters<typeof getGoalById>[1];
}

describe('GET /api/goals', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-web-goals-'));
    mockSm = {
      listGoalIds: async () => ['goal-1'],
      loadGoal: async (id: string) => (id === 'goal-1' ? sampleGoal : null),
      loadGapHistory: async () => sampleGapHistory,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns array of goals', async () => {
    const res = await getGoals();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('goal-1');
  });

  it('filters out null goals', async () => {
    mockSm.listGoalIds = async () => ['goal-1', 'missing'];
    mockSm.loadGoal = async (id: string) => (id === 'goal-1' ? sampleGoal : null);
    const res = await getGoals();
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it('returns 500 on unexpected error', async () => {
    mockSm.listGoalIds = async () => { throw new Error('disk error'); };
    const res = await getGoals();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe('GET /api/goals/:id', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-web-goals-'));
    mockSm = {
      listGoalIds: async () => ['goal-1'],
      loadGoal: async (id: string) => (id === 'goal-1' ? sampleGoal : null),
      loadGapHistory: async () => sampleGapHistory,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a single goal by id', async () => {
    const res = await getGoalById({} as never, makeRequest('goal-1'));
    const body = await res.json();
    expect(body.id).toBe('goal-1');
    expect(body.title).toBe('Test Goal');
  });

  it('returns 404 for missing goal', async () => {
    const res = await getGoalById({} as never, makeRequest('nonexistent'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found');
  });
});

describe('GET /api/goals/:id/gap-history', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-web-goals-'));
    mockSm = {
      listGoalIds: async () => ['goal-1'],
      loadGoal: async () => sampleGoal,
      loadGapHistory: async () => sampleGapHistory,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns gap history array', async () => {
    const res = await getGapHistory({} as never, makeRequest('goal-1'));
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].gap).toBe(0.4);
  });
});

describe('GET /api/goals/:id/tasks', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-web-goals-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty tasks when directory does not exist', async () => {
    const res = await getTasks({} as never, makeRequest('goal-1'));
    const body = await res.json();
    expect(body.tasks).toEqual([]);
  });

  it('returns tasks from JSON files sorted by created_at desc', async () => {
    const tasksDir = path.join(tmpDir, '.pulseed', 'tasks', 'goal-1');
    fs.mkdirSync(tasksDir, { recursive: true });
    const task1 = { id: 't1', created_at: '2026-01-01T00:00:00Z', description: 'older' };
    const task2 = { id: 't2', created_at: '2026-01-03T00:00:00Z', description: 'newer' };
    fs.writeFileSync(path.join(tasksDir, 't1.json'), JSON.stringify(task1));
    fs.writeFileSync(path.join(tasksDir, 't2.json'), JSON.stringify(task2));

    const res = await getTasks({} as never, makeRequest('goal-1'));
    const body = await res.json();
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].id).toBe('t2'); // most recent first
    expect(body.tasks[1].id).toBe('t1');
  });
});
