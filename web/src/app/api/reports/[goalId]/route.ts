import { NextRequest, NextResponse } from 'next/server';
import { getReportingEngine } from '../../../../lib/pulseed-client';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ goalId: string }> }
) {
  try {
    const { goalId } = await params;
    const re = getReportingEngine();
    const reports = await re.listReports(goalId);
    return NextResponse.json(reports);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
