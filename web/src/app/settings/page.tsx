'use client';

import { useEffect, useState } from 'react';
import { usePulSeedStore } from '../../lib/store';

// ─── Types ───

interface ProviderConfig {
  provider: string;
  model: string;
  adapter: string;
  api_key?: string;
  base_url?: string;
  codex_cli_path?: string;
}

interface ProviderResponse {
  config: ProviderConfig;
  exists: boolean;
}

interface PluginInfo {
  name: string;
  version: string;
  type: string;
  description: string;
  status: 'loaded' | 'error' | 'disabled';
}

// ─── Sub-components ───

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border p-6 mb-6"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
    >
      <h2
        className="text-sm font-semibold uppercase tracking-wider mb-4"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b last:border-b-0" style={{ borderColor: 'var(--border-primary)' }}>
      <span className="w-40 shrink-0 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: 'loaded' | 'error' | 'disabled' }) {
  const colorMap = {
    loaded: 'var(--status-success)',
    error: 'var(--status-error)',
    disabled: 'var(--text-tertiary)',
  };
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full font-medium"
      style={{
        color: colorMap[status],
        background: `color-mix(in srgb, ${colorMap[status]} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${colorMap[status]} 30%, transparent)`,
      }}
    >
      {status}
    </span>
  );
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="w-2 h-2 rounded-full inline-block"
        style={{ background: connected ? 'var(--status-success)' : 'var(--status-error)' }}
      />
      <span style={{ color: connected ? 'var(--status-success)' : 'var(--status-error)' }}>
        {connected ? 'Connected' : 'Disconnected'}
      </span>
    </span>
  );
}

// ─── Sections ───

function ProviderSection() {
  const [data, setData] = useState<ProviderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/provider')
      .then((r) => r.json())
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  const cfg = data?.config;

  return (
    <SectionCard title="Provider Configuration">
      {error ? (
        <p className="text-sm" style={{ color: 'var(--status-error)' }}>Failed to load: {error}</p>
      ) : !data ? (
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : (
        <>
          {!data.exists && (
            <p className="text-xs mb-3 px-3 py-2 rounded" style={{ color: 'var(--status-warning)', background: 'color-mix(in srgb, var(--status-warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--status-warning) 25%, transparent)' }}>
              ~/.pulseed/provider.json not found — showing defaults
            </p>
          )}
          <FieldRow label="Provider" value={cfg?.provider ?? '—'} />
          <FieldRow label="Model" value={cfg?.model ?? '—'} />
          <FieldRow label="Adapter" value={cfg?.adapter ?? '—'} />
          <FieldRow label="API Key" value={cfg?.api_key ? cfg.api_key : <span style={{ color: 'var(--text-tertiary)' }}>not set</span>} />
        </>
      )}
    </SectionCard>
  );
}

function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/plugins')
      .then((r) => r.json())
      .then((d: { plugins: PluginInfo[] }) => setPlugins(d.plugins))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <SectionCard title="Plugins">
      {error ? (
        <p className="text-sm" style={{ color: 'var(--status-error)' }}>Failed to load: {error}</p>
      ) : !plugins ? (
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : plugins.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No plugins found in ~/.pulseed/plugins/
        </p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
              {['Name', 'Type', 'Version', 'Status', 'Description'].map((h) => (
                <th key={h} className="text-left py-2 pr-4 font-medium" style={{ color: 'var(--text-tertiary)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.name} style={{ borderBottom: '1px solid var(--border-primary)' }}>
                <td className="py-2 pr-4 font-mono" style={{ color: 'var(--text-primary)' }}>{p.name}</td>
                <td className="py-2 pr-4" style={{ color: 'var(--text-secondary)' }}>{p.type}</td>
                <td className="py-2 pr-4 font-mono" style={{ color: 'var(--text-tertiary)' }}>{p.version}</td>
                <td className="py-2 pr-4"><StatusBadge status={p.status} /></td>
                <td className="py-2" style={{ color: 'var(--text-secondary)' }}>{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function SystemHealthSection() {
  const connected = usePulSeedStore((s) => s.connected);

  return (
    <SectionCard title="System Health">
      <FieldRow label="Connection" value={<ConnectionDot connected={connected} />} />
      <FieldRow label="Node.js" value={typeof process !== 'undefined' ? process.version : '—'} />
      <FieldRow label="PulSeed Version" value="0.1.0" />
      <FieldRow label="Data Directory" value="~/.pulseed/" />
      <FieldRow
        label="CoreLoop Status"
        value={<span style={{ color: 'var(--text-tertiary)' }}>n/a (not running in web mode)</span>}
      />
      <FieldRow
        label="EventServer"
        value={<span style={{ color: 'var(--text-tertiary)' }}>n/a (SSE endpoint only)</span>}
      />
    </SectionCard>
  );
}

// ─── Page ───

export default function SettingsPage() {
  return (
    <div>
      <h1
        className="text-xl font-semibold mb-6"
        style={{ color: 'var(--text-primary)' }}
      >
        Settings
      </h1>
      <ProviderSection />
      <PluginsSection />
      <SystemHealthSection />
    </div>
  );
}
