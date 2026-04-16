// THE TEST: simulate a fresh agent session asking the imported memory.
// Goal: prove we did NOT hit the Mem0 wall (flat tags without context).
//
// Each query exercises a DIFFERENT axis of the memory system:
//   1. Project-level recall — "what is Card_Navi about?"
//   2. File-level recall — "what was the last work on supabase.js?"
//   3. Goal-level recall — "what were the goals for Card_Navi?"
//   4. Caveat-level recall — "what should I avoid?"
//   5. File→memory join via session_file_edits — "show me edits to migrate.ts with their why"

import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_PATH = join(homedir(), '.linksee-memory', 'memory.db');

const server = spawn('node', ['dist/mcp/server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });

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

const rpc = (method, params) => {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }}, 8000);
  });
};
const parse = (r) => JSON.parse(r.result.content[0].text);
const recall = (args) => rpc('tools/call', { name: 'recall', arguments: args }).then(parse);

function preview(content, n = 200) {
  try {
    const obj = JSON.parse(content);
    return JSON.stringify(obj).slice(0, n) + (JSON.stringify(obj).length > n ? '...' : '');
  } catch { return content.slice(0, n); }
}

async function main() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('============================================================');
  console.log('  VERIFY RECALL QUALITY — does imported memory work?');
  console.log('============================================================\n');

  // ---------- Q1: project-level — entity name match ----------
  console.log('Q1: "Card_Navi" — what is this project about?');
  const r1 = await recall({ query: 'Card_Navi', max_tokens: 1500 });
  console.log(`    → ${r1.count} memories returned (search=${r1.search})`);
  for (const m of r1.memories.slice(0, 3)) {
    console.log(`    [${m.layer}] importance=${m.importance} heat=${m.heat}`);
    console.log(`       ${preview(m.content)}`);
  }
  console.log();

  // ---------- Q2: layer filter — only goals ----------
  console.log('Q2: layer=goal, query="Card_Navi" — what were the goals?');
  const r2 = await recall({ query: 'Card_Navi', layer: 'goal', max_tokens: 1500 });
  console.log(`    → ${r2.count} goal memories`);
  for (const m of r2.memories.slice(0, 5)) {
    try {
      const obj = JSON.parse(m.content);
      const intent = obj.intent ?? obj.message ?? '(no intent field)';
      console.log(`    • ${intent.slice(0, 130)}${intent.length > 130 ? '...' : ''}`);
    } catch { console.log(`    • ${m.content.slice(0, 130)}`); }
  }
  console.log();

  // ---------- Q3: caveat layer — what to avoid ----------
  console.log('Q3: layer=caveat — what warnings exist?');
  const r3 = await recall({ query: 'Card_Navi', layer: 'caveat', max_tokens: 1500 });
  console.log(`    → ${r3.count} caveat memories`);
  for (const m of r3.memories.slice(0, 4)) {
    try {
      const obj = JSON.parse(m.content);
      const txt = obj.rule_or_warning ?? obj.hint ?? obj.pattern ?? '(no warning field)';
      console.log(`    ⚠ ${txt.slice(0, 150)}`);
    } catch { console.log(`    ⚠ ${m.content.slice(0, 150)}`); }
  }
  console.log();

  // ---------- Q4: free-text content search via FTS5 ----------
  console.log('Q4: "アフィリエイト" (FTS5 free-text on memory content)');
  const r4 = await recall({ query: 'アフィリエイト', max_tokens: 1500 });
  console.log(`    → ${r4.count} memories (search=${r4.search})`);
  for (const m of r4.memories.slice(0, 3)) {
    console.log(`    [${m.layer}] ${preview(m.content, 250)}`);
  }
  console.log();

  // ---------- Q5: THE MEM0-WALL TEST — file→why join ----------
  // Pick a frequently-edited file from session_file_edits, show its memories WITH context.
  console.log('Q5: THE WALL TEST — for a frequently-edited file, can we get its WHY?');
  const db = new Database(DB_PATH);
  const topFile = db.prepare(`
    SELECT file_path, COUNT(*) as edits
    FROM session_file_edits
    WHERE operation IN ('edit', 'write')
    GROUP BY file_path
    ORDER BY edits DESC
    LIMIT 1
  `).get();

  if (topFile) {
    console.log(`    Most-edited file: ${topFile.file_path}  (${topFile.edits} edits)`);
    const linked = db.prepare(`
      SELECT sfe.session_id, sfe.operation, sfe.context_snippet, sfe.occurred_at,
             m.layer, m.content, m.importance
      FROM session_file_edits sfe
      LEFT JOIN memories m ON m.id = sfe.memory_id
      WHERE sfe.file_path = ?
      ORDER BY sfe.occurred_at DESC
      LIMIT 5
    `).all(topFile.file_path);

    console.log(`    Last 5 edits with their WHY:`);
    for (const row of linked) {
      const when = new Date(row.occurred_at * 1000).toISOString().slice(0, 16);
      const why = (row.context_snippet || '').slice(0, 200).replace(/\n/g, ' ');
      console.log(`    ${when} [${row.operation}] session=${row.session_id.slice(0, 8)}`);
      console.log(`       why: "${why}${row.context_snippet?.length > 200 ? '...' : ''}"`);
    }
  } else {
    console.log('    (no file_edits found)');
  }
  console.log();

  // ---------- Q6: aggregate stats ----------
  console.log('Q6: Aggregate stats');
  const stats = {
    entities: db.prepare('SELECT COUNT(*) as c FROM entities').get().c,
    memories: db.prepare('SELECT COUNT(*) as c FROM memories').get().c,
    by_layer: db.prepare('SELECT layer, COUNT(*) as c FROM memories GROUP BY layer').all(),
    file_edits: db.prepare('SELECT COUNT(*) as c FROM session_file_edits').get().c,
    unique_files: db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM session_file_edits').get().c,
    sessions: db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM session_file_edits').get().c,
  };
  console.log(`    entities:           ${stats.entities}`);
  console.log(`    memories total:     ${stats.memories}`);
  for (const r of stats.by_layer) console.log(`      └─ ${r.layer.padEnd(15)} ${r.c}`);
  console.log(`    file_edits:         ${stats.file_edits}`);
  console.log(`    unique files:       ${stats.unique_files}`);
  console.log(`    sessions imported:  ${stats.sessions}`);
  db.close();

  await new Promise((resolve) => { server.once('exit', () => resolve()); server.kill(); });
  console.log('\n============================================================');
  console.log('  Verification done. Inspect output above for quality.');
  console.log('============================================================');
}

main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
