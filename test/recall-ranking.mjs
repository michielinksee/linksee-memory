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

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

function startServer() {
  const child = spawn(process.execPath, ['dist/mcp/server.js'], { stdio: ['pipe', 'pipe', 'pipe'], env });
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
} finally {
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
