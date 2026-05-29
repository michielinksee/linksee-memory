// Memory→memory edge detection (precision-first, no LLM required).
//
// Populates the `memory_edges` table with supersedes/contradicts links between
// DECISION memories, so the dashboard can render Pivot Chains and recall can
// surface superseded decisions. Runs inside the sleep-mode consolidation sweep.
// Idempotent (UNIQUE constraint on memory_edges).
//
// Heuristic: within one entity, a later decision that shares strong topical terms
// with an earlier decision *supersedes* it (→ *contradicts* if it carries reversal
// markers like やめる / 撤回 / revert / instead of). The earlier decision's state
// is flipped to 'superseded'. We link to the MOST RECENT same-topic decision so
// chains form (A → B → C) rather than cliques.

import type Database from 'better-sqlite3';
import { isMetaOrNoise, isPastedExternalContent } from './session-parser.js';

export interface EdgeSample {
  from_id: number;
  to_id: number;
  relation: string;
  from_title: string;
  to_title: string;
  shared: string[];
}

export interface EdgeDetectionResult {
  decisionsScanned: number;
  edgesCreated: number;
  supersedes: number;
  contradicts: number;
  supersededMarked: number;
  samples: EdgeSample[];
}

const REVERSAL_MARKERS =
  /やめ|撤回|取り消|廃止|ではなく|じゃなく|の代わり|に変更|に切り替|乗り換|見直|revert|rollback|instead of|no longer|switch(?:ing|ed)?\s+(?:to|from|away)|deprecat|abandon|replace[sd]?\b/i;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'our', 'their',
  'about', 'what', 'when', 'will', 'have', 'has', 'was', 'were', 'are', 'not', 'use', 'using',
  'memory', 'linksee', 'session', 'decision', 'project', 'やった', 'する', 'した', 'して',
  'こと', 'ため', 'よう', 'という', 'です', 'ます', 'など', 'その', 'この', 'これ', 'それ',
  // conversational fillers — must never count as a shared "topic" term
  'そうだね', 'そうね', 'ありがとう', 'なるほど', 'やろう', 'いいね', 'おおいね', 'これでいい',
  'これでいいと思う', 'これでいいかな', 'わかった', '了解', 'おはよう', 'おつかれ',
]);

// Both endpoints must have substantive core text — kills "そうだね"/"ありがとう"
// turns that the upstream classifier over-labels as decisions.
const MIN_CORE_LEN = 40;

// Decisions whose body opens with an acknowledgement are almost always chitchat
// the upstream classifier mis-typed — never use them as edge endpoints.
const CHITCHAT_OPENER = /^\s*(?:そう(?:だ?ね|だよね)?|うん|ありがと|なるほど|おお|へえ|了解|わかった|はい|おはよう|おつかれ|いいね|まあ|ええ|あー)/;

// Terminal output, git/npm logs, and pasted emails also get mis-typed as decisions.
// isPastedExternalContent misses these shapes, so guard them explicitly.
const LOOKS_LIKE_PASTE = /PS [A-Za-z]:\\|[A-Za-z]:\\Users\\|create mode \d{6}|\bgit (?:commit|push|add|status|log|diff|branch|checkout|merge)\b|commit -m|\bnpm (?:run|install|ci)\b|Upon further review|resubmission|Thank you for your/i;

function significantTerms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  const asciiRe = /[a-z][a-z0-9_+.-]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = asciiRe.exec(lower)) !== null) {
    const w = m[0];
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  // CJK runs (hiragana / katakana / kanji / half-width kana), length 2..12.
  const cjkRe = /[぀-ヿ㐀-鿿ｦ-ﾟ]{2,12}/g;
  while ((m = cjkRe.exec(text)) !== null) {
    const w = m[0];
    if (!STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function coreText(content: string): { title: string; body: string } {
  try {
    const o: any = JSON.parse(content);
    return {
      title: String(o.title ?? ''),
      body: String(o.what ?? o.decision ?? o.intent ?? o.learned ?? ''),
    };
  } catch {
    return { title: '', body: content };
  }
}

interface DecRow { id: number; entity_id: number; content: string; created_at: number; }

export function detectMemoryEdges(
  db: Database.Database,
  opts: { dryRun?: boolean; lookback?: number } = {}
): EdgeDetectionResult {
  const lookback = opts.lookback ?? 25;
  const res: EdgeDetectionResult = {
    decisionsScanned: 0, edgesCreated: 0, supersedes: 0, contradicts: 0, supersededMarked: 0, samples: [],
  };

  const rows = db.prepare(`
    SELECT id, entity_id, content, created_at
    FROM memories
    WHERE mem_type = 'decision' AND json_valid(content)
    ORDER BY entity_id ASC, created_at ASC, id ASC
  `).all() as DecRow[];
  res.decisionsScanned = rows.length;
  if (rows.length < 2) return res;

  const byEntity = new Map<number, DecRow[]>();
  for (const r of rows) {
    const arr = byEntity.get(r.entity_id);
    if (arr) arr.push(r); else byEntity.set(r.entity_id, [r]);
  }

  // Prepare write statements only when actually writing — keeps dryRun safe on a
  // readonly connection (preview / verification path).
  const insEdge = opts.dryRun ? null : db.prepare(
    `INSERT OR IGNORE INTO memory_edges (from_memory_id, to_memory_id, relation) VALUES (?, ?, ?)`
  );
  const markSuperseded = opts.dryRun ? null : db.prepare(`
    UPDATE memories SET content = json_set(content, '$.state', 'superseded')
    WHERE id = ? AND json_valid(content) AND json_extract(content, '$.state') <> 'superseded'
  `);

  const apply = () => {
    for (const decisions of byEntity.values()) {
      if (decisions.length < 2) continue;
      const meta = decisions.map((d) => {
        const { title, body } = coreText(d.content);
        const text = `${title} ${body}`;
        // Defend against the polluted 'decision' input set: drop pasted external
        // content (emails / terminal logs), meta-noise, chitchat, and too-short bodies.
        const usable = text.trim().length >= MIN_CORE_LEN
          && !CHITCHAT_OPENER.test(body)
          && !isMetaOrNoise(body)
          && !isPastedExternalContent(body)
          && !LOOKS_LIKE_PASTE.test(text);
        return { id: d.id, title: (title || body).slice(0, 60), text, len: text.trim().length, terms: significantTerms(text), usable };
      }).filter((m) => m.usable && m.terms.size >= 3);
      for (let i = 1; i < meta.length; i++) {
        if (meta[i].terms.size < 3 || meta[i].len < MIN_CORE_LEN) continue;
        let linked = -1;
        let linkedShared: string[] = [];
        for (let j = i - 1; j >= 0 && i - j <= lookback; j--) {
          if (meta[j].terms.size < 3 || meta[j].len < MIN_CORE_LEN) continue;
          const shared: string[] = [];
          for (const t of meta[i].terms) if (meta[j].terms.has(t)) shared.push(t);
          if (shared.length < 3) continue; // require >= 3 shared topic terms (precision-first)
          const overlap = shared.length / Math.min(meta[i].terms.size, meta[j].terms.size);
          if (overlap > 0.85) continue; // near-identical memories = a duplicate, not a supersession
          if (overlap >= 0.25) { linked = j; linkedShared = shared; break; } // most-recent same-topic → chain
        }
        if (linked < 0) continue;
        const relation = REVERSAL_MARKERS.test(meta[i].text) ? 'contradicts' : 'supersedes';
        let counted = true;
        if (!opts.dryRun) {
          const r = insEdge!.run(meta[i].id, meta[linked].id, relation);
          if (r.changes > 0) {
            if (markSuperseded!.run(meta[linked].id).changes > 0) res.supersededMarked++;
          } else {
            counted = false; // edge already existed
          }
        }
        if (counted) {
          res.edgesCreated++;
          if (relation === 'contradicts') res.contradicts++; else res.supersedes++;
          if (res.samples.length < 25) {
            res.samples.push({
              from_id: meta[i].id, to_id: meta[linked].id, relation,
              from_title: meta[i].title, to_title: meta[linked].title, shared: linkedShared.slice(0, 6),
            });
          }
        }
      }
    }
  };

  if (opts.dryRun) apply();
  else db.transaction(apply)();
  return res;
}
