import { NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

interface LearnedPattern {
  pattern_id: string;
  type: string;
  description: string;
  confidence: number;
  evidence_count: number;
  source_goal_ids: string[];
  applicable_domains: string[];
  created_at: string;
  last_applied_at: string | null;
}

export async function GET() {
  try {
    const learningDir = join(homedir(), '.pulseed', 'learning');
    let files: string[];
    try {
      files = await readdir(learningDir);
    } catch {
      return NextResponse.json({ patterns: [] });
    }

    const patternFiles = files.filter((f) => f.endsWith('_patterns.json'));
    const allPatterns: LearnedPattern[] = [];

    for (const file of patternFiles) {
      try {
        const content = await readFile(join(learningDir, file), 'utf-8');
        const data = JSON.parse(content);
        const patterns: LearnedPattern[] = Array.isArray(data) ? data : [];
        allPatterns.push(...patterns);
      } catch {
        // Skip malformed files
      }
    }

    // Sort by confidence descending
    allPatterns.sort((a, b) => b.confidence - a.confidence);

    return NextResponse.json({ patterns: allPatterns });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
