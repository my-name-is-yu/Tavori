import { NextResponse } from 'next/server';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const PLUGINS_DIR = path.join(os.homedir(), '.pulseed', 'plugins');

interface PluginInfo {
  name: string;
  version: string;
  type: string;
  description: string;
  status: 'loaded' | 'error' | 'disabled';
}

async function readPluginManifest(pluginDir: string): Promise<PluginInfo | null> {
  // Try plugin.json then plugin.yaml (yaml parsing skipped — read raw json only for simplicity)
  const jsonPath = path.join(pluginDir, 'plugin.json');
  try {
    const raw = await fsp.readFile(jsonPath, 'utf-8');
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: String(manifest.name ?? path.basename(pluginDir)),
      version: String(manifest.version ?? '0.0.0'),
      type: String(manifest.type ?? 'unknown'),
      description: String(manifest.description ?? ''),
      status: 'loaded',
    };
  } catch {
    return {
      name: path.basename(pluginDir),
      version: '—',
      type: 'unknown',
      description: 'Manifest unreadable',
      status: 'error',
    };
  }
}

export async function GET() {
  try {
    const entries = await fsp.readdir(PLUGINS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(PLUGINS_DIR, e.name));

    const plugins = await Promise.all(dirs.map(readPluginManifest));
    return NextResponse.json({ plugins: plugins.filter(Boolean) });
  } catch {
    // Plugins directory doesn't exist
    return NextResponse.json({ plugins: [] });
  }
}
