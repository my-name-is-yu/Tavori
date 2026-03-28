'use client';

import { usePulSeedStore } from '../../lib/store';
import { GoalTable, type GoalRow } from '../../components/dashboard/goal-table';

export default function GoalsPage() {
  const goals = usePulSeedStore((state) => state.goals) as GoalRow[];

  return (
    <div>
      <h1
        className="font-[family-name:var(--font-geist-sans)]"
        style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '24px' }}
      >
        Goals
      </h1>
      <GoalTable goals={goals} loading={false} />
    </div>
  );
}
