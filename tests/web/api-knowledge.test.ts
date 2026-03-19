import { describe, it, expect, vi } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      _body: data,
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
  NextRequest: class {},
}));

const { GET: getTransfers } = await import('../../web/src/app/api/knowledge/transfers/route.js');
const { POST: postSearch } = await import('../../web/src/app/api/knowledge/search/route.js');

describe('GET /api/knowledge/transfers', () => {
  it('returns transfers array (placeholder)', async () => {
    const res = await getTransfers();
    const body = await res.json();
    expect(Array.isArray(body.transfers)).toBe(true);
    expect(body.transfers).toHaveLength(0);
    expect(typeof body.message).toBe('string');
  });

  it('has status 200', async () => {
    const res = await getTransfers();
    expect(res.status).toBe(200);
  });
});

describe('POST /api/knowledge/search', () => {
  function makeRequest(body: unknown) {
    return {
      json: async () => body,
    } as import('next/server').NextRequest;
  }

  it('returns search results (placeholder) with query', async () => {
    const res = await postSearch(makeRequest({ query: 'test query', topK: 3 }));
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.message).toContain('test query');
    expect(body.message).toContain('topK=3');
  });

  it('uses default topK=5 when not specified', async () => {
    const res = await postSearch(makeRequest({ query: 'my query' }));
    const body = await res.json();
    expect(body.message).toContain('topK=5');
  });

  it('returns 400 when query is missing', async () => {
    const res = await postSearch(makeRequest({ topK: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('query');
  });

  it('returns 400 when query is not a string', async () => {
    const res = await postSearch(makeRequest({ query: 42 }));
    expect(res.status).toBe(400);
  });
});
