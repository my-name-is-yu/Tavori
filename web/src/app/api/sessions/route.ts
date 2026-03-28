import { NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export async function GET() {
  try {
    const sessionsDir = join(homedir(), '.pulseed', 'sessions');

    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      return NextResponse.json([]);
    }

    const sessions = [];
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const content = await readFile(join(sessionsDir, file), 'utf-8');
        sessions.push(JSON.parse(content));
      } catch {
        // Skip malformed files
      }
    }

    return NextResponse.json(sessions);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
