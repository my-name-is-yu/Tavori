import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tasksDir = join(homedir(), '.pulseed', 'tasks', id);

    let files: string[];
    try {
      files = await readdir(tasksDir);
    } catch {
      return NextResponse.json({ tasks: [] });
    }

    const tasks: Array<Record<string, unknown>> = [];
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const content = await readFile(join(tasksDir, file), 'utf-8');
        tasks.push(JSON.parse(content));
      } catch {
        // Skip malformed files
      }
    }

    // Sort by created_at descending (most recent first)
    tasks.sort((a, b) => {
      const aTime = a.created_at ? new Date(String(a.created_at)).getTime() : 0;
      const bTime = b.created_at ? new Date(String(b.created_at)).getTime() : 0;
      return bTime - aTime;
    });

    return NextResponse.json({ tasks });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
