#!/usr/bin/env node
// Regression: one `remember` call can record a decision AND make it enforceable.
//
// Guards the 2026-09-05 audit finding: "remember" and "declare_anchor" were two tools with two
// schemas, and an agent had to choose. Choosing remember stored the decision and never
// re-injected it — the exact failure the product exists to prevent. Also: remember demanded
// entity_name + entity_kind + layer, three things the agent had to invent before it could say
// "remember this". Now content is the only required field.
//
// Drives the real MCP server over stdio against a throwaway DB, so this covers the tool schema,
// the dispatcher defaults, the roots round-trip that infers the entity, and the gate seeing the
// anchor — not just a library function.
//
// Run: node test/remember-anchor.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'linksee-remember-anchor-'));
const projectDir = join(dir, 'myproj');
mkdirSync(projectDir);

const child = spawn(process.execPath, ['dist/mcp/server.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off' },
});
child.stderr.on('data', () => {}); // drain — an undrained stderr pipe blocks the child once it fills

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    // Server → client request: the entity inference asks for workspace roots. Answer it.
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
  try { return JSON.parse(text); } catch { return { _raw: text, _error: r.error }; }
};

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('remember-anchor regression');

  // 1. content alone is enough
  const plain = await call('remember', { content: 'We chose Postgres for the primary store.' });
  check('remember with only content succeeds', plain.ok === true, JSON.stringify(plain).slice(0, 160));
  check('entity inferred from the workspace root', plain.entity_inferred_from === 'workspace_root', JSON.stringify(plain.entity_inferred_from));
  check('layer defaulted to context', plain.layer === 'context', plain.layer);
  check('no anchor without asking for one', plain.anchor_id === undefined);
  const ents = await call('recall', {});
  check('…and the entity is the project name', (ents.entities ?? []).some((e) => e.name === 'myproj'), JSON.stringify((ents.entities ?? []).map((e) => e.name)));

  // 2. remember + anchor in one call
  const dec = await call('remember', {
    content: 'MongoDB is rejected for the primary store: it does not meet the strong-consistency requirement. Postgres it is.',
    anchor: { violation_signal: ['mongoose', 'MongoClient'], affects: ['src/db/**'] },
  });
  check('remember + anchor succeeds', dec.ok === true && typeof dec.anchor_id === 'number', JSON.stringify(dec).slice(0, 200));
  check('layer defaulted to learning for a decision', dec.layer === 'learning', dec.layer);
  check('kind inferred as decision when signals are given', dec.anchor_kind === 'decision', dec.anchor_kind);

  // 3. the anchor is a real anchor: check_decision finds it, with its signals
  const det = await call('check_decision', { anchor_id: dec.anchor_id });
  check('check_decision finds it', det.ok === true && det.decision?.id === dec.anchor_id);
  check('violation_signal carried through', (det.decision?.violation_signal ?? []).includes('mongoose'), JSON.stringify(det.decision?.violation_signal));
  check('a fresh anchor is ⚫ unverified, not silently aligned', det.decision?.state === 'unverified', det.decision?.state);

  // …and the memory points at it
  const rec = await call('recall', { query: 'MongoDB rejected', limit: 3 });
  const mem = (rec.memories ?? []).find((m) => m.id === dec.memory_id);
  check('the memory records its anchor_id', mem?.content?.anchor_id === dec.anchor_id, JSON.stringify(mem?.content).slice(0, 120));

  // 4. anchor without signals → an honest constraint, not a silent decision
  const cons = await call('remember', { content: 'Keep the public API surface small.', anchor: true });
  check('anchor:true without signals becomes a constraint', cons.ok === true && cons.anchor_kind === 'constraint', JSON.stringify(cons).slice(0, 160));
  check('…and says contradictions cannot be detected', /cannot be detected/.test(cons.enforced ?? ''), cons.enforced);

  // 5. explicit entity still wins
  const ent = await call('remember', { content: 'Alice prefers async reviews.', entity_name: 'Alice', entity_kind: 'person' });
  check('explicit entity respected', ent.ok === true && ent.entity_inferred_from === undefined);

  // 6. a bad anchor spec must not lose the memory
  const bad = await call('remember', { content: 'short', anchor: { kind: 'nonsense' } });
  check('memory saved even when the anchor spec is invalid', bad.ok === true && typeof bad.memory_id === 'number' && typeof bad.anchor_error === 'string', JSON.stringify(bad).slice(0, 160));
} catch (e) {
  console.log('  FAIL harness:', String(e));
  failures++;
} finally {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
