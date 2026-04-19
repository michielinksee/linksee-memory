// v0.1.0 feature smoke test: update_memory / list_entities / layer aliases
// / match_reasons / pagination / quality check / pin / consolidate dry-run

import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_DIR = join(homedir(), '.linksee-memory-test-v010');
process.env.LINKSEE_MEMORY_DIR = DB_DIR;
if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });

const server = spawn('node', ['dist/mcp/server.js'], {
  env: { ...process.env, LINKSEE_MEMORY_DIR: DB_DIR },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
let nextId = 1;

server.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    } catch {}
  }
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }}, 5000);
  });
}
const parse = (r) => JSON.parse(r.result.content[0].text);
const call = (name, args) => rpc('tools/call', { name, arguments: args }).then(parse);
function assert(cond, msg) {
  if (!cond) { console.error(`❌ FAIL: ${msg}`); server.kill(); process.exit(1); }
  console.log(`✓ ${msg}`);
}

async function run() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-v010', version: '1.0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // ═══ Layer aliases ═══
  const a = await call('remember', {
    entity_name: 'alpha', entity_kind: 'project',
    layer: 'decisions',
    content: 'decided to use SQLite',
  });
  assert(a.ok && a.layer === 'learning', `layer alias "decisions" → "learning" (got ${a.layer})`);

  const b = await call('remember', {
    entity_name: 'alpha', entity_kind: 'project',
    layer: 'warnings',
    content: 'do not use WAL mode on network drives',
  });
  assert(b.ok && b.layer === 'caveat', `layer alias "warnings" → "caveat" (got ${b.layer})`);

  const c = await call('remember', {
    entity_name: 'alpha', entity_kind: 'project',
    layer: 'frobnicate',
    content: 'should fail',
  });
  assert(!c.ok, 'unknown layer rejected');

  // ═══ remember quality check ═══
  const pasted = await call('remember', {
    entity_name: 'beta', entity_kind: 'project',
    layer: 'implementation',
    content: '● This is pasted assistant output with markers',
  });
  assert(pasted.rejected === 'quality_check', 'quality check rejects pasted assistant marker');

  const pastedForced = await call('remember', {
    entity_name: 'beta', entity_kind: 'project',
    layer: 'implementation',
    content: '● This is pasted assistant output with markers',
    force: true,
  });
  assert(pastedForced.ok, 'force:true bypasses quality check');

  // ═══ pin via importance:1.0 ═══
  const pinned = await call('remember', {
    entity_name: 'gamma', entity_kind: 'project',
    layer: 'goal',
    content: 'a critical goal',
    importance: 1.0,
  });
  assert(pinned.pinned === true, 'importance:1.0 marks memory as pinned');

  // ═══ update_memory ═══
  const upd = await call('update_memory', {
    memory_id: a.memory_id,
    content: 'decided to use SQLite + FTS5',
  });
  assert(upd.ok && upd.updated_fields.includes('content'), 'update_memory content OK');

  const upd2 = await call('update_memory', {
    memory_id: a.memory_id,
    layer: 'insights',
    importance: 1.0,
  });
  assert(upd2.ok && upd2.pinned === true, 'update_memory importance→1.0 pins');

  const updBad = await call('update_memory', { memory_id: 99999, content: 'X' });
  assert(!updBad.ok, 'update_memory on missing id fails');

  // ═══ list_entities ═══
  const list = await call('list_entities', {});
  assert(list.ok && list.total >= 3, `list_entities returned ${list.total} entities`);
  assert(list.entities.every(e => e.name && e.kind), 'entity rows have required fields');
  assert(list.entities.some(e => e.layer_breakdown), 'entities include layer breakdown');

  const listProjects = await call('list_entities', { kind: 'project' });
  assert(listProjects.entities.every(e => e.kind === 'project'), 'kind filter works');

  const listPinned = await call('list_entities', { min_memories: 2 });
  assert(listPinned.entities.every(e => e.memory_count >= 2), 'min_memories filter works');

  // ═══ recall match_reasons + score_breakdown ═══
  const recall1 = await call('recall', { query: 'SQLite', max_tokens: 1000 });
  assert(recall1.ok && recall1.count >= 1, `recall found ${recall1.count}`);
  const first = recall1.memories[0];
  assert(Array.isArray(first.match_reasons), 'memory has match_reasons array');
  assert(first.score_breakdown && typeof first.score_breakdown.relevance === 'number', 'score_breakdown present');
  assert(typeof first.entity.id === 'number', 'entity.id exposed');

  const recall2 = await call('recall', { query: 'SQLite', layer: 'decisions' });
  assert(recall2.resolved_layer === 'learning', `recall layer alias resolved (got ${recall2.resolved_layer})`);

  const recall3 = await call('recall', { query: 'critical goal', max_tokens: 500 });
  assert(recall3.memories.some(m => m.pinned && m.match_reasons.includes('pinned')), 'pinned memory flagged in recall');

  // ═══ recall pagination ═══
  for (let i = 0; i < 6; i++) {
    await call('remember', { entity_name: 'paginate-test', entity_kind: 'project', layer: 'implementation', content: `memory ${i}`, importance: 0.4 });
  }
  const p1 = await call('recall', { query: 'paginate-test', limit: 3, max_tokens: 5000 });
  assert(p1.count === 3, `limit=3 returns 3 (got ${p1.count})`);
  assert(p1.has_more === true, 'has_more=true when more exist');
  const p2 = await call('recall', { query: 'paginate-test', limit: 3, offset: 3, max_tokens: 5000 });
  assert(p2.count >= 1 && p2.offset === 3, `offset=3 returns next page`);
  const overlap = p1.memories.filter(m => p2.memories.some(n => n.id === m.id));
  assert(overlap.length === 0, 'pagination pages do not overlap');

  // ═══ forget: pinned preserved ═══
  const forgetPinned = await call('forget', { memory_id: a.memory_id });
  assert(forgetPinned.preserved === true, 'forget on pinned returns preserved:true');

  const forgetBad = await call('forget', { memory_id: 99999 });
  assert(!forgetBad.ok && /not found/.test(forgetBad.error), 'forget on missing id returns clear error');

  const forgetDry = await call('forget', { dry_run: true });
  assert(forgetDry.dry_run === true && Array.isArray(forgetDry.sample_ids_to_drop), 'forget dry_run returns sample ids');

  // ═══ consolidate dry_run ═══
  const consDry = await call('consolidate', { dry_run: true, min_age_days: 0 });
  assert(consDry.ok && consDry.dry_run === true, 'consolidate dry_run does not write');
  assert(typeof consDry.clusters === 'number', 'consolidate dry_run reports cluster count');

  await new Promise((resolve) => { server.once('exit', () => resolve()); server.kill(); });
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch {}

  console.log('\n🎉 v0.1.0 smoke test complete — all new features verified');
}

run().catch((e) => {
  console.error('❌ smoke failed:', e);
  server.kill();
  process.exit(1);
});
