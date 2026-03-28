import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      _body: data,
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

// The route modules compute PROVIDER_CONFIG_PATH and PLUGINS_DIR at load time
// using os.homedir(). We can't redirect that after import. Instead we intercept
// node:fs/promises to control what gets read/listed.

type DirentLike = { isDirectory: () => boolean; name: string };

let fsMockReadFile: ((p: string, enc: string) => Promise<string>) | null = null;
let fsMockReaddir: ((p: string, opts?: unknown) => Promise<string[] | DirentLike[]>) | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: async (p: unknown, enc: unknown) => {
      if (fsMockReadFile) return fsMockReadFile(p as string, enc as string);
      return original.readFile(p as Parameters<typeof original.readFile>[0], enc as BufferEncoding);
    },
    readdir: async (p: unknown, opts?: unknown) => {
      if (fsMockReaddir) return fsMockReaddir(p as string, opts);
      return original.readdir(p as Parameters<typeof original.readdir>[0], opts as never);
    },
  };
});

const { GET: getProvider } = await import('../../web/src/app/api/settings/provider/route.js');
const { GET: getPlugins } = await import('../../web/src/app/api/settings/plugins/route.js');

// Helper to build a fake plugin directory path (must match what the route uses)
// The route uses path.join(os.homedir(), '.pulseed', 'plugins') — we can't change
// that path, so we mock readdir/readFile instead.

describe('GET /api/settings/provider', () => {
  afterEach(() => {
    fsMockReadFile = null;
    fsMockReaddir = null;
  });

  it('returns defaults when provider.json does not exist', async () => {
    fsMockReadFile = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const res = await getProvider();
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.config.provider).toBe('openai');
    expect(body.config.adapter).toBe('openai_codex_cli');
  });

  it('returns masked API key from provider.json (new flat format)', async () => {
    const config = {
      provider: 'openai',
      model: 'gpt-5.4-mini',
      adapter: 'openai_codex_cli',
      api_key: 'sk-openai-secret67890',
    };
    fsMockReadFile = async () => JSON.stringify(config);
    const res = await getProvider();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.config.api_key).toBe('sk-o****');
    expect(body.config.api_key).not.toContain('secret');
  });

  it('masks short keys (<=4 chars) as ****', async () => {
    const config = { provider: 'openai', model: 'gpt-5.4-mini', adapter: 'openai_api', api_key: 'abc' };
    fsMockReadFile = async () => JSON.stringify(config);
    const res = await getProvider();
    const body = await res.json();
    expect(body.config.api_key).toBe('****');
  });

  it('returns config without masking when no API key present', async () => {
    const config = { provider: 'openai', model: 'gpt-5.4-mini', adapter: 'openai_codex_cli' };
    fsMockReadFile = async () => JSON.stringify(config);
    const res = await getProvider();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.config.provider).toBe('openai');
  });

  it('masks legacy nested API keys for backward compat', async () => {
    const config = {
      provider: 'anthropic',
      anthropic: { api_key: 'sk-ant-secret12345' },
    };
    fsMockReadFile = async () => JSON.stringify(config);
    const res = await getProvider();
    const body = await res.json();
    expect(body.config.anthropic.api_key).toBe('sk-a****');
  });
});

describe('GET /api/settings/plugins', () => {
  afterEach(() => {
    fsMockReadFile = null;
    fsMockReaddir = null;
  });

  it('returns empty array when plugins directory does not exist', async () => {
    fsMockReaddir = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const res = await getPlugins();
    const body = await res.json();
    expect(body.plugins).toEqual([]);
  });

  it('returns plugins from subdirectories with plugin.json manifests', async () => {
    const pluginsDir = path.join(process.env.HOME ?? '/tmp', '.pulseed', 'plugins');
    const slackDir = path.join(pluginsDir, 'slack-notifier');

    const manifest = {
      name: 'slack-notifier',
      version: '1.0.0',
      type: 'notifier',
      description: 'Sends notifications to Slack',
    };

    fsMockReaddir = async () => ([
      { isDirectory: () => true, name: 'slack-notifier' } as DirentLike,
    ]);
    fsMockReadFile = async (p: string) => {
      if (p === path.join(slackDir, 'plugin.json')) {
        return JSON.stringify(manifest);
      }
      throw new Error(`Unexpected readFile: ${p}`);
    };

    const res = await getPlugins();
    const body = await res.json();
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0].name).toBe('slack-notifier');
    expect(body.plugins[0].version).toBe('1.0.0');
    expect(body.plugins[0].type).toBe('notifier');
    expect(body.plugins[0].status).toBe('loaded');
  });

  it('returns error status for plugins without readable manifest', async () => {
    fsMockReaddir = async () => ([
      { isDirectory: () => true, name: 'broken-plugin' } as DirentLike,
    ]);
    fsMockReadFile = async () => { throw new Error('ENOENT'); };

    const res = await getPlugins();
    const body = await res.json();
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0].status).toBe('error');
    expect(body.plugins[0].name).toBe('broken-plugin');
  });
});
