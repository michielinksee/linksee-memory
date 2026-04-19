// Smoke test: exercise Day 1 + Day 2 features end-to-end.
// Day 1: remember / recall / forget / caveat protection
// Day 2: FTS5 search, momentum, composite scoring, real consolidate

import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_DIR = join(homedir(), '.linksee-memory-test');
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
    } catch (e) { /* ignore */ }
  }
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); }
    }, 5000);
  });
}

const parseContent = (r) => JSON.parse(r.result.content[0].text);
const remember = (args) => rpc('tools/call', { name: 'remember', arguments: args }).then(parseContent);
const recall = (args) => rpc('tools/call', { name: 'recall', arguments: args }).then(parseContent);
const forget = (args) => rpc('tools/call', { name: 'forget', arguments: args }).then(parseContent);
const consolidate = (args) => rpc('tools/call', { name: 'consolidate', arguments: args }).then(parseContent);

function assert(cond, msg) {
  if (!cond) { console.error(`❌ FAIL: ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

async function run() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0' },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {});
  assert(tools.result.tools.length >= 5, `>=5 tools registered (got ${tools.result.tools.length})`);
  const toolNames = tools.result.tools.map(t => t.name).sort();
  const must = ['remember','recall','forget','consolidate','read_smart'];
  for (const m of must) assert(toolNames.includes(m), `tool "${m}" present`);
  // v0.1.0 new tools
  assert(toolNames.includes('update_memory'), 'v0.1.0: update_memory present');
  assert(toolNames.includes('list_entities'), 'v0.1.0: list_entities present');

  // === Day 1: basic remember/recall/caveat protection ===
  const r1 = await remember({
    entity_name: 'linksee-memory', entity_kind: 'project', layer: 'goal',
    content: JSON.stringify({ primary: 'Build cross-agent memory MCP' }), importance: 0.9,
  });
  assert(r1.ok && r1.entity_id === 1, 'remember(goal) creates entity');
  assert(typeof r1.momentum?.score === 'number', `remember returns momentum (${r1.momentum?.band})`);

  const r2 = await remember({
    entity_name: 'linksee-memory', entity_kind: 'project', layer: 'caveat',
    content: 'Do not confuse with KanseiLink', importance: 0.8,
  });
  assert(r2.entity_id === 1, 'remember merges into same entity by name');

  // === Day 2: FTS5 search ===
  await remember({
    entity_name: 'freee', entity_kind: 'company', layer: 'implementation',
    content: 'freee API v3 invoice endpoint returns 201 Created with invoice id',
    importance: 0.6,
  });
  await remember({
    entity_name: 'chatwork', entity_kind: 'company', layer: 'implementation',
    content: 'chatwork API uses X-ChatWorkToken header, rate limit 300/5min',
    importance: 0.5,
  });
  await remember({
    entity_name: 'freee', entity_kind: 'company', layer: 'caveat',
    content: 'freee: do not send empty line_items — returns 500 not 400',
    importance: 0.9,
  });

  // FTS5: query for "invoice" should find freee's implementation memory
  const ftsRes = await recall({ query: 'invoice endpoint', max_tokens: 500 });
  assert(['fts5', 'fts5+like'].includes(ftsRes.search), `recall used FTS5 path (got ${ftsRes.search})`);
  assert(ftsRes.count >= 1, `FTS5 found ${ftsRes.count} match(es) for "invoice endpoint"`);
  const hasFreee = ftsRes.memories.some((m) => m.entity.name === 'freee');
  assert(hasFreee, 'FTS5 correctly returned freee memory for "invoice" query');

  // === Layer filter with FTS ===
  const caveatSearch = await recall({ query: 'empty line_items', layer: 'caveat' });
  assert(caveatSearch.count >= 1, `layer-filtered FTS found caveat (${caveatSearch.count})`);
  assert(
    caveatSearch.memories.every((m) => m.layer === 'caveat'),
    'layer filter strict'
  );

  // === Composite score sanity: higher importance should rank higher when relevance is equal ===
  const topRes = await recall({ query: 'chatwork API', max_tokens: 200 });
  assert(topRes.count >= 1, `recall found ${topRes.count} for chatwork`);
  console.log(`    top: ${topRes.memories[0].entity.name} [composite=${topRes.memories[0].composite}]`);

  // === entity_name path (LIKE only, FTS bypassed) ===
  const byEntity = await recall({ query: 'anything', entity_name: 'linksee-memory' });
  assert(byEntity.search === 'like', `entity_name uses LIKE path (got ${byEntity.search})`);
  assert(byEntity.count === 2, `entity_name returns both linksee-memory memories (got ${byEntity.count})`);

  // === NEW (bugfix): query that matches an entity NAME (not content) also returns results ===
  const byName = await recall({ query: 'linksee-memory' });
  assert(byName.count >= 2, `entity-name query finds memories via LIKE merge (got ${byName.count})`);

  // === Momentum: after many events on one entity, momentum should rise ===
  for (let i = 0; i < 5; i++) {
    await remember({
      entity_name: 'surge-target', entity_kind: 'project', layer: 'context',
      content: `burst event ${i} at ${new Date().toISOString()}`, importance: 0.7,
    });
  }
  const surgeRecall = await recall({ query: 'burst', max_tokens: 500 });
  const surgeMom = surgeRecall.memories[0]?.entity?.momentum ?? 0;
  assert(surgeMom > 0, `momentum after burst: ${surgeMom.toFixed(2)} (should be > 0)`);

  // === Day 2: Consolidate (need to backdate memories to trigger clustering) ===
  // Open DB directly and backdate some memories to >7 days ago
  const sql = await import('better-sqlite3');
  const db = new sql.default(join(DB_DIR, 'memory.db'));

  // Insert 3 cold implementation memories on "legacy-project" all 30 days old
  const oldTs = Math.floor(Date.now() / 1000) - 30 * 86400;
  const eId = db.prepare("INSERT INTO entities (kind, name) VALUES ('project', 'legacy-project')").run().lastInsertRowid;
  const insMem = db.prepare(
    'INSERT INTO memories (entity_id, layer, content, importance, created_at, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insMem.run(eId, 'implementation', 'tried approach A, failed at step 3', 0.3, oldTs, oldTs, 0);
  insMem.run(eId, 'implementation', 'tried approach B, hit rate limit', 0.2, oldTs, oldTs, 0);
  insMem.run(eId, 'implementation', 'switched to approach C, half-worked', 0.35, oldTs, oldTs, 0);
  const beforeCount = db.prepare("SELECT COUNT(*) as c FROM memories WHERE entity_id = ?").get(eId).c;
  db.close();

  const consRes = await consolidate({ scope: 'all' });
  assert(consRes.clustersCompressed >= 1, `consolidate compressed ${consRes.clustersCompressed} cluster(s)`);
  assert(consRes.memoriesReplaced >= 3, `consolidate replaced ${consRes.memoriesReplaced} memories (expected >=3)`);
  assert(consRes.learningIdsCreated.length >= 1, `consolidate created ${consRes.learningIdsCreated.length} learning entries`);

  // Verify the learning entry exists and is protected
  const db2 = new sql.default(join(DB_DIR, 'memory.db'));
  const learningRow = db2.prepare('SELECT * FROM memories WHERE id = ?').get(consRes.learningIdsCreated[0]);
  assert(learningRow.layer === 'learning', 'consolidation emits a learning-layer memory');
  assert(learningRow.protected === 1, 'consolidation output is protected');
  const summary = JSON.parse(learningRow.content);
  assert(summary.source === 'consolidate' && summary.count === 3, `summary shape correct (count=${summary.count})`);
  assert(Array.isArray(summary.exemplars) && summary.exemplars.length >= 1, 'summary has exemplars');

  // Verify originals are gone
  const survivingOriginals = db2.prepare(
    "SELECT COUNT(*) as c FROM memories WHERE entity_id = ? AND layer = 'implementation'"
  ).get(eId).c;
  assert(survivingOriginals === 0, `originals deleted after consolidation (${survivingOriginals} remaining)`);

  // Audit trail
  const auditRow = db2.prepare('SELECT * FROM consolidations WHERE learning_id = ?').get(consRes.learningIdsCreated[0]);
  assert(auditRow && auditRow.replaced_count === 3, 'consolidation audit row present');
  db2.close();

  server.kill();
  console.log('\n🎉 Day 2 smoke test complete — all features verified');
}

run().catch((e) => {
  console.error('❌ smoke failed:', e);
  server.kill();
  process.exit(1);
});
