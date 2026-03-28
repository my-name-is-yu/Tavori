'use client';

import React, { useEffect, useState } from 'react';
import { usePulSeedStore } from '../../lib/store';

// ─── Types ───

interface LearnedPattern {
  pattern_id: string;
  type: string;
  description: string;
  confidence: number;
  evidence_count: number;
  applicable_domains: string[];
  last_applied_at: string | null;
}

interface TransferCandidate {
  candidate_id: string;
  source_goal_id: string;
  target_goal_id: string;
  type: string;
  similarity_score: number;
  estimated_benefit: string;
  state: string;
  effectiveness_score: number | null;
}

interface DecisionRecord {
  id: string;
  goal_id: string;
  goal_name?: string;
  decision: string;
  timestamp: string;
  what_worked?: string[];
  what_failed?: string[];
  suggested_next?: string[];
}

// ─── Sub-components ───

const thStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  fontWeight: 400,
  padding: '8px 12px 8px 0',
  borderBottom: '1px solid var(--border-primary)',
  textAlign: 'left',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px 10px 0',
  borderBottom: '1px solid var(--border-primary)',
  verticalAlign: 'top',
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 16px 0', paddingBottom: '8px', borderBottom: '1px solid var(--border-primary)' }}>{children}</h2>;
}

function EmptyState({ message }: { message: string }) {
  return <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', margin: '12px 0' }}>{message}</p>;
}

function DomainBadge({ tag }: { tag: string }) {
  return <span style={{ display: 'inline-block', fontSize: '10px', color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', padding: '1px 6px', marginRight: '4px', marginBottom: '2px', fontFamily: 'var(--font-geist-mono)' }}>{tag}</span>;
}

function DecisionTypeBadge({ type }: { type: string }) {
  const isPivot = type === 'PIVOT';
  return (
    <span style={{ display: 'inline-block', fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-geist-mono)', letterSpacing: '0.04em', padding: '1px 7px', color: isPivot ? 'var(--accent-primary)' : '#60a5fa', background: isPivot ? 'var(--accent-muted)' : '#1e3a5f', border: `1px solid ${isPivot ? 'var(--accent-secondary)' : '#2563eb'}` }}>
      {type}
    </span>
  );
}

function BarCell({ value, color }: { value: number; color: string }) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '100px' }}>
      <div
        style={{
          flex: 1,
          height: '4px',
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
          }}
        />
      </div>
      <span
        style={{
          fontFamily: 'var(--font-geist-mono)',
          fontSize: '11px',
          color: 'var(--text-secondary)',
          minWidth: '28px',
        }}
      >
        {pct}%
      </span>
    </div>
  );
}

const STATE_COLORS: Record<string, string> = { applied: 'var(--status-success)', proposed: 'var(--accent-primary)', pending: 'var(--text-tertiary)', rejected: 'var(--status-error)', invalidated: 'var(--text-tertiary)' };

function StateBadge({ state }: { state: string }) {
  const color = STATE_COLORS[state] ?? 'var(--text-tertiary)';
  return (
    <span style={{ fontSize: '11px', color, fontFamily: 'var(--font-geist-mono)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: color, flexShrink: 0 }} />
      {state}
    </span>
  );
}

// ─── Section 1: Meta Patterns ───

function MetaPatternsSection() {
  const [patterns, setPatterns] = useState<LearnedPattern[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/knowledge/patterns')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.patterns)) setPatterns(data.patterns);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <SectionHeading>Meta Patterns</SectionHeading>
      {loading ? (
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : patterns.length === 0 ? (
        <EmptyState message="No patterns recorded yet" />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Pattern', 'Domain Tags', 'Applications', 'Confidence'].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.pattern_id}>
                <td style={{ ...tdStyle, maxWidth: '300px' }}>
                  <div
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-primary)',
                      marginBottom: '2px',
                      fontFamily: 'var(--font-geist-mono)',
                    }}
                  >
                    {p.type}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {p.description}
                  </div>
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                    {p.applicable_domains.length > 0
                      ? p.applicable_domains.map((d) => <DomainBadge key={d} tag={d} />)
                      : <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>—</span>
                    }
                  </div>
                </td>
                <td style={tdStyle}>
                  <span
                    style={{
                      fontFamily: 'var(--font-geist-mono)',
                      fontSize: '12px',
                      color: p.evidence_count > 0 ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    {p.evidence_count}
                  </span>
                </td>
                <td style={{ ...tdStyle, minWidth: '140px' }}>
                  <BarCell
                    value={p.confidence}
                    color={
                      p.confidence >= 0.7
                        ? 'var(--status-success)'
                        : p.confidence >= 0.4
                          ? 'var(--accent-primary)'
                          : 'var(--status-error)'
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── Section 2: Decision Records ───

function DecisionRecordsSection() {
  const storeDecisions = usePulSeedStore((state) => state.decisions) as unknown as DecisionRecord[];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <section>
      <SectionHeading>Decision Records</SectionHeading>
      {storeDecisions.length === 0 ? (
        <EmptyState message="No decisions recorded yet" />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Date', 'Goal', 'Type', 'What Worked', 'What Failed'].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {storeDecisions.map((d) => {
              const isOpen = expanded.has(d.id);
              const date = d.timestamp
                ? new Date(d.timestamp).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '—';
              const hasSuggestedNext =
                Array.isArray(d.suggested_next) && d.suggested_next.length > 0;

              return (
                <React.Fragment key={d.id}>
                  <tr
                    onClick={() => hasSuggestedNext && toggle(d.id)}
                    style={{
                      borderBottom: isOpen ? 'none' : '1px solid var(--border-primary)',
                      cursor: hasSuggestedNext ? 'pointer' : 'default',
                      background: isOpen ? 'var(--bg-tertiary)' : 'transparent',
                    }}
                  >
                    <td style={{ ...tdStyle, borderBottom: 'none', whiteSpace: 'nowrap' }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-geist-mono)',
                          fontSize: '11px',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        {date}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, borderBottom: 'none', maxWidth: '180px' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {d.goal_name ?? d.goal_id?.slice(0, 12) ?? '—'}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, borderBottom: 'none' }}>
                      <DecisionTypeBadge type={d.decision} />
                    </td>
                    <td style={{ ...tdStyle, borderBottom: 'none', maxWidth: '200px' }}>
                      {Array.isArray(d.what_worked) && d.what_worked.length > 0 ? (
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                          {d.what_worked.map((w, i) => (
                            <li
                              key={i}
                              style={{ fontSize: '11px', color: 'var(--status-success)', marginBottom: '2px' }}
                            >
                              + {w}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, borderBottom: 'none', maxWidth: '200px' }}>
                      {Array.isArray(d.what_failed) && d.what_failed.length > 0 ? (
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                          {d.what_failed.map((w, i) => (
                            <li
                              key={i}
                              style={{ fontSize: '11px', color: 'var(--status-error)', marginBottom: '2px' }}
                            >
                              - {w}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && hasSuggestedNext && (
                    <tr
                      key={`${d.id}-next`}
                      style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)' }}
                    >
                      <td colSpan={5} style={{ padding: '6px 0 10px 0' }}>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingLeft: '0' }}>
                          <span
                            style={{ fontSize: '10px', color: 'var(--text-tertiary)', paddingTop: '1px' }}
                          >
                            Suggested next:
                          </span>
                          {d.suggested_next!.map((s, i) => (
                            <span
                              key={i}
                              style={{
                                fontSize: '11px',
                                color: 'var(--text-secondary)',
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border-primary)',
                                padding: '1px 8px',
                              }}
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── Section 3: Transfer Candidates ───

function TransferCandidatesSection() {
  const [candidates, setCandidates] = useState<TransferCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/knowledge/transfers')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.transfers)) setCandidates(data.transfers);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <SectionHeading>Transfer Candidates</SectionHeading>
      {loading ? (
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Loading…</p>
      ) : candidates.length === 0 ? (
        <EmptyState message="No transfer candidates detected yet" />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Source → Target', 'Type', 'Score', 'Status', 'Effectiveness'].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.candidate_id}>
                <td style={{ ...tdStyle, maxWidth: '240px' }}>
                  <div
                    style={{
                      fontFamily: 'var(--font-geist-mono)',
                      fontSize: '11px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>
                      {c.source_goal_id.slice(0, 12)}
                    </span>
                    <span style={{ color: 'var(--text-tertiary)', margin: '0 6px' }}>→</span>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {c.target_goal_id.slice(0, 12)}
                    </span>
                  </div>
                  {c.estimated_benefit && (
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--text-tertiary)',
                        marginTop: '3px',
                      }}
                    >
                      {c.estimated_benefit}
                    </div>
                  )}
                </td>
                <td style={tdStyle}>
                  <span
                    style={{
                      fontFamily: 'var(--font-geist-mono)',
                      fontSize: '11px',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {c.type}
                  </span>
                </td>
                <td style={{ ...tdStyle, minWidth: '140px' }}>
                  <BarCell value={c.similarity_score} color="var(--status-info)" />
                </td>
                <td style={tdStyle}>
                  <StateBadge state={c.state} />
                </td>
                <td style={{ ...tdStyle, minWidth: '140px' }}>
                  {c.effectiveness_score != null ? (
                    <BarCell value={c.effectiveness_score} color="var(--status-success)" />
                  ) : (
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── Main Page ───

export default function KnowledgePage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '40px' }}>
      <h1
        className="font-[family-name:var(--font-geist-sans)]"
        style={{
          fontSize: '20px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: 0,
        }}
      >
        Knowledge &amp; Learning
      </h1>

      <MetaPatternsSection />
      <DecisionRecordsSection />
      <TransferCandidatesSection />
    </div>
  );
}
