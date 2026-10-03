/**
 * Local message search: query building and highlighting (pure, unit-tested).
 *
 * User input never reaches SQLite as syntax. For FTS5 every term becomes a
 * quoted string with a prefix star ("hel"*), so operators (AND/OR/NOT/NEAR),
 * column filters (col:), boosts (^) and stray quotes are just text. The LIKE
 * fallback (no FTS5, e.g. some web builds) escapes %, _ and the escape char.
 */

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_TERMS = 8;
const MAX_TERM_LENGTH = 64;

/** Splits user input into search terms (letters/digits/marks, any script). */
export function tokenize(input: string): string[] {
  const terms = input
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, MAX_TERM_LENGTH));
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

export function isSearchable(input: string): boolean {
  return input.trim().length >= MIN_QUERY_LENGTH && tokenize(input).length > 0;
}

/** FTS5 MATCH expression: every term must match (implicit AND), as a prefix. */
export function buildFtsQuery(input: string): string | null {
  if (!isSearchable(input)) return null;
  return tokenize(input)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}

/** Escapes LIKE wildcards for `LIKE ? ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One `%term%` pattern per term (all must match), for the LIKE fallback. */
export function buildLikePatterns(input: string): string[] {
  if (!isSearchable(input)) return [];
  return tokenize(input).map((t) => `%${escapeLike(t)}%`);
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * Splits `text` into plain / matching segments for highlighting. Matches are
 * case-insensitive on the search terms (prefix matches inside words included).
 */
export function highlightSegments(text: string, input: string): TextSegment[] {
  const terms = tokenize(input).sort((a, b) => b.length - a.length);
  if (!text || terms.length === 0) return text ? [{ text, match: false }] : [];
  const lower = text.toLowerCase();
  // Only use the lower-cased string for positions when lengths line up
  // (some characters change length when case-folded).
  if (lower.length !== text.length) return [{ text, match: false }];

  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(term, from);
      if (i < 0) break;
      for (let j = i; j < i + term.length; j++) marks[j] = true;
      from = i + term.length;
    }
  }

  const out: TextSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      out.push({ text: text.slice(start, i), match: marks[start] });
      start = i;
    }
  }
  return out;
}

/** A short excerpt centred on the first match (for result lists). */
export function makeSnippet(text: string, input: string, radius = 40): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const positions = tokenize(input)
    .map((t) => lower.indexOf(t))
    .filter((i) => i >= 0);
  if (text.length <= radius * 2) return text;
  if (positions.length === 0) return `${text.slice(0, radius * 2)}…`;
  const first = Math.min(...positions);
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Index navigation for "result n of m" with wrap-around. */
export function stepResult(current: number, total: number, direction: 'older' | 'newer'): number {
  if (total <= 0) return -1;
  if (current < 0) return 0;
  return direction === 'older' ? (current + 1) % total : (current - 1 + total) % total;
}
