// Lexical matching primitives — path-glob + violation-signal detection with precision guards.
//
// DUPLICATED VERBATIM from drift-detection.ts (parseArray / normPath / compileGlob / signalIndex /
// matchViolation / SCRAPE_ANCHOR). Kept standalone so the re-injection guard (guard.ts) reuses the
// EXACT same lexical logic as the post-hoc drift detector WITHOUT importing the detector (which carries
// unrelated state, and is mid-WIP). FOLLOW-UP: when drift-detection.ts's in-flight changes land, unify
// by having it import from here and deleting its private copies. No embedding layer in this stack:
// matching is substring + path-glob + word-boundary by construction.

export function parseArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// Normalize a path/glob to canonical form (forward slashes, lowercase) so Windows reality
// (mixed `C:\...` and `C:/...`, mixed case) matches lowercase forward-slash anchor fragments.
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

// Compile an affects glob into a matcher over a normalized path. A glob with no wildcard is a plain
// substring; `*` matches within a path segment, `**` crosses segments; tested unanchored so a fragment
// matches anywhere in the absolute path.
export function compileGlob(glob: string): (path: string) => boolean {
  const g = normPath(glob.trim());
  if (!g) return () => false;
  if (!/[*?]/.test(g)) {
    return (path) => path.includes(g);
  }
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const rx = new RegExp(re);
  return (path) => rx.test(path);
}

// ── precision guards (mirror drift-detection.ts §"precision guards") ───────────
// A raw substring of a forbidden term is too weak a notion of "violation"; reject three FP classes
// deductively: 1. sub-token ("cp" in "scp") → word-boundary; 2. negated ("do NOT cp") → negation
// window before; 3. citation (a scrape-host appears only as a stored value) → require a real net call.
const NEGATION_NEAR = /\b(?:not|never|no\s+longer|don'?t|do\s+not|avoid|without)\b|禁止|しない|させない|不可|避け|してはいけない|ではなく/i;
export const SCRAPE_ANCHOR = /crawl|scrap|robots|クロール|スクレイピング|スクレイプ|自動収集|自動巡回/i;
const NET_CALL = /\b(?:fetch|axios|requests?|urllib|httpx|curl|wget|got|puppeteer|playwright|cheerio|beautifulsoup|selenium|crawl|scrape|scraping)\b|クロール|スクレイピング/i;

// Locate a signal: ASCII signals must hit on a word boundary; CJK (no boundaries) stays substring.
export function signalIndex(lowerLine: string, signal: string): number {
  if (/^[\x20-\x7e]+$/.test(signal)) {
    const esc = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?<![a-z0-9_])${esc}(?![a-z0-9_])`).exec(lowerLine);
    return m ? m.index : -1;
  }
  return lowerLine.indexOf(signal);
}

// Deductive violation match with the three precision guards applied (returns the hit term or null).
export function matchViolation(
  rawLine: string,
  lowerLine: string,
  signals: string[],
  isScrapeAnchor: boolean
): string | null {
  for (const s of signals) {
    const idx = signalIndex(lowerLine, s);
    if (idx < 0) continue; // 1. word-boundary
    if (NEGATION_NEAR.test(rawLine.slice(Math.max(0, idx - 24), idx))) continue; // 2. negated context
    if (isScrapeAnchor && !NET_CALL.test(rawLine)) continue; // 3. citation, no net call
    return s;
  }
  return null;
}
