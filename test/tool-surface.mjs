#!/usr/bin/env node
// Regression: six tools on the surface, eleven that answer.
//
// Roadmap 5 (2026-09-07). Anchor #1 said "3 tools, never a 4th" because eight tools bled
// model-dependent behaviour across hosts; the surface had crept to eleven. Five are folded
// into the six and hidden from tools/list — but a call to any of them must still work, so a
// skill or agent written against 0.14 does not break. This drives the real server over stdio
// twice: once as a normal client, once with LINKSEE_LEGACY_TOOLS=1.
//
// Run: node test/tool-surface.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

async function withServer(dir, extraEnv, fn) {
  const projectDir = join(dir, 'myproj');
  try { mkdirSync(projectDir); } catch {}
  const child = spawn(process.execPath, ['dist/mcp/server.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off', ...extraEnv },
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
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(projectDir).href, name: 'myproj' }] } }) + '\n');
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
    try { return JSON.parse(text); } catch { return { _raw: text, _error: r.error, _isError: r.result?.isError }; }
  };
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await fn({ rpc, call });
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
}

const SIX = ['recall', 'remember', 'read_smart', 'drift_status', 'declare_anchor', 'resolve_drift'];
const LEGACY = ['where_am_i', 'check_decision', 'flag_proposals', 'dream', 'resolve_proposal'];

const dir = mkdtempSync(join(tmpdir(), 'linksee-surface-'));
console.log('tool-surface regression');

// Seed a raw-utterance backlog before the server starts, so the startup triage has work to do.
{
  process.env.LINKSEE_MEMORY_DIR = dir;
  const { openDb, runMigrations } = await import('../dist/db/migrate.js');
  const db = openDb();
  runMigrations(db);
  const entity = Number(db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('seedproj', 'project', 'seedproj')`).run().lastInsertRowid);
  const ins = db.prepare(`INSERT INTO memories (entity_id, layer, content, importance, protected, access_count, created_at) VALUES (?, 'learning', ?, 0.7, 0, 0, unixepoch() - 7200)`);
  const raw = (what) => ins.run(entity, JSON.stringify({ altitude: 'implementation', type: 'decision', state: 'decided', what, why: 'auto', needs_distill: true }));
  for (let i = 0; i < 10; i++) raw(`決定${i}: この件は案Bを採用し、案Aは却下する。理由は運用コストが半分で済み、移行が段階的にできるため。`);
  raw('OK. Aからいこう');
  raw('はい。そうしましょう。');
  db.close();
  delete process.env.LINKSEE_MEMORY_DIR;
}

try {
  await withServer(dir, {}, async ({ rpc, call }) => {
    // ── the surface ──
    const list = (await rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    check('tools/list shows exactly the six', JSON.stringify(list) === JSON.stringify([...SIX].sort()), list.join(','));

    // ── hidden but answering ──
    const dec = await call('remember', { content: 'Postgres for the primary store; MongoDB rejected on consistency.', anchor: { violation_signal: ['mongoose'] } });
    check('setup: remember+anchor', dec.ok === true && typeof dec.anchor_id === 'number');
    const legacy = await call('check_decision', { anchor_id: dec.anchor_id });
    check('legacy check_decision still answers', legacy.ok === true && legacy.decision?.id === dec.anchor_id, JSON.stringify(legacy).slice(0, 120));

    // ── absorptions ──
    const viaStatus = await call('drift_status', { anchor_id: dec.anchor_id });
    check('drift_status({ anchor_id }) == check_decision', viaStatus.ok === true && viaStatus.decision?.id === dec.anchor_id);

    const brief = await call('recall', {});
    check('recall() is the session brief', brief.brief === true && typeof brief.triage === 'string' && Array.isArray(brief.attention) && Array.isArray(brief.entities), JSON.stringify(brief).slice(0, 160));
    check('brief carries open loops as counts', brief.open_loops && typeof brief.open_loops.proposals === 'number' && typeof brief.open_loops.distill_queue === 'number', JSON.stringify(brief.open_loops));
    check('brief names the next calls', Array.isArray(brief.next) && brief.next.some((n) => /dream: true/.test(n)));

    const overview = await call('recall', { overview: true });
    check('recall({ overview: true }) is the old entity list', Array.isArray(overview.entities) && overview.brief === undefined);

    const where = await call('recall', { where: 'anything' });
    check('recall({ where }) answers as where_am_i does', where.ok === true && ('located' in where), JSON.stringify(where).slice(0, 120));

    // Triage needs a frame: without a North Star, recall({ dream: true }) returns no candidates
    // and says to declare one. That is deliberate — check it, then declare one.
    const framed = await call('recall', { dream: true });
    check('dream without a North Star says so instead of guessing', framed.north_star === null && /North Star/.test(framed.message ?? framed.guide ?? JSON.stringify(framed)), JSON.stringify(framed).slice(0, 140));
    const ns = await call('declare_anchor', { kind: 'decision', node_type: 'north_star', domain: 'strategy', statement: 'North Star: local-first memory for solo devs; current phase = launch', rationale: 'test frame', violation_signal: ['cloud-only'] });
    check('a North Star can be declared', ns.ok === true && typeof ns.anchor_id === 'number', JSON.stringify(ns).slice(0, 120));

    const prop = await call('declare_anchor', { kind: 'proposal', statement: '[未解決] LinkedIn B2B outreach to CTOs', rationale: 'presented three channels; only X was taken', domain: 'growth', siblings: ['X', 'LinkedIn', 'Dev community'], decided: 'X' });
    check('declare_anchor({ kind: "proposal" }) records a review item', prop.ok === true && typeof prop.anchor_id === 'number' && typeof prop.candidate_id === 'number', JSON.stringify(prop).slice(0, 160));

    const dream = await call('recall', { dream: true });
    check('recall({ dream: true }) is the full triage set', dream.ok === true && 'candidates' in dream && 'distill_queue' in dream, Object.keys(dream).join(','));

    // The startup sweep must have run: 12 raw rows seeded, 2 were acknowledgements.
    check('startup triage archived the acknowledgements (distill_total is the real remainder)', dream.distill_total === 10, `distill_total=${dream.distill_total}`);
    check('distill_shown is the page, not the total', dream.distill_shown === 8, `shown=${dream.distill_shown}`);
    const drain = await call('recall', { dream: true, distill: 3 });
    check('recall({ dream: true, distill: 3 }) caps the page at 3', drain.distill_shown === 3 && drain.distill_queue.length === 3 && drain.distill_total === 10, `shown=${drain.distill_shown} total=${drain.distill_total}`);
    check('…and lists the new proposal', JSON.stringify(dream.candidates).includes(String(prop.candidate_id)), JSON.stringify(dream.candidates).slice(0, 160));

    const wrong = await call('resolve_drift', { candidate_id: prop.candidate_id, action: 'fix', rationale: 'x' });
    check('a proposal rejects anchor-only actions', wrong.ok === false && /surface|dismiss/.test(wrong.error ?? ''), JSON.stringify(wrong).slice(0, 120));
    const noWhy = await call('resolve_drift', { candidate_id: prop.candidate_id, action: 'dismiss' });
    check('a proposal verdict needs a rationale', noWhy.ok === false && /rationale/.test(noWhy.error ?? ''));
    const verdict = await call('resolve_drift', { candidate_id: prop.candidate_id, action: 'dismiss', rationale: 'ICP is solo devs; enterprise outreach is out of phase' });
    check('resolve_drift({ candidate_id, action }) resolves it', verdict.ok === true, JSON.stringify(verdict).slice(0, 160));
    const after = await call('recall', { dream: true });
    check('…and it leaves the triage set', !JSON.stringify(after.candidates).includes(`"candidate_id":${prop.candidate_id}`) && !JSON.stringify(after.candidates).includes(`"id":${prop.candidate_id}`), JSON.stringify(after.candidates).slice(0, 120));

    const onAnchor = await call('resolve_drift', { anchor_id: dec.anchor_id, action: 'surface', rationale: 'x' });
    check("'surface' is not accepted for an anchor", onAnchor.ok !== true, JSON.stringify(onAnchor).slice(0, 120));
  });

  await withServer(dir, { LINKSEE_LEGACY_TOOLS: '1' }, async ({ rpc }) => {
    const tools = (await rpc('tools/list', {})).result.tools;
    const names = tools.map((t) => t.name).sort();
    check('LINKSEE_LEGACY_TOOLS=1 lists all eleven', JSON.stringify(names) === JSON.stringify([...SIX, ...LEGACY].sort()), names.join(','));
    const d = tools.find((t) => t.name === 'dream');
    check('legacy descriptions point at the replacement', /legacy/.test(d.description) && /recall\(\{ dream: true \}\)/.test(d.description), (d.description || '').slice(0, 100));
  });
} catch (e) {
  console.log('  FAIL harness:', String(e));
  failures++;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
