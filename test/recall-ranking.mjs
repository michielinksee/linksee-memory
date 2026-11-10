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
//   5. Japanese one-word queries, with and without a full-width "？"; Japanese sentences (0.19.2)
//   6. superseded_hidden / consolidated_hidden with both kinds of hidden rows present
//   7. one-word query with near-equal bm25: importance decides (Codex review 1 of #30)
//   8. 1–2 character words go through the LIKE fallback; English "CI?" still finds nothing (known
//      limit), Japanese "東京？" finds its row since 0.19.2
//   9. Japanese sentences (0.19.2): one fictional person, several items, asked in natural Japanese
//      → the asked item is rank 1; katakana / kanji / alphanumeric mixes (v0.19.1 の公開日は？),
//      full-width punctuation, 1–2 character pieces, another person's same item does not win
//  10. Codex review 1 of #32 — what 0.19.1 found by the whole question is not lost to a row that
//      shares only some pieces (みずほの口座 / ひとり旅 / 決める, the other row has higher
//      importance); a 500-kanji question (499 pieces before the cap) answers instead of failing
//      with "Expression tree is too large"; "50%" and "snake_case" are literal in LIKE
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
  // A Japanese sentence has no spaces. Up to 0.19.1 it was ONE word and matched only where that
  // exact string appeared ("known limit" pinned here then: the second sentence returned nothing).
  // Since 0.19.2 the sentence is cut into pieces by script (山辺 / エディタ; の, は, 何ですか
  // dropped), so a sentence that is not a substring of the memory finds it too.
  const sentenceHit = await recall(srv, '山辺さんが普段使うエディタは？');
  check('Japanese sentence that is a substring of the memory (ending in ？) finds it', sentenceHit.memories?.[0]?.id === jp.editor,
    `rank 1 was #${sentenceHit.memories?.[0]?.id}`);
  const sentenceMiss = await recall(srv, '山辺さんのエディタは何ですか？');
  check('Japanese sentence that is not a substring of the memory finds it at rank 1 (0.19.2; was nothing)', sentenceMiss.memories?.[0]?.id === jp.editor,
    `got ${(sentenceMiss.memories ?? []).map((m) => m.id).join(',')}`);

  // 6. Hidden counts with both kinds of hidden rows, found by ONE word only. None of these rows
  // contains the person's name or any other word shared with other rows, so the only way the
  // query "dotfiles?" can reach them is the word "dotfiles" itself. Before this PR the trailing
  // "?" made that word unmatchable (FTS needs the trigram "es?", the LIKE fallback needs the
  // literal "dotfiles?"), so both hidden counts were 0; now they are 1 each. origin/main fails
  // the two count checks below.
  const oldDot = await remember(srv, 'dotfiles repository lives on the home NAS');
  const newDot = await remember(srv, 'dotfiles repository moved to a private git remote', { supersedes: oldDot });
  const { openDb } = await import('../dist/db/migrate.js');
  const db = openDb();
  const entityId = db.prepare('SELECT entity_id AS e FROM memories WHERE id = ?').get(newDot).e;
  const folded = Number(db.prepare("INSERT INTO memories (entity_id, layer, content) VALUES (?, 'context', ?)").run(entityId,
    JSON.stringify({ altitude: 'implementation', type: 'note', state: 'open', what: 'dotfiles sync runs at login', consolidated_into: newDot })).lastInsertRowid);
  const withWord = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%dotfiles%'").get().n;
  db.close();
  check('only the three rows written here contain the word', withWord === 3, `rows with the word: ${withWord}`);
  const res5 = await recall(srv, 'dotfiles?');
  const got5 = (res5.memories ?? []).map((m) => m.id);
  check('"dotfiles?" returns the current row and hides the superseded and the consolidated row',
    got5[0] === newDot && !got5.includes(oldDot) && !got5.includes(folded), `got=${got5.join(',')}`);
  check('superseded_hidden = 1 (found through the word alone, "?" trimmed)', Number(res5.superseded_hidden) === 1, `superseded_hidden=${res5.superseded_hidden}`);
  check('consolidated_hidden = 1 (found through the word alone, "?" trimmed)', Number(res5.consolidated_hidden) === 1, `consolidated_hidden=${res5.consolidated_hidden}`);
  const res6 = await recall(srv, 'dotfiles?', { include_superseded: true, include_consolidated: true });
  const got6 = (res6.memories ?? []).map((m) => m.id);
  check('include_superseded + include_consolidated show both', got6.includes(oldDot) && got6.includes(folded), `got=${got6.join(',')}`);

  // 8. Words of 1–2 characters cannot use the trigram index; they go through the LIKE fallback.
  // For an English query that is the whole query as one substring (unchanged): with a trailing
  // "?" the substring includes the mark and nothing matches — known limit, pinned here. A Japanese
  // query is cut into pieces since 0.19.2 ("？" is a separator), so "東京？" now finds its row
  // (up to 0.19.1 this check pinned "finds nothing").
  const tokyo = await remember(srv, '出張の集合場所は東京駅の丸の内北口');
  const ci = await remember(srv, 'CI runs the packed-tarball tests before publish');
  const has = async (q, id) => ((await recall(srv, q)).memories ?? []).some((m) => m.id === id);
  check('2-char Japanese "東京" finds its row (LIKE fallback)', await has('東京', tokyo));
  check('2-char English "CI" finds its row (LIKE fallback)', await has('CI', ci));
  check('"東京？" finds its row (0.19.2: the ？ separates pieces; was nothing)', (await recall(srv, '東京？')).memories?.[0]?.id === tokyo);
  check('known limit: "CI?" does not find the CI row (the LIKE substring includes the ?)', !(await has('CI?', ci)));
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
// 9. Japanese sentences (0.19.2). Fictional people and items, written for this test. Every item
// row carries the person's name, so the name alone cannot pick the row; a shortest row with only
// the name is never asked for (bm25's short-row bonus would put it first if only the name matched).
// Up to 0.19.1 every question below was one word and returned nothing or the wrong row.
{
  const dir3 = mkdtempSync(join(tmpdir(), 'linksee-recall-ranking-ja-'));
  const home3 = join(dir3, 'home');
  mkdirSync(home3);
  const srv3 = startServer({ ...env, LINKSEE_MEMORY_DIR: dir3, HOME: home3, USERPROFILE: home3 });
  const rem = async (content, who = '森川') => {
    const r = await srv3.call('remember', { content, entity_name: who, entity_kind: 'person', layer: 'context' });
    if (r.ok === false || r.memory_id === undefined) throw new Error(`remember failed: ${JSON.stringify(r).slice(0, 300)}`);
    return r.memory_id;
  };
  try {
    await srv3.ready;
    await rem('森川: 当番');
    const m = {
      editor: await rem('森川さんが普段使うエディタはZedで、配色は暗いテーマにしている'),
      hours: await rem('森川さんの作業時間帯は日本時間の午前中'),
      region: await rem('森川さんの検証環境のデプロイ先は北欧リージョン'),
      drink: await rem('森川さんの好きな飲み物はほうじ茶'),
      car: await rem('森川さんの車は青い軽自動車'),
    };
    const other = await rem('早瀬さんが使うエディタはVimで、設定は共有リポジトリにある', '早瀬');
    const rel = {
      v191date: await rem('v0.19.1 の公開日は11月10日', 'リリース'),
      v190date: await rem('v0.19.0 の公開日は11月6日', 'リリース'),
      v191fix: await rem('v0.19.1 で直した不具合は recall の順位', 'リリース'),
    };
    const asks = [
      ['editor', '森川のエディタは何？', m.editor],                       // katakana word + 2-char name
      ['editor', '森川さんが使っているエディタはなんですか', m.editor],   // hiragana question ending, no ？
      ['hours', '森川さんの作業時間帯は？', m.hours],                     // kanji word
      ['region', '森川さん、デプロイ先リージョンは？', m.region],         // full-width 、 and ？
      ['drink', '森川さんの好きな飲み物は何ですか？', m.drink],           // only 1–2 char pieces
      ['car', '森川の車は？', m.car],                                     // 1-char piece
      ['region', '北欧？', m.region],                                     // 2-char question
      ['v0.19.1 date', 'v0.19.1 の公開日は？', rel.v191date],              // alphanumeric + kanji, spaced
      ['v0.19.1 date', 'v0.19.1の公開日は？', rel.v191date],               // alphanumeric + kanji, unspaced
      ['other person', '早瀬のエディタは？', other],                       // same item, other person
    ];
    for (const [item, q, want] of asks) {
      const res = await srv3.call('recall', { query: q, mark_accessed: false });
      const top = res.memories?.[0];
      check(`Japanese sentence "${q}" → ${item} row at rank 1`, top?.id === want,
        `rank 1 was #${top?.id} (${top ? textOf(top) : 'nothing'}); order=${(res.memories ?? []).map((x) => x.id).join(',')}`);
    }
    // Rank 2 after 森川's editor for "森川のエディタは何？" must not be decided by the name alone:
    // 早瀬's editor row (the item word, other name) and 森川's other rows are both below rank 1.
    const res = await srv3.call('recall', { query: '森川のエディタは何？', mark_accessed: false, explain: true });
    const cov = (res.memories ?? []).map((x) => x.score_breakdown?.term_coverage);
    check('Japanese pieces get term coverage (rank 1 has every piece)', cov[0] === 1, `coverage=${JSON.stringify(cov)}`);
  } finally {
    await srv3.stop();
    rmSync(dir3, { recursive: true, force: true });
  }
}

// 10. Codex review 1 of #32. Each pair: the row asked for (low importance) contains the whole
// question; the other row (importance 1) shares only a piece with it. 0.19.1 (whole question as
// one word) returns the asked row first; the first CJK version dropped all Hiragana (みずほ, ひとり,
// める), kept only 口座 / 旅 / 決, and put the importance-1 row first.
{
  const dir4 = mkdtempSync(join(tmpdir(), 'linksee-recall-ranking-ja2-'));
  const home4 = join(dir4, 'home');
  mkdirSync(home4);
  const srv4 = startServer({ ...env, LINKSEE_MEMORY_DIR: dir4, HOME: home4, USERPROFILE: home4 });
  const rem = async (content, importance) => {
    const r = await srv4.call('remember', { content, entity_name: '家計メモ', entity_kind: 'concept', layer: 'context', importance });
    if (r.ok === false || r.memory_id === undefined) throw new Error(`remember failed: ${JSON.stringify(r).slice(0, 300)}`);
    return r.memory_id;
  };
  try {
    await srv4.ready;
    const pairs = [
      ['みずほの口座', await rem('みずほの口座は給与の受け取り用', 0.3), await rem('あおぞらの口座は貯蓄用', 1)],
      ['ひとり旅', await rem('ひとり旅の持ち物は小さな鞄だけ', 0.3), await rem('家族旅の予定は夏休み', 1)],
      ['決める', await rem('期限を決める会議は金曜の午後', 0.3), await rem('決算の締めは月末', 1)],
    ];
    for (const [q, want, other] of pairs) {
      const res = await srv4.call('recall', { query: q, mark_accessed: false });
      const order = (res.memories ?? []).map((x) => x.id);
      check(`"${q}": the row with the whole question is rank 1 (not the importance-1 row sharing a piece)`, order[0] === want,
        `order=${order.join(',')} want=#${want} other=#${other}`);
    }

    // 500 kanji separated by 、 → 499+ distinct pieces before the cap. Must answer, not throw.
    const kanji = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i * 3)).join('、');
    const target = await rem(`長い問いの確認用: ${kanji.slice(0, 40)}`, 0.5);
    const big = await srv4.call('recall', { query: kanji, mark_accessed: false });
    check('500-kanji question answers (no "Expression tree is too large")', Array.isArray(big.memories) && !big._error && !/too large/i.test(big._raw ?? ''),
      `got ${JSON.stringify(big).slice(0, 200)}`);
    check('500-kanji question still finds a row containing some of its pieces', (big.memories ?? []).length > 0, `target=#${target}`);

    // % and _ are literal in LIKE (were wildcards before, also in 0.19.1).
    const pct = await rem('割引の上限は50%まで', 0.5);
    const p500 = await rem('割引の上限は500円まで', 0.5);
    const snake = await rem('settings use snake_case keys', 0.5);
    const kebab = await rem('settings use snake-case keys', 0.5);
    const r50 = ((await srv4.call('recall', { query: '50%', mark_accessed: false })).memories ?? []).map((x) => x.id);
    check('"50%" finds the 50% row and not the 500 row', r50.includes(pct) && !r50.includes(p500), `got=${r50.join(',')}`);
    const rsn = ((await srv4.call('recall', { query: 'snake_case', mark_accessed: false })).memories ?? []).map((x) => x.id);
    check('"snake_case" finds snake_case and not snake-case', rsn.includes(snake) && !rsn.includes(kebab), `got=${rsn.join(',')}`);
  } finally {
    await srv4.stop();
    rmSync(dir4, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
