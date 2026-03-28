import { NextResponse } from 'next/server';
import { getStateManager } from '../../../lib/pulseed-client';

export async function GET() {
  try {
    const sm = getStateManager();
    const goalIds = await sm.listGoalIds();
    const goals = await Promise.all(
      goalIds.map((id: string) => sm.loadGoal(id))
    );
    return NextResponse.json(goals.filter(Boolean));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
