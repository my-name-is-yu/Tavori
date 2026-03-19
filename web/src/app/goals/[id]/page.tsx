'use client';

import { use } from 'react';
import Link from 'next/link';
import { CheckCircle2, AlertCircle, XCircle, ArrowLeft, GitBranch, RefreshCw } from 'lucide-react';
import { useFetch } from '../../../lib/use-fetch';
import { relativeTime } from '../../../lib/format-time';
import { GapHistoryChart, TrustChart } from '../../../components/goals/goal-charts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Dimension {
  name: string;
  current_value?: number;
  threshold?: { type: string; value: number };
}

interface Goal {
  id: string;
  name?: string;
  dimensions?: Dimension[];
  status?: string;
  trust_score?: number | null;
  strategy_state?: string | null;
  constraints?: string[];
  created_at?: string;
  updated_at?: string;
}

interface GapEntry {
  timestamp: string;
  gap_score?: number;
  trust_score?: number;
}

interface Strategy {
  id?: string;
  strategy_type?: string;
  created_at?: string;
  description?: string;
  pivot_reason?: string;
}

interface Task {
  id: string;
  work_description?: string;
  outcome?: string;
  created_at?: string;
  completed_at?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeGapPct(dimensions?: Dimension[]): number | null {
  if (!dimensions || dimensions.length === 0) return null;
  const gaps = dimensions.map((d) => {
    const type = d.threshold?.type;
    if (type === 'present' || type === 'match') {
      // Binary: gap is 0 (met) or 1 (not met)
      const cur = d.current_value ?? 0;
      const tgt = d.threshold?.value ?? 1;
      return cur === tgt ? 0 : 1;
    }
    const cur = d.current_value ?? 0;
    const tgt = d.threshold?.value ?? 1;
    if (tgt === 0) return Math.min(1, Math.abs(cur));
    return Math.max(0, Math.min(1, Math.abs(tgt - cur) / Math.abs(tgt)));
  });
  return Math.max(...gaps);
}

function gapColor(pct: number): string {
  if (pct <= 0.3) return 'var(--status-success)';
  if (pct <= 0.6) return 'var(--accent-primary)';
  return 'var(--status-error)';
}

function trustColor(score: number | null | undefined): string {
  if (score == null) return 'var(--text-tertiary)';
  if (score < 0) return 'var(--trust-negative)';
  if (score <= 20) return 'var(--trust-neutral)';
  return 'var(--trust-positive)';
}

function OutcomeIcon({ outcome }: { outcome?: string }) {
  if (outcome === 'success') return <CheckCircle2 size={14} color="var(--status-success)" />;
  if (outcome === 'partial') return <AlertCircle size={14} color="var(--status-warning)" />;
  if (outcome === 'fail') return <XCircle size={14} color="var(--status-error)" />;
  return <span style={{ width: 14, height: 14, display: 'inline-block' }} />;
}

function StrategyBadge({ type }: { type?: string }) {
  const isPivot = type === 'pivot';
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm"
      style={{
        background: isPivot ? 'var(--accent-muted)' : 'var(--bg-tertiary)',
        color: isPivot ? 'var(--accent-primary)' : 'var(--text-secondary)',
        border: `1px solid ${isPivot ? 'var(--accent-secondary)' : 'var(--border-primary)'}`,
        fontSize: '11px',
        fontFamily: 'var(--font-geist-mono)',
      }}
    >
      {isPivot ? <GitBranch size={10} /> : <RefreshCw size={10} />}
      {type ? type.toUpperCase() : 'UNKNOWN'}
    </span>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text-tertiary)',
  marginBottom: '12px',
};

const divider: React.CSSProperties = {
  borderTop: '1px solid var(--border-primary)',
  marginTop: '24px',
  paddingTop: '24px',
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const { data: goal, loading: goalLoading, error: goalError } = useFetch<Goal>(`/api/goals/${id}`);
  const { data: historyRaw } = useFetch<GapEntry[]>(`/api/goals/${id}/gap-history`);
  const { data: strategiesRaw } = useFetch<{ strategies: Strategy[] }>(`/api/strategies/${id}`);
  const { data: tasksRaw } = useFetch<{ tasks: Task[] }>(`/api/goals/${id}/tasks`);

  const gapHistory: GapEntry[] = Array.isArray(historyRaw) ? historyRaw : [];
  const strategies: Strategy[] = strategiesRaw?.strategies ?? [];
  const tasks: Task[] = tasksRaw?.tasks ?? [];

  const chartData = gapHistory.map((e) => ({
    t: new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    gap: typeof e.gap_score === 'number' ? +(e.gap_score * 100).toFixed(1) : null,
    trust: e.trust_score ?? null,
  }));

  const gap = goal ? computeGapPct(goal.dimensions) : null;
  const gapPct = gap != null ? Math.round(gap * 100) : null;
  const thresholdType = goal?.dimensions?.[0]?.threshold?.type ?? null;

  if (goalLoading) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: '13px', paddingTop: '24px' }}>
        Loading…
      </div>
    );
  }

  if (goalError) {
    return (
      <div style={{ color: 'var(--status-error)', fontSize: '13px', paddingTop: '24px' }}>
        Failed to load goal: {goalError}{' '}
        <Link href="/goals" style={{ color: 'var(--accent-primary)' }}>
          Back to Goals
        </Link>
      </div>
    );
  }

  if (!goal) {
    return (
      <div style={{ color: 'var(--status-error)', fontSize: '13px', paddingTop: '24px' }}>
        Goal not found.{' '}
        <Link href="/goals" style={{ color: 'var(--accent-primary)' }}>
          Back to Goals
        </Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1200px' }}>
      {/* Back link */}
      <Link
        href="/goals"
        className="inline-flex items-center gap-1.5 mb-6"
        style={{ color: 'var(--text-tertiary)', fontSize: '12px', textDecoration: 'none' }}
      >
        <ArrowLeft size={12} />
        Goals
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1
            className="font-[family-name:var(--font-geist-sans)]"
            style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}
          >
            {goal.name || goal.id}
          </h1>
          <div className="flex items-center gap-3">
            {thresholdType && (
              <span
                className="font-mono text-xs px-2 py-0.5 rounded-sm"
                style={{
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-primary)',
                  color: 'var(--text-secondary)',
                }}
              >
                {thresholdType}
              </span>
            )}
            <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>
              {relativeTime(goal.updated_at || goal.created_at || '')}
            </span>
          </div>
        </div>

        {/* Large Gap % */}
        {gapPct != null && (
          <div className="text-right">
            <div
              className="font-[family-name:var(--font-geist-mono)]"
              style={{ fontSize: '48px', fontWeight: 700, lineHeight: 1, color: gapColor(gap ?? 0) }}
            >
              {gapPct}%
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>Gap</div>
          </div>
        )}
      </div>

      {/* Body: 70/30 split */}
      <div className="flex gap-8">
        {/* Left 70% */}
        <div style={{ flex: '0 0 70%', minWidth: 0 }}>
          <div>
            <div style={sectionLabel}>Gap History (30 days)</div>
            <GapHistoryChart data={chartData} />
          </div>

          <div style={divider}>
            <div style={sectionLabel}>Trust Progression</div>
            <TrustChart data={chartData} />
          </div>

          <div style={divider}>
            <div style={sectionLabel}>Tasks ({tasks.length})</div>
            {tasks.length === 0 ? (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>No tasks</p>
            ) : (
              <div>
                {tasks.length > 20 && (
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
                    Showing 20 of {tasks.length}
                  </div>
                )}
                {tasks.slice(0, 20).map((t) => (
                  <div
                    key={t.id}
                    className="flex items-start gap-2 py-2"
                    style={{ borderBottom: '1px solid var(--border-primary)' }}
                  >
                    <div style={{ marginTop: '1px', flexShrink: 0 }}>
                      <OutcomeIcon outcome={t.outcome} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '13px',
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t.work_description?.split('\n')[0] || t.id}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                        {relativeTime(t.completed_at || t.created_at || '')}
                      </div>
                    </div>
                    {t.outcome && (
                      <span
                        style={{
                          fontSize: '11px',
                          flexShrink: 0,
                          color:
                            t.outcome === 'success' ? 'var(--status-success)'
                            : t.outcome === 'partial' ? 'var(--status-warning)'
                            : 'var(--status-error)',
                        }}
                      >
                        {t.outcome}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right 30% */}
        <div style={{ flex: '0 0 30%', minWidth: 0 }}>
          <div>
            <div style={sectionLabel}>Strategy History</div>
            {strategies.length === 0 ? (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>No strategies</p>
            ) : (
              <div>
                {strategies.map((s, i) => (
                  <div
                    key={s.id || i}
                    className="flex items-start gap-3 py-2.5"
                    style={{ borderBottom: '1px solid var(--border-primary)' }}
                  >
                    <div style={{ marginTop: '1px' }}>
                      <StrategyBadge type={s.strategy_type} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {s.description && (
                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {s.description}
                        </div>
                      )}
                      {s.pivot_reason && (
                        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                          {s.pivot_reason}
                        </div>
                      )}
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                        {relativeTime(s.created_at || '')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={divider}>
            <div style={sectionLabel}>Knowledge Transfer</div>
            <p style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>Integration pending (M18.5)</p>
          </div>

          <div style={divider}>
            <div style={sectionLabel}>Constraints</div>
            {!goal.constraints || goal.constraints.length === 0 ? (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>No constraints</p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {goal.constraints.map((c, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                      padding: '4px 0',
                      borderBottom: '1px solid var(--border-primary)',
                    }}
                  >
                    <span style={{ color: 'var(--text-tertiary)', marginRight: '6px' }}>—</span>
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={divider}>
            <div style={sectionLabel}>Meta</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '3px' }}>Trust</div>
                <div
                  className="font-[family-name:var(--font-geist-mono)]"
                  style={{ fontSize: '20px', fontWeight: 700, color: trustColor(goal.trust_score) }}
                >
                  {goal.trust_score != null
                    ? goal.trust_score >= 0 ? `+${goal.trust_score}` : String(goal.trust_score)
                    : '--'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '3px' }}>Status</div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  {goal.status || '--'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
