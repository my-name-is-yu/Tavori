import { NextRequest, NextResponse } from 'next/server';
import { getStateManager } from '../../../../lib/pulseed-client';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sm = getStateManager();
    const goal = await sm.loadGoal(id);
    if (!goal) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(goal);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
