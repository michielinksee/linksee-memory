#!/usr/bin/env node
// Regression (0.19.1 candidate): recall ranks the memory that matches the asked words first.
//
// Guards the 2026-11-10 finding (PR #29 bench): with several memories about one person, a name
// that appears in all of them plus an OR query meant every row matched on the name alone, and
// sentence punctuation glued to the key word ("…editor?") made that word unmatchable. The asked
// item came first only when it happened to be the shortest row.
//
// Cases are written by hand for this test (no wording from any borrowed benchmark):
//   1. one person, four items → asking for an item by its words puts that item at rank 1
//   2. a memory with every asked word ranks above ones with only some of them
//   3. a superseded memory stays hidden by default and comes back with include_superseded
//   4. words with symbols inside (v0.19.0, #21, .env, C++) still find their row
//   5. Japanese one-word queries, with and without a full-width "？"; the sentence limit
//   6. superseded_hidden / consolidated_hidden with both kinds of hidden rows present
//   7. one-word query with near-equal bm25: importance decides (Codex review 1 of #30)
//
// Drives the real MCP server over stdio against a throwaway DB and HOME. Never touches
// ~/.linksee-memory or ~/.claude.
//
// Run: node test/recall-ranking.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'linksee-recall-ranking-'));
const home = join(dir, 'home');
mkdirSync(home);
const env = { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', HOME: home, USERPROFILE: home };
process.env.LINKSEE_MEMORY_DIR = dir; // for the in-process DB write in case 6 (read at import time)

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

function startServer(serverEnv = env) {
  const child = spawn(process.execPath, ['dist/mcp/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: serverEnv });
  child.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'roots/list' && m.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [] } }) + '\n');
        continue;
      }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const my = ++id;
    const t = setTimeout(() => { pending.delete(my); rej(new Error(`timeout: ${method}`)); }, 30000);
    pending.set(my, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return { _raw: text, _error: r.error }; }
  };
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  const stop = async () => {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  };
  return { call, ready, stop };
}

const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content?.what ?? JSON.stringify(m.content));
const remember = async (srv, content, extra = {}) => {
  const r = await srv.call('remember', { content, entity_name: 'Ottoline Varga', entity_kind: 'person', layer: 'context', ...extra });
  if (r.ok === false || r.memory_id === undefined) throw new Error(`remember failed: ${JSON.stringify(r).slice(0, 300)}`);
  return r.memory_id;
};
const recall = (srv, query, extra = {}) => srv.call('recall', { query, mark_accessed: false, ...extra });

const srv = startServer();
try {
  console.log('recall-ranking regression');
  await srv.ready;

  // 1. One person, four items. The name is in every row; the item words are in one row each.
  // A fifth, shortest row is never asked for: a ranker that only sees the shared name falls back
  // to bm25's short-document bonus and puts that row first.
  await remember(srv, "Ottoline Varga: on call");
  const ids = {
    editor: await remember(srv, "Ottoline Varga's preferred code editor for long refactoring sessions on the monorepo is Helix with a custom keymap"),
    timezone: await remember(srv, "Ottoline Varga's working timezone: UTC+9"),
    region: await remember(srv, "Ottoline Varga's deploy region for staging: eu-north"),
    review: await remember(srv, "Ottoline Varga's code review habit: small diffs only"),
  };

  const asks = [
    ['editor', 'Which code editor does Ottoline Varga prefer?'],
    ['timezone', 'What is Ottoline Varga\'s timezone?'],
    ['region', 'Ottoline Varga deploy region?'],
    ['review', 'How does Ottoline Varga do code review?'],
  ];
  for (const [item, q] of asks) {
    const res = await recall(srv, q);
    const top = res.memories?.[0];
    check(`item "${item}" is rank 1 when asked by its words`, top?.id === ids[item],
      `rank 1 was #${top?.id} (${top ? textOf(top) : 'nothing'})`);
  }

  // 2. Every asked word beats some of them. `partial` repeats the two rarest words and is short,
  // so plain bm25 (term frequency, short-document bonus) favours it; `full` has all four once in
  // a long row, and two of its words also appear in other rows.
  const full = await remember(srv, 'The quarterly ledger reconciliation script for the finance team now also exports a variance report, runs after the month-end close, and posts a summary to the shared channel when it is done');
  const partial = await remember(srv, 'Ledger reconciliation: ledger reconciliation.');
  for (const t of ['Variance in the build times went down after caching', 'Latency variance alert tuned', 'Variance budget for the load test', 'CSV exports moved to the worker', 'Nightly exports are gzip now', 'exports bucket renamed']) {
    await remember(srv, t);
  }
  const res2 = await recall(srv, 'ledger reconciliation variance exports');
  const order = (res2.memories ?? []).map((m) => m.id);
  check('a row with every asked word ranks above rows with only some', order.indexOf(full) === 0 && order.indexOf(partial) > 0,
    `order=${order.join(',')} full=#${full} partial=#${partial}`);

  // 3. Supersede: the old value is hidden by default, the new one is rank 1.
  const newer = await remember(srv, "Ottoline Varga's working timezone: UTC+1 since the move", { supersedes: ids.timezone });
  const res3 = await recall(srv, 'Ottoline Varga timezone');
  const got3 = (res3.memories ?? []).map((m) => m.id);
  check('superseded memory is not returned by default', !got3.includes(ids.timezone), `got=${got3.join(',')}`);
  check('the superseding memory is rank 1', got3[0] === newer, `got=${got3.join(',')} newer=#${newer}`);
  check('superseded_hidden counts it', Number(res3.superseded_hidden) >= 1, `superseded_hidden=${res3.superseded_hidden}`);
  const res4 = await recall(srv, 'Ottoline Varga timezone', { include_superseded: true });
  const got4 = (res4.memories ?? []).map((m) => m.id);
  check('include_superseded brings it back', got4.includes(ids.timezone) && got4.includes(newer), `got=${got4.join(',')}`);
  // 4. Symbols inside a word survive the edge-punctuation trim and still find their row.
  const sym = {
    'v0.19.0': await remember(srv, 'Tagged v0.19.0 after the driver swap'),
    '#21': await remember(srv, 'Discussion #21 asked for a quieter boot digest'),
    '.env': await remember(srv, 'Never commit the .env file of the billing worker'),
    'C++': await remember(srv, 'The image resizer is written in C++ and built by cmake'),
  };
  for (const [word, id] of Object.entries(sym)) {
    for (const q of [word, `${word}?`]) {
      const res = await recall(srv, q);
      check(`symbol query "${q}" finds its row at rank 1`, res.memories?.[0]?.id === id,
        `rank 1 was #${res.memories?.[0]?.id} (${res.memories?.[0] ? textOf(res.memories[0]) : 'nothing'})`);
    }
  }

  // 5. Japanese (hand-written). One word of 3+ chars, with and without a full-width "？".
  const jp = {
    editor: await remember(srv, '山辺さんが普段使うエディタはHelixで、キー配置は自分で変えている'),
    timezone: await remember(srv, '山辺さんの作業時間帯は日本時間'),
    region: await remember(srv, '山辺さんの検証環境のデプロイ先は北欧リージョン'),
  };
  for (const q of ['エディタ', 'エディタ？', 'リージョン', 'リージョン？']) {
    const res = await recall(srv, q);
    const want = q.startsWith('エディタ') ? jp.editor : jp.region;
    check(`Japanese one-word query "${q}" → its row at rank 1`, res.memories?.[0]?.id === want,
      `rank 1 was #${res.memories?.[0]?.id}`);
  }
  const a = (await recall(srv, 'エディタ')).memories?.map((m) => m.id).join(',');
  const b = (await recall(srv, 'エディタ？')).memories?.map((m) => m.id).join(',');
  check('a trailing "？" does not change the Japanese result order', a === b, `${a} vs ${b}`);
  // Known limit (unchanged by this PR): a Japanese sentence has no spaces, so it is ONE word and
  // matches only where that exact string appears. Before this PR a sentence ending in "？" never
  // matched at all; now the "？" is trimmed, so a sentence that is a substring of the memory hits,
  // and one that is not still returns nothing — the same as before, not worse.
  const sentenceHit = await recall(srv, '山辺さんが普段使うエディタは？');
  check('Japanese sentence that is a substring of the memory (ending in ？) finds it', sentenceHit.memories?.[0]?.id === jp.editor,
    `rank 1 was #${sentenceHit.memories?.[0]?.id}`);
  const sentenceMiss = await recall(srv, '山辺さんのエディタは何ですか？');
  check('Japanese sentence that is not a substring returns nothing (known limit, as before)', (sentenceMiss.memories ?? []).length === 0,
    `got ${(sentenceMiss.memories ?? []).map((m) => m.id).join(',')}`);

  // 6. Hidden counts with both kinds of hidden rows. "timezone?" now matches (before this PR the
  // "?" made it unmatchable, so only the name counted). The hidden rows that contain an asked word
  // are exactly: the superseded timezone row (#ids.timezone) and the consolidated row below.
  const { openDb } = await import('../dist/db/migrate.js');
  const db = openDb();
  const entityId = db.prepare('SELECT entity_id AS e FROM memories WHERE id = ?').get(ids.timezone).e;
  const folded = Number(db.prepare("INSERT INTO memories (entity_id, layer, content) VALUES (?, 'context', ?)").run(entityId,
    JSON.stringify({ altitude: 'implementation', type: 'note', state: 'open', what: 'Ottoline Varga timezone note, folded into a summary', consolidated_into: newer })).lastInsertRowid);
  const expectSup = db.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE (m.content LIKE '%timezone%' OR m.content LIKE '%Ottoline%')
    AND (COALESCE(m.mem_state,'') = 'superseded' OR EXISTS (SELECT 1 FROM memory_edges me WHERE me.to_memory_id = m.id AND me.relation = 'supersedes'))`).get().n;
  db.close();
  const res5 = await recall(srv, 'Ottoline Varga timezone?');
  const got5 = (res5.memories ?? []).map((m) => m.id);
  check('default recall hides the superseded and the consolidated row', !got5.includes(ids.timezone) && !got5.includes(folded), `got=${got5.join(',')}`);
  check('superseded_hidden = the superseded rows that contain an asked word', Number(res5.superseded_hidden) === expectSup && expectSup === 1,
    `superseded_hidden=${res5.superseded_hidden} expected=${expectSup}`);
  check('consolidated_hidden = 1 (the folded row)', Number(res5.consolidated_hidden) === 1, `consolidated_hidden=${res5.consolidated_hidden}`);
  const res6 = await recall(srv, 'Ottoline Varga timezone?', { include_superseded: true, include_consolidated: true });
  const got6 = (res6.memories ?? []).map((m) => m.id);
  check('include_superseded + include_consolidated show both', got6.includes(ids.timezone) && got6.includes(folded), `got=${got6.join(',')}`);
} finally {
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
}

// 7. One-word query, two rows that both contain the word once (a word in every row of a small
// store: FTS5 clamps its IDF, so bm25 differs only by ~1e-7 with row length). Relevance is then
// effectively equal and importance must decide: the long pinned caveat stays above the short
// low-importance note (Codex review 1 of #30: min-max normalisation turned that 1e-7 into 0.2).
{
  const dir2 = mkdtempSync(join(tmpdir(), 'linksee-recall-ranking-imp-'));
  const home2 = join(dir2, 'home');
  mkdirSync(home2);
  const srv2 = startServer({ ...env, LINKSEE_MEMORY_DIR: dir2, HOME: home2, USERPROFILE: home2 });
  try {
    await srv2.ready;
    const longCaveat = await remember(srv2, 'Pagination: the export endpoint silently caps at 500 rows unless the cursor is passed back on every call, and the cap is not documented anywhere in the client library or the changelog', { layer: 'caveat', importance: 1 });
    const shortNote = await remember(srv2, 'Pagination note', { importance: 0.2 });
    const res = await recall(srv2, 'pagination', { explain: true });
    const order = (res.memories ?? []).map((m) => m.id);
    check('one-word query, near-equal relevance: higher importance ranks first', order[0] === longCaveat && order.includes(shortNote),
      `order=${order.join(',')} caveat=#${longCaveat} note=#${shortNote} ${JSON.stringify((res.memories ?? []).map((m) => m.score_breakdown))}`);
  } finally {
    await srv2.stop();
    rmSync(dir2, { recursive: true, force: true });
  }
}
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
