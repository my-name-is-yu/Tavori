'use client';

import { usePulSeedStore } from '../lib/store';
import { GoalTable, type GoalRow } from '../components/dashboard/goal-table';
import { ActiveSessions } from '../components/dashboard/active-sessions';
import { DecisionTimeline } from '../components/dashboard/decision-timeline';

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? 'Connected' : 'Disconnected'}
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: connected ? 'var(--status-success)' : 'var(--status-error)',
        flexShrink: 0,
      }}
    />
  );
}

export default function DashboardPage() {
  const goals = usePulSeedStore((state) => state.goals) as GoalRow[];
  const connected = usePulSeedStore((state) => state.connected);
  const lastUpdate = usePulSeedStore((state) => state.lastUpdate);

  const lastUpdatedText = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString()
    : null;

  return (
    <div className="space-y-8">
      {/* Header row with title + connection status */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1
          className="font-[family-name:var(--font-geist-sans)]"
          style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}
        >
          Dashboard
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ConnectionDot connected={connected} />
          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-geist-mono)' }}>
            {connected ? 'live' : 'offline'}
          </span>
          {lastUpdatedText && (
            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              · updated {lastUpdatedText}
            </span>
          )}
        </div>
      </div>

      {/* Upper: Goal overview table */}
      <section>
        <GoalTable goals={goals} loading={false} />
      </section>

      {/* Middle: Active sessions */}
      <ActiveSessions />

      {/* Lower: Decision timeline */}
      <DecisionTimeline />
    </div>
  );
}
