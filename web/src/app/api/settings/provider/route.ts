import { NextResponse } from 'next/server';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const PROVIDER_CONFIG_PATH = path.join(os.homedir(), '.motiva', 'provider.json');

function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 4) return '****';
  return key.slice(0, 4) + '****';
}

export async function GET() {
  try {
    const raw = await fsp.readFile(PROVIDER_CONFIG_PATH, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = JSON.parse(raw) as Record<string, any>;

    // Mask API keys before returning
    if (config.anthropic?.api_key) {
      config.anthropic.api_key = maskApiKey(config.anthropic.api_key);
    }
    if (config.openai?.api_key) {
      config.openai.api_key = maskApiKey(config.openai.api_key);
    }

    return NextResponse.json({ config, exists: true });
  } catch {
    // File doesn't exist or is unreadable — return defaults
    return NextResponse.json({
      config: {
        llm_provider: 'codex',
        default_adapter: 'openai_codex_cli',
      },
      exists: false,
    });
  }
}
