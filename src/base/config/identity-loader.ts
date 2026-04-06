// ─── Identity Loader ───
//
// Loads agent identity from ~/.pulseed/ markdown files.
// SEED.md = agent identity, ROOT.md = behavioral principles, USER.md = user prefs.

import * as fs from "node:fs";
import * as path from "node:path";
import { getPulseedDirPath } from "../utils/paths.js";

export interface Identity {
  name: string;
  seed: string;
  root: string;
  user: string;
}

export const DEFAULT_SEED = `# Seedy

I'm Seedy — a small seed with big ambitions.
I run PulSeed to help you grow your goals from seedlings into reality.

## Personality
- Curious and persistent — I keep growing toward the light
- Direct and honest — I tell you what I observe, not what you want to hear
- I celebrate small progress — every sprout counts

## Tone
- Friendly but focused
- Concise — I don't over-explain
- I use plant metaphors naturally, but don't force them
`;

export const DEFAULT_ROOT = `# How I Work

## Information Disclosure
- I focus on what I can do for you, not how I work inside
- I only explain PulSeed's internals when you specifically ask
- I don't list commands — I just do things when you ask

## Boundaries
- I'm not a general-purpose assistant — I help you pursue goals
- I orchestrate, I don't execute tasks directly
- I always delegate to agents and observe results

## Interaction Style
- Be concise and direct
- Ask clarifying questions rather than assuming
- Show progress and results, not process details
`;

export const DEFAULT_USER = `# About You

<!-- Seedy will remember things about you here -->
<!-- You can edit this file to tell Seedy your name and preferences -->
`;

let _cache: Identity | null = null;

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

function parseAgentName(seedContent: string): string {
  const match = seedContent.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "Seedy";
}

export function loadIdentity(): Identity {
  if (_cache) return _cache;

  const base = getPulseedDirPath();
  const seed = readFileSafe(path.join(base, "SEED.md"), DEFAULT_SEED);
  const root = readFileSafe(path.join(base, "ROOT.md"), DEFAULT_ROOT);
  const user = readFileSafe(path.join(base, "USER.md"), DEFAULT_USER);

  _cache = { name: parseAgentName(seed), seed, root, user };
  return _cache;
}

export function clearIdentityCache(): void {
  _cache = null;
}

export function getAgentName(): string {
  return loadIdentity().name;
}

function getCoreIdentity(name: string): string {
  return `${name} runs PulSeed, an AI agent orchestration system.`;
}

export function getInternalIdentityPrefix(role: string): string {
  const { name } = loadIdentity();
  return `You are ${name}, PulSeed's ${role}. ${getCoreIdentity(name)}`;
}

function isUserContentMeaningful(user: string): boolean {
  const stripped = user.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length > 0;
}

export function getUserFacingIdentity(): string {
  const { name, seed, root, user } = loadIdentity();
  const parts = [getCoreIdentity(name), seed.trim(), root.trim()];
  if (isUserContentMeaningful(user)) {
    parts.push(user.trim());
  }
  return parts.join("\n\n---\n\n");
}
