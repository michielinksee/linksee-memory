// Final-state inspection of the imported memory brain.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new Database(join(homedir(), '.linksee-memory', 'memory.db'));

console.log('============================================================');
console.log('  FINAL STATE — linksee-memory after Phase A import');
console.log('============================================================\n');

console.log('Entities by kind:');
const ek = db.prepare("SELECT kind, COUNT(*) as c FROM entities GROUP BY kind ORDER BY c DESC").all();
for (const r of ek) console.log(`  ${r.kind.padEnd(10)} ${r.c}`);

console.log('\nProject entities (sorted by memory count):');
const proj = db.prepare(`
  SELECT e.name, e.canonical_key, COUNT(m.id) as memories
  FROM entities e
  LEFT JOIN memories m ON m.entity_id = e.id
  WHERE e.kind = 'project'
  GROUP BY e.id
  ORDER BY memories DESC
`).all();
for (const r of proj) console.log(`  ${r.name.padEnd(35)} ${String(r.memories).padStart(4)} memories  (${r.canonical_key})`);

console.log('\nMemories by layer:');
const lay = db.prepare("SELECT layer, COUNT(*) as c FROM memories GROUP BY layer ORDER BY c DESC").all();
for (const r of lay) console.log(`  ${r.layer.padEnd(15)} ${r.c}`);

console.log('\nFile edits:');
console.log(`  total:           ${db.prepare('SELECT COUNT(*) as c FROM session_file_edits').get().c}`);
console.log(`  unique files:    ${db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM session_file_edits').get().c}`);
console.log(`  unique sessions: ${db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM session_file_edits').get().c}`);

console.log('\nTop 10 most-edited files (across ALL projects):');
const top = db.prepare(`
  SELECT file_path, COUNT(*) as edits, COUNT(DISTINCT session_id) as in_sessions
  FROM session_file_edits
  WHERE operation IN ('edit', 'write')
  GROUP BY file_path
  ORDER BY edits DESC
  LIMIT 10
`).all();
for (const r of top) console.log(`  ${String(r.edits).padStart(3)} edits  in ${r.in_sessions} session(s)  ${r.file_path}`);

console.log('\nDB size:');
const fs = await import('node:fs');
const stat = fs.statSync(join(homedir(), '.linksee-memory', 'memory.db'));
console.log(`  ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

db.close();
