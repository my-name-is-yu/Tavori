import { NextRequest, NextResponse } from 'next/server';
import { getStateManager } from '../../../../../lib/pulseed-client';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sm = getStateManager();
    const history = await sm.loadGapHistory(id);
    return NextResponse.json(history);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
