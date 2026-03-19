'use client';

import { useId } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface ChartDataPoint {
  t: string;
  gap?: number | null;
  trust?: number | null;
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        padding: '6px 10px',
        fontSize: '12px',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-geist-mono)',
      }}
    >
      <div style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginBottom: 2 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: 'var(--text-primary)' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  );
}

export function GapHistoryChart({ data }: { data: ChartDataPoint[] }) {
  const gradientId = useId().replace(/:/g, '');

  if (data.length === 0) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: '12px', height: '160px', display: 'flex', alignItems: 'center' }}>
        No history data
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="t"
          tick={{ fill: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<ChartTooltip />} />
        <Area
          type="monotone"
          dataKey="gap"
          name="Gap %"
          stroke="var(--accent-primary)"
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 3, fill: 'var(--accent-primary)' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TrustChart({ data }: { data: ChartDataPoint[] }) {
  if (!data.some((d) => d.trust != null)) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: '12px', height: '120px', display: 'flex', alignItems: 'center' }}>
        No trust history
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
        <XAxis
          dataKey="t"
          tick={{ fill: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[-100, 100]}
          tick={{ fill: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<ChartTooltip />} />
        <Line
          type="monotone"
          dataKey="trust"
          name="Trust"
          stroke="var(--trust-positive)"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
