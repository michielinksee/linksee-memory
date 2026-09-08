#!/usr/bin/env node
// Regression: the distill queue is triaged by rule before an agent is asked to think.
//
// 2026-09-07: the queue on a real machine held 389 raw utterances and nobody drained it,
// because most were never decisions. Rules settle the obvious; the agent gets what is left,
// most valuable first. Archiving must never delete, never change layer, never touch a row
// inside the settle window, and must be idempotent.
//
// Run: node test/distill-triage.mjs   (throwaway DB)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-triage-'));
process.env.LINKSEE_MEMORY_DIR = dir;

const { openDb, runMigrations } = await import('../dist/db/migrate.js');
const { triageDistillQueue, classifyRaw, distillPending } = await import('../dist/lib/distill-triage.js');

const db = openDb();
runMigrations(db);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const entity = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('proj', 'project', 'proj')`).run().lastInsertRowid);
const now = Math.floor(Date.now() / 1000);
const raw = (what, { layer = 'learning', ageDays = 5, access = 0, protectedRow = 0 } = {}) =>
  Number(db.prepare(
    `INSERT INTO memories (entity_id, layer, content, importance, protected, access_count, created_at)
     VALUES (?, ?, ?, 0.7, ?, ?, ?)`,
  ).run(entity, layer, JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'decided', what, why: 'auto', needs_distill: true }), protectedRow, access, now - ageDays * 86400).lastInsertRowid);
const content = (id) => JSON.parse(db.prepare('SELECT content FROM memories WHERE id = ?').get(id).content);

console.log('distill-triage regression');

// classifier
check('short acknowledgement → noise', classifyRaw('OK. Aからいこう', 1, 0).verdict === 'auto-noise');
check('bare path → noise', classifyRaw('@"C:\\Users\\HP\\Downloads\\report.pdf" を読んで', 1, 0).verdict === 'auto-noise');
check('ack lead, no decision object → noise', classifyRaw('はい。そうしましょう。ブラウザ作業にいこうか。', 1, 0).verdict === 'auto-noise');
check('ack lead WITH a decision object → keep', classifyRaw('OK. では、Postgresを採用してMongoDBは却下、理由は強整合性。次はマイグレーション。', 1, 0).verdict === 'keep');
check('a real decision → keep', classifyRaw('O1を採用します。E1-FRはPARKED（不要見込み）とし、run固有承認・Live transport実装は後回しにする。', 1, 0).verdict === 'keep');
check('old and never recalled → stale', classifyRaw('公開前に直すべきP0は4件です。1. 評価レコードの主キーが深層の評価単位と一致していない', 120, 0).verdict === 'auto-stale');
check('old but recalled → keep', classifyRaw('公開前に直すべきP0は4件です。1. 評価レコードの主キーが深層の評価単位と一致していない', 120, 2).verdict === 'keep');

// sweep
const noise = raw('OK. Aからいこう');
const stale = raw('公開・10社パイロット展開前に直すべきP0は4件です。評価レコードの主キーが深層の評価単位と一致していない。', { ageDays: 120 });
const keep = raw('O1を採用します。E1-FRはPARKED（不要見込み）とし、run固有承認・Live transport実装は後回しにする。');
const caveat = raw('うん', { layer: 'caveat', protectedRow: 1 });
const fresh = raw('OK. 次いこう', { ageDays: 0 }); // inside the settle window

const dry = triageDistillQueue(db, { dryRun: true });
check('dry run counts without writing', dry.noise === 2 && dry.stale === 1 && dry.remaining === 1 && content(noise).distill_verdict === undefined, JSON.stringify(dry));

const rep = triageDistillQueue(db);
check('sweep archives noise and stale, keeps the decision', rep.noise === 2 && rep.stale === 1 && rep.remaining === 1, JSON.stringify(rep));
check('archived row: verdict recorded, state superseded, type note — and needs_distill stays TRUE (anchor #70: never drop the flag; no agent rewrote it)',
  (() => { const c = content(noise); return c.needs_distill === true && c.distill_verdict === 'auto-noise' && c.state === 'superseded' && c.type === 'note' && c.what === 'OK. Aからいこう'; })(), JSON.stringify(content(noise)));
check('stale row records its reason', /never recalled/.test(content(stale).distill_reason ?? ''));
check('kept row untouched', content(keep).needs_distill === true && content(keep).distill_verdict === undefined);
check('settle window respected: a fresh row is not triaged', content(fresh).distill_verdict === undefined);
check('caveat layer and protection untouched', (() => { const r = db.prepare('SELECT layer, protected FROM memories WHERE id = ?').get(caveat); return r.layer === 'caveat' && r.protected === 1; })());
check('…but the caveat noise still gets a verdict and leaves the queue', content(caveat).distill_verdict === 'auto-noise');

const again = triageDistillQueue(db);
check('idempotent: second sweep archives nothing', again.noise === 0 && again.stale === 0, JSON.stringify(again));
check('distillPending counts what remains (fresh row excluded)', distillPending(db) === 1, `${distillPending(db)}`);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
