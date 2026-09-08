// distill-triage — keep the distill queue honest without an LLM.
//
// The Stop hook stores raw user utterances with needs_distill:true (no LLM runs in the hook
// path — anchor #70), and the agent is meant to rewrite them via recall({ dream: true }). On
// the author's machine that queue reached 389 and nobody drained it, because most of it was
// never a decision: "OK. Aからいこう", a pasted file path, "はい。そうしましょう". Asking an
// agent to distill those is asking it to find meaning that is not there.
//
// So: classify before asking. Two verdicts need no intelligence, only a rule —
//   auto-noise  the utterance carries no decision object (too short, a bare acknowledgement or
//               imperative, a path/URL/attachment reference)
//   auto-stale  never recalled and older than STALE_DAYS — whatever it was, nobody came back
//
// Both are archived, never deleted: type → note, state → superseded, distill_verdict records
// why. needs_distill stays TRUE — anchor #70 says the flag must not be dropped, and it stays
// truthful: no agent ever rewrote this row. The queue, the pending count and the boot digest
// exclude rows that carry a verdict. Layer and protection are untouched (a caveat stays a
// caveat — it just stops being asked about). Reversible: delete distill_verdict from the JSON.
//
// Measured before shipping (2026-09-07, 389 raw): noise 88, stale 51, queue 250 — and the
// noise sample was read by a human before the rule was trusted.

import type Database from 'better-sqlite3';

export const SETTLE_SECONDS = 30 * 60;   // a session still in motion is not triaged (matches dream)
export const STALE_DAYS = 90;
export const SHORT_CHARS = 40;

const ACK_ONLY = /^(ok|okay|はい|そうだね|そうですね|うん|了解|いいね|ありがとう|お願い|進めて|次いこう|やろう|それで|続けて|よし|では|じゃあ|なるほど)[\s。、.,!！]*$/i;
const ACK_LEAD = /^(ok|okay|はい|そうだね|そうですね|うん|了解|いいね|ありがとう|よし|では|じゃあ|なるほど)[\s。、.,!！]+/i;
const BARE_REF = /^(@"|@[A-Za-z]:|"?[A-Za-z]:\\|https?:\/\/)/;
const DECISION_OBJECT = /決めた|採用|確定|却下|やめ|禁止|方針|に(する|しよう)|でいこう|で行こう|decid|chose|going with|switch(ing)? to|settled on|approved|instead/i;

export type TriageVerdict = 'auto-noise' | 'auto-stale' | 'keep';

export function classifyRaw(what: string, ageDays: number, accessCount: number): { verdict: TriageVerdict; reason: string } {
  const w = (what ?? '').trim();
  if (w.length < SHORT_CHARS) return { verdict: 'auto-noise', reason: `shorter than ${SHORT_CHARS} chars` };
  if (ACK_ONLY.test(w)) return { verdict: 'auto-noise', reason: 'acknowledgement only' };
  if (BARE_REF.test(w) && w.length < 120) return { verdict: 'auto-noise', reason: 'bare path/URL reference' };
  if (ACK_LEAD.test(w) && !DECISION_OBJECT.test(w) && w.length < 80) return { verdict: 'auto-noise', reason: 'acknowledgement with no decision object' };
  if (ageDays > STALE_DAYS && accessCount === 0) return { verdict: 'auto-stale', reason: `never recalled in ${STALE_DAYS}+ days` };
  return { verdict: 'keep', reason: '' };
}

export interface TriageReport {
  scanned: number;
  noise: number;
  stale: number;
  remaining: number;
  dryRun: boolean;
  samples: { noise: string[]; stale: string[] };
}

/**
 * Walk every needs_distill memory outside the settle window and archive the ones a rule can
 * settle. Idempotent — archived rows no longer match the WHERE clause.
 */
export function triageDistillQueue(db: Database.Database, opts: { dryRun?: boolean } = {}): TriageReport {
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT id, content, access_count, created_at FROM memories
        WHERE json_valid(content)
          AND json_extract(content, '$.needs_distill') = 1
          AND json_extract(content, '$.distill_verdict') IS NULL
          AND created_at < ?`,
    )
    .all(now - SETTLE_SECONDS) as Array<{ id: number; content: string; access_count: number; created_at: number }>;

  const report: TriageReport = { scanned: rows.length, noise: 0, stale: 0, remaining: 0, dryRun: !!opts.dryRun, samples: { noise: [], stale: [] } };
  const update = db.prepare('UPDATE memories SET content = ? WHERE id = ?');

  const apply = db.transaction(() => {
    for (const r of rows) {
      let c: any;
      try { c = JSON.parse(r.content); } catch { report.remaining++; continue; }
      const what = String(c.what ?? '');
      const ageDays = (now - r.created_at) / 86400;
      const { verdict, reason } = classifyRaw(what, ageDays, r.access_count ?? 0);
      if (verdict === 'keep') { report.remaining++; continue; }
      if (verdict === 'auto-noise') report.noise++; else report.stale++;
      const bucket = report.samples[verdict === 'auto-noise' ? 'noise' : 'stale'];
      if (bucket.length < 5) bucket.push(what.replace(/\s+/g, ' ').slice(0, 80));
      if (opts.dryRun) continue;
      c.distill_verdict = verdict;
      c.distill_reason = reason;
      c.type = 'note';
      c.state = 'superseded';
      update.run(JSON.stringify(c), r.id);
    }
  });
  apply();
  return report;
}

/** Count of rows still awaiting a human/agent rewrite (outside the settle window). */
export function distillPending(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM memories
        WHERE json_valid(content) AND json_extract(content, '$.needs_distill') = 1
          AND json_extract(content, '$.distill_verdict') IS NULL AND created_at < ?`,
    )
    .get(now - SETTLE_SECONDS) as { c: number };
  return r?.c ?? 0;
}
