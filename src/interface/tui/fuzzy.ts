// ─── Fuzzy Matching Utility ───
//
// Pure functions for fuzzy/subsequence matching with scoring.
// No external dependencies.

interface FuzzyMatch {
  item: string;
  score: number;
  label?: string;
  description?: string;
}

/**
 * Fuzzy match: characters in query must appear in order in target.
 * Returns a score (higher = better) or null if no match.
 *
 * Score bonuses:
 *   +10 for match starting at position 0
 *   +5  for each consecutive character run
 *   +3  for match after a separator (/, -, _)
 */
export function fuzzyMatch(query: string, target: string): number | null {
  if (!query) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let score = 0;
  let ti = 0;
  let qi = 0;
  let consecutive = 0;

  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      // Bonus for match at start (qi===0: first query char; ti<=1: pos 0 or after leading '/')
      if (qi === 0 && ti <= 1) score += 10;

      // Bonus for match after separator
      if (ti > 0 && (t[ti - 1] === '/' || t[ti - 1] === '-' || t[ti - 1] === '_')) {
        score += 3;
      }

      consecutive++;
      // Bonus for consecutive matches (grows with streak)
      if (consecutive > 1) score += 5;

      score += 1;
      qi++;
    } else {
      consecutive = 0;
    }
    ti++;
  }

  // All query characters must be matched
  if (qi < q.length) return null;

  return score;
}

/**
 * Filter and sort items by fuzzy match score.
 * Returns top N results (default: 10).
 */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  maxResults = 10
): T[] {
  if (!query) return [];

  const scored: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const score = fuzzyMatch(query, getText(item));
    if (score !== null) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.item);
}
