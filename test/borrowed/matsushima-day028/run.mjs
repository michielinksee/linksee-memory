#!/usr/bin/env node
// Borrowed benchmark: matsushima_a's Day 028 (24 questions on 3 changing-fact conversations),
// run against Linksee's public MCP tools. NOT part of CI (it downloads files); opt-in:
//
//   pnpm run build && pnpm run bench:day028      (needs Python 3 on PATH as `python` or set PYTHON)
//
// Source and permission: see README.md next to this file. The borrowed repository has no
// licence, so none of its data or code is copied here. This script downloads the original files
// at a pinned commit into a temp folder, checks their sha256, and reads them from there.
//
// Never touches ~/.linksee-memory or ~/.claude: every Linksee server runs with
// LINKSEE_MEMORY_DIR, HOME and USERPROFILE pointed at a fresh temp folder, deleted afterwards.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SERVER = join(REPO, 'dist', 'mcp', 'server.js');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const COMMIT = '2a325e42bf918b1d70ac54f815941c89a1eac6fa';
const BASE = `https://raw.githubusercontent.com/Matsushima-A-830/ai-100days/${COMMIT}/experiments/day-028`;
const PINNED = {
  'datasets.py': '531b58be410214eaa30b8d35be7f81a30811628de004cdf0e3fd5a6b40606ee5',
  'memory_methods.py': '5d0c24c3f6fa0e5e4a129f2849da74f87a90d564b69975db288fae245b8d407d',
  'run_experiment.py': '9089e10d29c0beaa33c170acaf5b686ee59d8705c3c7208738e75f68b83cf1e9',
};

const work = mkdtempSync(join(tmpdir(), 'linksee-day028-'));
const srcDir = join(work, 'borrowed');
mkdirSync(srcDir);

// ---------- 1. fetch + verify ----------
const verified = [];
for (const [name, sha] of Object.entries(PINNED)) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha) throw new Error(`sha256 mismatch for ${name}: got ${got}, pinned ${sha}`);
  writeFileSync(join(srcDir, name), bytes);
  verified.push({ name, sha: got });
  console.log(`sha256 ok  ${name}  ${got}`);
}
console.log(`fetched + verified ${verified.length} files @ ${COMMIT.slice(0, 12)}`);

// Python (and the borrowed code it imports) also gets a throwaway HOME/USERPROFILE, and no
// user site-packages, so nothing it does can reach the real home directory.
const pyHome = join(work, 'py-home');
mkdirSync(pyHome);

const py = (mode, input) => {
  const r = spawnSync(PYTHON, ['-I', join(HERE, 'bridge.py'), srcDir, mode], {
    input, encoding: 'utf8', cwd: work, env: { ...process.env, HOME: pyHome, USERPROFILE: pyHome, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (r.status !== 0) throw new Error(`bridge.py ${mode} failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
};

// ---------- 2. the author's extraction ----------
const { conversations, questions } = py('extract');

// ---------- 3. Linksee over stdio ----------
async function startServer() {
  const dir = mkdtempSync(join(work, 'db-'));
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(home); mkdirSync(project);
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LINKSEE_MEMORY_DIR: dir, HOME: home, USERPROFILE: home, LINKSEE_TELEMETRY: 'off' },
  });
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
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(project).href, name: 'day028' }] } }) + '\n');
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'bench-day028', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const stop = async () => {
    child.stdin.end();
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
    child.kill();
  };
  return { call, stop };
}

const label = (category) => category.replace('_', ' ');
const contentFor = (person, e) => `${person}'s ${label(e.category)} (turn ${e.turn}): ${e.value}`;
// Mechanical read-back: the exact shape contentFor() writes. No LLM.
const CONTENT_RE = /^(\w+)'s (home city|job|pet|favorite food) \(turn (\d+)\): (.+)$/;
// remember() in create mode stores plain text as structured JSON and recall returns the object;
// the text written is then in its `what` field. An update (memory_id) keeps plain text.
const textOf = (c) => (typeof c === 'string' ? c : c && typeof c.what === 'string' ? c.what : null);
const parse = (m) => {
  const t = textOf(m.content);
  const hit = t !== null ? CONTENT_RE.exec(t) : null;
  return hit ? { person: hit[1], category: hit[2], turn: Number(hit[3]), value: hit[4] } : null;
};

const MODES = {
  a: 'supersedes — a changed value is a new memory that supersedes the old one',
  b: 'overwrite — a changed value replaces the old memory in place (memory_id + content)',
};

async function runMode(mode) {
  const rows = [];
  const writeLog = [];
  for (const conv of conversations) {
    const srv = await startServer();
    try {
      const latest = new Map(); // category -> memory id
      for (const e of conv.events) {
        const content = contentFor(conv.person, e);
        const prev = latest.get(e.category);
        let args = { content, entity_name: conv.person, entity_kind: 'person', layer: 'context' };
        if (prev !== undefined) {
          if (mode === 'a') args.supersedes = prev;
          else args = { memory_id: prev, content };
        }
        const r = await srv.call('remember', args);
        const mid = r.memory_id ?? prev;
        if (r.ok === false || mid === undefined) writeLog.push(`${conv.id} turn ${e.turn} ${e.category}: ${JSON.stringify(r).slice(0, 200)}`);
        latest.set(e.category, mid);
      }

      for (const q of questions.filter((x) => x.conv_id === conv.id)) {
        const historical = q.type === 'historical';
        const res = await srv.call('recall', { query: q.question, ...(historical ? { include_superseded: true } : {}), mark_accessed: false });
        const mems = (res.memories ?? []).map((m, rank) => ({ rank: rank + 1, id: m.id, superseded_by: m.superseded_by, raw: m.content, p: parse(m) }));
        const mine = mems.filter((m) => m.p && m.p.person === conv.person && m.p.category === label(q.category));
        let value;
        if (!historical) {
          // current: the highest-ranked memory about this person + category in the default recall
          value = mine.length ? mine[0].p.value : null;
        } else {
          // historical: every value Linksee marks as replaced (superseded_by) — the analogue of
          // the original AppendOnlyMemory returning "all values except the latest"
          value = mine.filter((m) => m.superseded_by !== undefined).map((m) => m.p.value);
        }
        rows.push({
          q, value,
          returned: mems.map((m) => `#${m.id}${m.superseded_by !== undefined ? `→#${m.superseded_by}` : ''} ${typeof m.raw === 'string' ? m.raw : JSON.stringify(m.raw)}`),
          rank_of_first_match: mine.length ? mine[0].rank : null,
          superseded_hidden: res.superseded_hidden ?? 0,
        });
      }
    } finally {
      await srv.stop();
    }
  }
  const verdicts = py('score', JSON.stringify(rows.map((r) => ({ gold: r.q.gold, value: r.value }))));
  rows.forEach((r, i) => { r.correct = verdicts[i]; });
  return { rows, writeLog };
}

const results = {};
for (const mode of Object.keys(MODES)) results[mode] = await runMode(mode);

// ---------- 4. report ----------
// Two outputs. results.md (tracked in git) carries no borrowed text: only question ids, the
// current/historical split, verdicts, ranks and a mechanical miss-cause class. out/details.md
// (git-ignored, see .gitignore) carries the questions, golds, answers, extracted values and what
// recall returned, for whoever runs this locally.
const count = (rows, type, pick) => rows.filter((r) => r.q.type === type && pick(r)).length;
const n = (type) => questions.filter((q) => q.type === type).length;
const pct = (k, d) => `${k}/${d} (${((100 * k) / d).toFixed(2)}%)`;
const fmt = (v) => (v === null ? '—' : Array.isArray(v) ? (v.length ? v.map((x) => `\`${x}\``).join(', ') : '[]') : `\`${v}\``);
const qid = (i) => `q${String(i + 1).padStart(2, '0')}`;
const ok = (c) => (c ? 'OK' : 'MISS');
const version = JSON.parse(spawnSync(process.execPath, ['-p', `JSON.stringify(require(${JSON.stringify(join(REPO, 'package.json'))}).version)`], { encoding: 'utf8' }).stdout);

// Miss cause, decided mechanically from what the run saw (definitions also in README.md):
//   extraction — current question: Linksee returned exactly the latest value the author's
//                extraction produced, and the author's own AppendOnlyMemory misses it too
//                (the stored value is wrong). historical: values came back but none matched,
//                and AppendOnlyMemory misses it too.
//   spec       — historical question, nothing came back marked superseded_by: the storage kept
//                no previous version (overwrite in place)
//   search     — no memory about the asked person + category came back at all
//   other      — none of the above
const cause = (r) => {
  if (r.correct) return '';
  if (r.rank_of_first_match === null) return 'search';
  if (r.q.type === 'historical') {
    if (Array.isArray(r.value) && r.value.length === 0) return 'spec';
    return r.q.orig_append_only.correct ? 'other' : 'extraction';
  }
  return !r.q.orig_append_only.correct && JSON.stringify(r.value) === JSON.stringify(r.q.orig_append_only.value) ? 'extraction' : 'other';
};

const totals = [];
totals.push('| method | current (n=12) | historical (n=12) |');
totals.push('|---|---|---|');
totals.push(`| original MutatingSummaryMemory (author's code, re-run) | ${pct(count(results.a.rows, 'current', (r) => r.q.orig_mutating.correct), n('current'))} | ${pct(count(results.a.rows, 'historical', (r) => r.q.orig_mutating.correct), n('historical'))} |`);
totals.push(`| original AppendOnlyMemory (author's code, re-run) | ${pct(count(results.a.rows, 'current', (r) => r.q.orig_append_only.correct), n('current'))} | ${pct(count(results.a.rows, 'historical', (r) => r.q.orig_append_only.correct), n('historical'))} |`);
for (const [mode, desc] of Object.entries(MODES)) {
  totals.push(`| Linksee (${mode}) ${desc} | ${pct(count(results[mode].rows, 'current', (r) => r.correct), n('current'))} | ${pct(count(results[mode].rows, 'historical', (r) => r.correct), n('historical'))} |`);
}

const header = [
  `Generated by \`run.mjs\` (do not edit by hand). Linksee ${version}, source commit \`${COMMIT.slice(0, 12)}\`.`,
  '',
  'Source: matsushima_a, "Day 028" — https://zenn.dev/matsushima_a/articles/day-028-naive-rag-vs-mutating-memory',
  "(test cases borrowed with the author's permission, given in a Zenn comment on 2026-11-06).",
  'Mapping, change log and miss analysis: README.md in this folder.',
  '',
  'Fetched files (sha256 matched the values pinned in run.mjs on this run):',
  '',
  ...verified.map((v) => `- \`${v.name}\` ${v.sha}`),
  '',
];

const writeProblems = Object.keys(MODES).flatMap((mode) => (results[mode].writeLog.length ? [`Write problems in (${mode}): ${results[mode].writeLog.length} (details in out/details.md)`, ''] : []));

// --- tracked: results.md ---
const T = ['# Day 028 borrowed benchmark — Linksee results', '', ...header, '## Totals', '', ...totals, '', ...writeProblems];
T.push('## Per question');
T.push('');
T.push('Ids follow the order of the original question list. Rank = position, in what recall returned, of the first memory about the asked person and category (— if none came back). Cause classes: README.md. The questions, answers and values themselves are not stored here; run `pnpm run bench:day028` locally and see out/details.md.');
T.push('');
T.push('| id | type | orig Mut | orig App | Linksee (a) | rank (a) | cause (a) | Linksee (b) | rank (b) | cause (b) |');
T.push('|---|---|---|---|---|---|---|---|---|---|');
questions.forEach((q, i) => {
  const a = results.a.rows[i], b = results.b.rows[i];
  T.push(`| ${qid(i)} | ${q.type} | ${ok(q.orig_mutating.correct)} | ${ok(q.orig_append_only.correct)} | ${ok(a.correct)} | ${a.rank_of_first_match ?? '—'} | ${cause(a)} | ${ok(b.correct)} | ${b.rank_of_first_match ?? '—'} | ${cause(b)} |`);
});
T.push('');
T.push('Miss causes:');
T.push('');
for (const mode of Object.keys(MODES)) {
  const tally = {};
  for (const r of results[mode].rows) { const c = cause(r); if (c) tally[c] = (tally[c] ?? 0) + 1; }
  T.push(`- (${mode}): ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
}
T.push('');

// --- not tracked: out/details.md ---
const D = ['# Day 028 borrowed benchmark — local details', '', 'NOT for git: this file contains the borrowed questions, golds and values (out/ is git-ignored).', '', ...header, '## Totals', '', ...totals, ''];
for (const mode of Object.keys(MODES)) for (const w of results[mode].writeLog) D.push(`- write problem (${mode}): ${w}`);
D.push('## Per question');
D.push('');
D.push('| id | conv | category | type | question | gold | Linksee (a) | cause (a) | Linksee (b) | cause (b) |');
D.push('|---|---|---|---|---|---|---|---|---|---|');
questions.forEach((q, i) => {
  const a = results.a.rows[i], b = results.b.rows[i];
  D.push(`| ${qid(i)} | ${q.conv_id} | ${q.category} | ${q.type} | ${q.question} | \`${q.gold}\` | ${ok(a.correct)} ${fmt(a.value)} | ${cause(a)} | ${ok(b.correct)} ${fmt(b.value)} | ${cause(b)} |`);
});
D.push('');
D.push("## Extracted fact stream (author's process_conversation_facts)");
D.push('');
for (const c of conversations) D.push(`- ${c.id}: ${c.events.map((e) => `t${e.turn} ${e.category}=\`${e.value}\``).join('; ')}`);
D.push('');
D.push('## What recall returned on each miss');
D.push('');
for (const mode of Object.keys(MODES)) {
  D.push(`### (${mode})`);
  D.push('');
  results[mode].rows.forEach((r, i) => {
    if (r.correct) return;
    D.push(`- ${qid(i)} ${r.q.conv_id} ${r.q.category} ${r.q.type} [${cause(r)}] — gold \`${r.q.gold}\`, answered ${fmt(r.value)}; first match at rank ${r.rank_of_first_match ?? '—'}; superseded_hidden=${r.superseded_hidden}`);
    for (const line of r.returned) D.push(`  - ${line}`);
  });
  D.push('');
}

const out = join(HERE, 'results.md');
writeFileSync(out, T.join('\n'));
mkdirSync(join(HERE, 'out'), { recursive: true });
const detail = join(HERE, 'out', 'details.md');
writeFileSync(detail, D.join('\n'));
console.log(totals.join('\n'));
console.log(`\nwrote ${out} (tracked: ids and verdicts only)\nwrote ${detail} (git-ignored: full details)`);
rmSync(work, { recursive: true, force: true });
