'use client';

import { useState, useMemo } from 'react';
import { usePulSeedStore } from '../../lib/store';
import { relativeTime } from '../../lib/format-time';
import { SkeletonTable } from '../../components/dashboard/skeleton';

// ─── Types ───

interface Session {
  id: string;
  session_type?: string;
  goal_id?: string;
  goal_name?: string;
  adapter_type?: string;
  status?: string;
  started_at?: string;
  created_at?: string;
  ended_at?: string | null;
  current_stage?: string;
  result_summary?: string | null;
  output?: string | null;
}

// ─── Constants ───

const STAGES = ['observe', 'gap', 'score', 'task', 'execute', 'verify'] as const;
type Stage = (typeof STAGES)[number];

const ALL = 'all';

const STATUS_COLORS: Record<string, string> = {
  active: 'var(--status-info)',
  running: 'var(--status-info)',
  completed: 'var(--status-success)',
  failed: 'var(--status-error)',
  stalled: 'var(--status-stalled)',
};

// ─── Sub-components ───

function StatusBadge({ status }: { status?: string }) {
  const s = status ?? 'unknown';
  const color = STATUS_COLORS[s] ?? 'var(--text-tertiary)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '12px',
        color,
        fontFamily: 'var(--font-geist-mono)',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      {s}
    </span>
  );
}

function PipelineStages({ current }: { current?: string }) {
  const activeIdx = STAGES.indexOf(current as Stage);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {STAGES.map((stage, i) => {
        const isActive = i === activeIdx;
        const isDone = activeIdx >= 0 && i < activeIdx;
        const dotColor = isActive
          ? 'var(--accent-primary)'
          : isDone
            ? 'var(--status-success)'
            : 'var(--bg-tertiary)';
        const dotBorder = isActive
          ? 'var(--accent-primary)'
          : isDone
            ? 'var(--status-success)'
            : 'var(--border-primary)';

        return (
          <div key={stage} style={{ display: 'flex', alignItems: 'center' }}>
            {/* Connector line before dot (skip for first) */}
            {i > 0 && (
              <div
                style={{
                  width: '16px',
                  height: '1px',
                  background: isDone || isActive ? 'var(--border-secondary)' : 'var(--border-primary)',
                }}
              />
            )}
            <div
              title={stage}
              style={{
                width: isActive ? '9px' : '7px',
                height: isActive ? '9px' : '7px',
                borderRadius: '50%',
                background: dotColor,
                border: `1px solid ${dotBorder}`,
                flexShrink: 0,
                transition: 'all 0.15s',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function DetailPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const startedAt = session.started_at ?? session.created_at;

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div
            style={{
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '12px',
              color: 'var(--text-primary)',
            }}
          >
            {session.id}
          </div>
          {session.goal_name && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              {session.goal_name}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: '18px',
            lineHeight: 1,
            padding: '0 4px',
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        {[
          { label: 'Type', value: session.session_type ?? '--' },
          { label: 'Adapter', value: session.adapter_type ?? '--' },
          { label: 'Started', value: startedAt ? relativeTime(startedAt) : '--' },
        ].map(({ label, value }) => (
          <div key={label}>
            <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{value}</div>
          </div>
        ))}
        <div>
          <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginBottom: '2px' }}>Status</div>
          <StatusBadge status={session.status} />
        </div>
      </div>

      {/* Pipeline progress */}
      <div>
        <div
          style={{
            fontSize: '10px',
            color: 'var(--text-tertiary)',
            marginBottom: '8px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Pipeline Stage
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <PipelineStages current={session.current_stage} />
          {session.current_stage && (
            <span
              style={{
                fontSize: '11px',
                color: 'var(--accent-primary)',
                fontFamily: 'var(--font-geist-mono)',
              }}
            >
              {session.current_stage}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: '8px',
            marginTop: '6px',
            flexWrap: 'wrap',
          }}
        >
          {(() => {
            const activeIdx = STAGES.indexOf(session.current_stage as Stage);
            return STAGES.map((stage) => {
              const stageIdx = STAGES.indexOf(stage);
              const isActive = stage === session.current_stage;
              const isDone = activeIdx >= 0 && stageIdx < activeIdx;
              return (
                <span
                  key={stage}
                  style={{
                    fontSize: '10px',
                    color: isActive
                      ? 'var(--accent-primary)'
                      : isDone
                        ? 'var(--status-success)'
                        : 'var(--text-tertiary)',
                    fontFamily: 'var(--font-geist-mono)',
                  }}
                >
                  {stage}
                </span>
              );
            });
          })()}
        </div>
      </div>

      {/* Result summary */}
      {session.result_summary && (
        <div>
          <div
            style={{
              fontSize: '10px',
              color: 'var(--text-tertiary)',
              marginBottom: '4px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Result
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
            {session.result_summary}
          </p>
        </div>
      )}

      {/* Output area */}
      <div>
        <div
          style={{
            fontSize: '10px',
            color: 'var(--text-tertiary)',
            marginBottom: '4px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Output
        </div>
        <div
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)',
            padding: '10px',
            minHeight: '80px',
            maxHeight: '200px',
            overflowY: 'auto',
          }}
        >
          <pre
            style={{
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '11px',
              color: 'var(--text-secondary)',
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {session.output ?? '(no output)'}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─── Filter Bar ───

const headerStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  fontWeight: 400,
  padding: '8px 0',
  borderBottom: '1px solid var(--border-primary)',
};

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-primary)',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  padding: '4px 8px',
  cursor: 'pointer',
  outline: 'none',
};

// ─── Main Page ───

export default function SessionsPage() {
  const rawSessions = usePulSeedStore((state) => state.sessions);
  const lastUpdate = usePulSeedStore((state) => state.lastUpdate);
  const sessions: Session[] = rawSessions as unknown as Session[];
  const loading = lastUpdate === null && sessions.length === 0;

  const [statusFilter, setStatusFilter] = useState(ALL);
  const [adapterFilter, setAdapterFilter] = useState(ALL);
  const [roleFilter, setRoleFilter] = useState(ALL);
  const [selected, setSelected] = useState<Session | null>(null);

  // Derive unique filter options
  const adapters = useMemo(() => {
    const set = new Set(sessions.map((s) => s.adapter_type).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [sessions]);

  const roles = useMemo(() => {
    const set = new Set(sessions.map((s) => s.session_type).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [sessions]);

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (statusFilter !== ALL && s.status !== statusFilter) return false;
      if (adapterFilter !== ALL && s.adapter_type !== adapterFilter) return false;
      if (roleFilter !== ALL && s.session_type !== roleFilter) return false;
      return true;
    });
  }, [sessions, statusFilter, adapterFilter, roleFilter]);

  const startedAt = (s: Session) => s.started_at ?? s.created_at ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Page header */}
      <h1
        className="font-[family-name:var(--font-geist-sans)]"
        style={{
          fontSize: '20px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: 0,
        }}
      >
        Agent Sessions
      </h1>

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Filter:</span>

        <select style={selectStyle} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value={ALL}>All Status</option>
          {['active', 'running', 'completed', 'failed', 'stalled'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select style={selectStyle} value={adapterFilter} onChange={(e) => setAdapterFilter(e.target.value)}>
          <option value={ALL}>All Adapters</option>
          {adapters.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <select style={selectStyle} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value={ALL}>All Roles</option>
          {roles.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginLeft: '4px' }}>
          {filtered.length} session{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Main layout: table + detail panel */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: selected ? '1fr 360px' : '1fr',
          gap: '16px',
          alignItems: 'start',
        }}
      >
        {/* Session table */}
        <div>
          {loading ? (
            <SkeletonTable rows={5} cols={6} />
          ) : filtered.length === 0 ? (
            <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>No sessions found</p>
          ) : (
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Session ID', 'Goal', 'Adapter', 'Role', 'Status', 'Time'].map((h) => (
                    <th key={h} className="text-left" style={headerStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const isSelected = selected?.id === s.id;
                  return (
                    <tr
                      key={s.id}
                      onClick={() => setSelected(isSelected ? null : s)}
                      style={{
                        borderBottom: '1px solid var(--border-primary)',
                        background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <td className="py-2" style={{ paddingRight: '16px' }}>
                        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text-primary)' }}>
                          {s.id.length > 12 ? s.id.slice(0, 8) + '…' : s.id}
                        </span>
                      </td>
                      <td className="py-2" style={{ paddingRight: '16px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                          {s.goal_name ?? s.goal_id?.slice(0, 10) ?? '--'}
                        </span>
                      </td>
                      <td className="py-2" style={{ paddingRight: '16px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{s.adapter_type ?? '--'}</span>
                      </td>
                      <td className="py-2" style={{ paddingRight: '16px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{s.session_type ?? '--'}</span>
                      </td>
                      <td className="py-2" style={{ paddingRight: '16px' }}>
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="py-2">
                        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                          {startedAt(s) ? relativeTime(startedAt(s)) : '--'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <DetailPanel session={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
