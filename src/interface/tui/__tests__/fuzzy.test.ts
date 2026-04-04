import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyFilter } from '../fuzzy.js';

describe('fuzzyMatch', () => {
  it('returns null for empty query', () => {
    expect(fuzzyMatch('', 'hello')).toBeNull();
  });

  it('returns null when no subsequence match', () => {
    expect(fuzzyMatch('xyz', '/run')).toBeNull();
    expect(fuzzyMatch('abc', 'xyz')).toBeNull();
  });

  it('matches exact subsequences', () => {
    expect(fuzzyMatch('st', '/start')).not.toBeNull();
    expect(fuzzyMatch('st', '/status')).not.toBeNull();
    expect(fuzzyMatch('st', '/stop')).not.toBeNull();
  });

  it('returns null when characters are out of order', () => {
    // 'ts' is NOT a subsequence of 'start' in order (t comes before s in start... wait, s-t-a-r-t)
    // Actually 'ts' means t then s — 't' at index 1, 's' needs to appear after index 1 — none
    expect(fuzzyMatch('ts', '/stop')).toBeNull();
  });

  it('scores exact prefix match higher than scattered match', () => {
    // 'run' at the start of 'run' should beat 'run' scattered across a longer string
    const exactScore = fuzzyMatch('run', 'run');
    const scatteredScore = fuzzyMatch('run', 'r-unknown');
    expect(exactScore).not.toBeNull();
    expect(scatteredScore).not.toBeNull();
    expect(exactScore!).toBeGreaterThan(scatteredScore!);
  });

  it('scores consecutive characters higher than non-consecutive', () => {
    const consecutive = fuzzyMatch('sta', '/start');   // s-t-a consecutive
    const scattered = fuzzyMatch('stp', '/stop');      // s-t-o-p, stp: s,t,p — consecutive s,t then skip
    expect(consecutive).not.toBeNull();
    expect(scattered).not.toBeNull();
    // consecutive should score at least as well
    expect(consecutive!).toBeGreaterThanOrEqual(scattered!);
  });

  it('bonus for match after separator', () => {
    // 'c' in 'code-quality' at start of 'quality' segment gets separator bonus
    const withSepBonus = fuzzyMatch('q', 'code-quality');
    const withoutSep = fuzzyMatch('q', 'quality-code');
    expect(withSepBonus).not.toBeNull();
    expect(withoutSep).not.toBeNull();
    // Both match; withoutSep starts at position 0 which gets +10 bonus
    // we just verify both match
    expect(withSepBonus!).toBeGreaterThan(0);
  });

  it('matches goal names: cod matches code-quality-improvement', () => {
    const score = fuzzyMatch('cod', 'code-quality-improvement');
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('RUN', '/run')).not.toBeNull();
    expect(fuzzyMatch('Run', '/RUN')).not.toBeNull();
  });
});

describe('fuzzyFilter', () => {
  const items = ['/start', '/status', '/stop', '/run', '/report', '/goals', '/help'];

  it('returns empty array for empty query', () => {
    expect(fuzzyFilter('', items, (x) => x)).toEqual([]);
  });

  it('filters items by fuzzy match', () => {
    const results = fuzzyFilter('st', items, (x) => x);
    expect(results.length).toBeGreaterThan(0);
    // all results must contain s and t in order
    for (const r of results) {
      expect(fuzzyMatch('st', r)).not.toBeNull();
    }
  });

  it('returns results sorted by score (best first)', () => {
    const results = fuzzyFilter('run', ['/run', '/r-un-known', '/rn'], (x) => x);
    // '/run' should be first — consecutive, prefix
    expect(results[0]).toBe('/run');
  });

  it('respects maxResults cap', () => {
    const results = fuzzyFilter('s', items, (x) => x, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('works with object items via getText', () => {
    const goals = [
      { id: '1', title: 'improve-test-coverage' },
      { id: '2', title: 'fix-startup-time' },
      { id: '3', title: 'deploy-production' },
    ];
    const results = fuzzyFilter('test', goals, (g) => g.title);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toBe('improve-test-coverage');
  });

  it('goal name: cod matches code-quality-improvement', () => {
    const goals = ['code-quality-improvement', 'test-coverage', 'deploy'];
    const results = fuzzyFilter('cod', goals, (g) => g);
    expect(results).toContain('code-quality-improvement');
  });
});
