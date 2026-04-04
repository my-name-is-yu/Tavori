// ─── Markdown Renderer ───
//
// Simple markdown-to-plain-text conversion for Ink's <Text> component.
// We intentionally avoid marked-terminal because its ANSI escape codes
// with embedded newlines conflict with Ink's layout engine, causing
// text overlap and incorrect line-height calculations.
//
// Instead, we do lightweight manual conversion that produces clean text
// which Ink can properly measure and render.

import { theme } from "./theme.js";

export interface MarkdownSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  color?: string;
}

export interface MarkdownLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  segments?: MarkdownSegment[];
  language?: string;
}

/**
 * Convert markdown text to an array of MarkdownLine objects.
 * Each line represents a visual line in the output.
 * Ink will render each as a separate <Text> element inside a vertical <Box>.
 */
export function renderMarkdownLines(text: string): MarkdownLine[] {
  const lines = text.split('\n');
  const result: MarkdownLine[] = [];

  let inCodeBlock = false;
  let codeLanguage = '';

  for (const line of lines) {
    // Code block toggle
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        // Extract language from opening fence (e.g. ```ts -> "ts")
        const fenceMatch = line.trim().match(/^```(\w+)?/);
        codeLanguage = fenceMatch?.[1] ?? '';
      } else {
        codeLanguage = '';
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      const codeLine = '  ' + line;
      const segs = codeLanguage
        ? highlightCodeLine(line, codeLanguage)
        : undefined;
      result.push({ text: codeLine, dim: true, language: codeLanguage, segments: segs });
      continue;
    }

    const trimmed = line.trim();

    // Empty line -> blank separator
    if (trimmed === '') {
      result.push({ text: '' });
      continue;
    }

    // Headers -> bold text (strip # markers)
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      result.push({ text: headerMatch[2], bold: true });
      continue;
    }

    // Unordered list items -> bullet points
    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      const prefix = '  \u2022 ';
      const segs = parseInlineSegments(listMatch[1]);
      result.push({ text: prefix + flattenSegments(segs), segments: prependText(prefix, segs) });
      continue;
    }

    // Ordered list items -> numbered
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      const prefix = '  ' + orderedMatch[1] + '. ';
      const segs = parseInlineSegments(orderedMatch[2]);
      result.push({ text: prefix + flattenSegments(segs), segments: prependText(prefix, segs) });
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      result.push({ text: '\u2500'.repeat(40), dim: true });
      continue;
    }

    // Normal text -> parse inline segments
    const segs = parseInlineSegments(trimmed);
    const hasFormatting = segs.some((s) => s.bold || s.code || s.italic || s.color);
    if (hasFormatting) {
      result.push({ text: flattenSegments(segs), segments: segs });
    } else {
      result.push({ text: flattenSegments(segs) });
    }
  }

  return result;
}

/** Helper: convert segments back to plain text */
function flattenSegments(segs: MarkdownSegment[]): string {
  return segs.map((s) => s.text).join('');
}

/** Helper: prepend plain text before an array of segments */
function prependText(prefix: string, segs: MarkdownSegment[]): MarkdownSegment[] {
  return [{ text: prefix }, ...segs];
}

/**
 * Parse inline markdown formatting into segments.
 * Handles: **bold**, __bold__, *italic*, _italic_, `code`, [links](url)
 */
export function parseInlineSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  // Pattern: bold+italic (***), bold (**/__), italic (*/_), code (`), link ([text](url))
  const pattern = /(\*{3}.+?\*{3}|\*{2}.+?\*{2}|_{2}.+?_{2}|\*.+?\*|_.+?_|`[^`]+`|\[.+?\]\(.+?\))/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    // Plain text before this match
    if (m.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, m.index) });
    }

    const raw = m[0];

    if (raw.startsWith('***') && raw.endsWith('***')) {
      segments.push({ text: raw.slice(3, -3), bold: true, italic: true });
    } else if ((raw.startsWith('**') && raw.endsWith('**')) ||
               (raw.startsWith('__') && raw.endsWith('__'))) {
      segments.push({ text: raw.slice(2, -2), bold: true });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      segments.push({ text: raw.slice(1, -1), code: true });
    } else if ((raw.startsWith('*') && raw.endsWith('*')) ||
               (raw.startsWith('_') && raw.endsWith('_'))) {
      segments.push({ text: raw.slice(1, -1), italic: true });
    } else if (raw.startsWith('[')) {
      // Link: [text](url) -> just show text
      const linkMatch = raw.match(/^\[(.+?)\]/);
      segments.push({ text: linkMatch ? linkMatch[1] : raw });
    } else {
      segments.push({ text: raw });
    }

    lastIndex = m.index + raw.length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text }];
}

// ─── Code Syntax Highlighting ───

const JS_TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'break', 'continue', 'switch', 'case', 'default', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'import', 'export', 'from', 'as',
  'class', 'extends', 'super', 'this', 'static', 'get', 'set', 'async',
  'await', 'try', 'catch', 'finally', 'throw', 'void', 'null', 'undefined',
  'true', 'false', 'type', 'interface', 'enum', 'namespace', 'implements',
  'abstract', 'readonly', 'public', 'private', 'protected', 'declare',
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'import', 'from', 'as', 'if', 'elif', 'else',
  'for', 'while', 'break', 'continue', 'pass', 'and', 'or', 'not', 'in',
  'is', 'lambda', 'with', 'yield', 'raise', 'try', 'except', 'finally',
  'global', 'nonlocal', 'del', 'assert', 'True', 'False', 'None', 'async',
  'await',
]);

function getKeywords(language: string): Set<string> {
  const lang = language.toLowerCase();
  if (['js', 'ts', 'javascript', 'typescript', 'tsx', 'jsx'].includes(lang)) {
    return JS_TS_KEYWORDS;
  }
  if (lang === 'python' || lang === 'py') {
    return PY_KEYWORDS;
  }
  // Generic fallback: combine both
  return new Set([...JS_TS_KEYWORDS, ...PY_KEYWORDS]);
}

/**
 * Apply basic keyword-based syntax highlighting to a single code line.
 * Returns an array of MarkdownSegment with color hints.
 */
export function highlightCodeLine(line: string, language: string): MarkdownSegment[] {
  // Comment lines
  if (/^\s*(\/\/|#)/.test(line)) {
    return [{ text: '  ' + line, color: theme.codeComment }];
  }

  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const content = line.slice(indent.length);

  if (content === '') {
    return [{ text: '  ' + indent }];
  }

  const keywords = getKeywords(language);
  const segments: MarkdownSegment[] = [];

  // Leading indentation prefix
  segments.push({ text: '  ' + indent });

  // Tokenize: strings, numbers, identifiers, other chars
  const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+\.?\d*\b|\b[A-Za-z_$][\w$]*\b|[^\w\s"'`]|\s+)/g;
  let tm: RegExpExecArray | null;

  while ((tm = tokenPattern.exec(content)) !== null) {
    const token = tm[0];

    if (/^["'`]/.test(token)) {
      // String literal
      segments.push({ text: token, color: theme.codeString });
    } else if (/^\d/.test(token)) {
      // Number
      segments.push({ text: token, color: theme.codeNumber });
    } else if (/^[A-Za-z_$]/.test(token) && keywords.has(token)) {
      // Keyword
      segments.push({ text: token, color: theme.codeKeyword });
    } else {
      segments.push({ text: token });
    }
  }

  return segments;
}

