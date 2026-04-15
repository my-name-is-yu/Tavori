#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const ignoredDirNames = new Set([
  'node_modules',
  '.git',
  '.next',
  '.claude',
  '.claire',
  '.pulseed',
  'coverage',
  'coverage-c8',
  'dist',
  'memory',
  'web',
]);
const ignoredRelativeDirs = new Set(['docs/archive']);
const ignoredFileNames = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json']);

const markdownFiles = collectMarkdownFiles(repoRoot);
const issues = [];

for (const filePath of markdownFiles) {
  const relativePath = path.relative(repoRoot, filePath) || path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const fenceState = {
    inFence: false,
    fenceChar: null,
    fenceLength: 0,
    openingLine: 0,
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})(.*)$/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      const fenceChar = marker[0];
      const fenceLength = marker.length;

      if (!fenceState.inFence) {
        fenceState.inFence = true;
        fenceState.fenceChar = fenceChar;
        fenceState.fenceLength = fenceLength;
        fenceState.openingLine = lineNumber;
        continue;
      }

      if (fenceChar === fenceState.fenceChar && fenceLength >= fenceState.fenceLength) {
        fenceState.inFence = false;
        fenceState.fenceChar = null;
        fenceState.fenceLength = 0;
        fenceState.openingLine = 0;
        continue;
      }
    }

    if (fenceState.inFence) {
      continue;
    }

    if (trimmedStart.includes('<<<<<<<') || trimmedStart.includes('=======') || trimmedStart.includes('>>>>>>>')) {
      issues.push(formatIssue(relativePath, lineNumber, 'unresolved merge conflict marker'));
    }

    const markdownLine = stripInlineCode(line);

    for (const target of findMarkdownLinkTargets(markdownLine)) {
      const normalizedTarget = normalizeMarkdownTarget(target);
      if (!normalizedTarget) {
        continue;
      }

      const resolvedPath = path.resolve(path.dirname(filePath), normalizedTarget);
      if (!fileExists(resolvedPath)) {
        issues.push(formatIssue(relativePath, lineNumber, `missing Markdown link target: ${normalizedTarget}`));
      }
    }
  }

  if (fenceState.inFence && fenceState.fenceChar === '`') {
    issues.push(formatIssue(relativePath, fenceState.openingLine, 'unbalanced triple-backtick fence'));
  }
}

if (issues.length > 0) {
  console.error('docs check failed:');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log(`docs check passed: scanned ${markdownFiles.length} Markdown files.`);
}

function collectMarkdownFiles(rootDir) {
  const results = [];
  walk(rootDir, results);
  return results.sort((a, b) => a.localeCompare(b));
}

function walk(currentDir, results) {
  const relativeDir = path.relative(repoRoot, currentDir);
  if (ignoredRelativeDirs.has(relativeDir)) {
    return;
  }

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirNames.has(entry.name) || entry.name.startsWith('.dist-delete-')) {
        continue;
      }
      walk(path.join(currentDir, entry.name), results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (ignoredFileNames.has(entry.name) || !entry.name.endsWith('.md')) {
      continue;
    }

    results.push(path.join(currentDir, entry.name));
  }
}

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

function findMarkdownLinkTargets(line) {
  const targets = [];

  for (const match of line.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    targets.push(match[1]);
  }

  const referenceMatch = line.match(/^ {0,3}\[[^\]]+\]:\s*(.+)$/);
  if (referenceMatch) {
    targets.push(referenceMatch[1]);
  }

  return targets;
}

function normalizeMarkdownTarget(rawTarget) {
  const target = rawTarget.trim();
  if (!target) {
    return null;
  }

  if (target.startsWith('#')) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target) || target.startsWith('//')) {
    return null;
  }

  if (path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) {
    return null;
  }

  const destination = target.replace(/["'].*$/, '').trim();
  const angleBracketMatch = destination.match(/^<(.+)>$/);
  const cleaned = angleBracketMatch ? angleBracketMatch[1].trim() : destination;
  const pathPart = cleaned.split(/[?#]/, 1)[0].trim();

  if (!pathPart || !pathPart.toLowerCase().endsWith('.md')) {
    return null;
  }

  return pathPart;
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function formatIssue(relativePath, lineNumber, message) {
  return `${relativePath}:${lineNumber} ${message}`;
}
