import { NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getStateManager } from '../../../lib/pulseed-client';

interface DecisionEntry {
  id: string;
  goal_id: string;
  goal_name?: string;
  decision: string;
  timestamp: string;
  strategy_id?: string;
  what_worked?: string[];
  what_failed?: string[];
  suggested_next?: string[];
}

export async function GET() {
  try {
    const decisionsDir = join(homedir(), '.pulseed', 'decisions');
    const sm = getStateManager();
    const decisions: DecisionEntry[] = [];

    // Try reading from ~/.pulseed/decisions/ directory
    let files: string[];
    try {
      files = await readdir(decisionsDir);
    } catch {
      files = [];
    }

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const content = await readFile(join(decisionsDir, file), 'utf-8');
        const record = JSON.parse(content);
        if (record.decision) {
          // Resolve goal name
          let goalName: string | undefined;
          try {
            const goal = await sm.loadGoal(record.goal_id);
            goalName = (goal as Record<string, unknown>)?.name as string | undefined;
          } catch { /* ignore */ }

          decisions.push({
            id: record.id || file.replace('.json', ''),
            goal_id: record.goal_id,
            goal_name: goalName,
            decision: record.decision,
            timestamp: record.timestamp || '',
            strategy_id: record.strategy_id,
            what_worked: record.what_worked,
            what_failed: record.what_failed,
            suggested_next: record.suggested_next,
          });
        }
      } catch { /* skip malformed */ }
    }

    // Sort by timestamp descending, limit to 10
    decisions.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime() || 0;
      const tb = new Date(b.timestamp).getTime() || 0;
      return tb - ta;
    });

    return NextResponse.json(decisions.slice(0, 10));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
