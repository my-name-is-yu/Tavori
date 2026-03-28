import { describe, it, expect, vi } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      _body: data,
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

let mockSm: {
  listGoalIds: () => Promise<string[]>;
  loadGoal: (id: string) => Promise<unknown>;
};

vi.mock('../../web/src/lib/pulseed-client', () => ({
  getStateManager: () => mockSm,
}));

const { GET } = await import('../../web/src/app/api/events/route.js');

function makeAbortableRequest(): { request: Request; abort: () => void } {
  const controller = new AbortController();
  const request = new Request('http://localhost/api/events', {
    signal: controller.signal,
  });
  return { request, abort: () => controller.abort() };
}

/** Read exactly N chunks from the stream body, then cancel. */
async function readNChunks(res: Response, n: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  } finally {
    reader.cancel();
  }
  return chunks;
}

function parseEvents(chunks: string[]): Array<{ type: string; [k: string]: unknown }> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for (const chunk of chunks) {
    for (const part of chunk.split('\n\n')) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch { /* skip */ }
      }
    }
  }
  return events;
}

describe('GET /api/events (SSE)', () => {
  it('returns a Response with text/event-stream content-type', async () => {
    mockSm = { listGoalIds: async () => [], loadGoal: async () => null };
    const { request, abort } = makeAbortableRequest();
    abort();
    const res = await GET(request);

    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('sets Connection: keep-alive header', async () => {
    mockSm = { listGoalIds: async () => [], loadGoal: async () => null };
    const { request, abort } = makeAbortableRequest();
    abort();
    const res = await GET(request);
    expect(res.headers.get('Connection')).toBe('keep-alive');
  });

  it('first event in stream is connected confirmation', async () => {
    mockSm = { listGoalIds: async () => [], loadGoal: async () => null };
    const { request, abort } = makeAbortableRequest();
    const res = await GET(request);

    // Read first chunk only, then cancel
    const chunks = await readNChunks(res, 1);
    abort();

    const events = parseEvents(chunks);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('connected');
  });

  it('emits goal_updated event when goals exist', async () => {
    const sampleGoal = { id: 'goal-1', status: 'active', trust: 50, gap: 0.3 };
    mockSm = {
      listGoalIds: async () => ['goal-1'],
      loadGoal: async () => sampleGoal,
    };

    const { request, abort } = makeAbortableRequest();
    const res = await GET(request);

    // Read first 2 chunks — connected event + goal_updated events from initial poll
    const chunks = await readNChunks(res, 2);
    abort();

    const events = parseEvents(chunks);
    expect(events.some((e) => e.type === 'connected')).toBe(true);
    expect(events.some((e) => e.type === 'goal_updated')).toBe(true);
  });
});
