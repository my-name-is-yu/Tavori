import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ goalId: string }> }
) {
  try {
    const { goalId } = await params;
    const strategiesDir = join(homedir(), '.pulseed', 'strategies', goalId);

    let files: string[];
    try {
      files = await readdir(strategiesDir);
    } catch {
      return NextResponse.json({ strategies: [] });
    }

    const strategies = [];
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const content = await readFile(join(strategiesDir, file), 'utf-8');
        strategies.push(JSON.parse(content));
      } catch {
        // Skip malformed files
      }
    }

    return NextResponse.json({ strategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
