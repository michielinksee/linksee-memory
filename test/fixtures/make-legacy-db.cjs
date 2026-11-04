// Build a schema-5 memory.db in a given on-disk state, for test/legacy-schema.mjs.
// Usage: node make-legacy-db.cjs <file> <schema.sql> <state>
//   rollback  — default rollback-journal mode, closed cleanly
//   walclean  — WAL mode, closed cleanly (no -wal / -shm left)
//   wal       — WAL mode, autocheckpoint off, killed: changes only in an un-checkpointed -wal
//   hot       — rollback mode, killed mid-transaction after spilling pages: a hot -journal
// The "killed" states end with SIGKILL so neither better-sqlite3 nor SQLite gets to clean up.
const { readFileSync } = require('node:fs');
const Database = require('better-sqlite3');

const [file, sqlPath, state] = process.argv.slice(2);
const sql = readFileSync(sqlPath, 'utf8');
const db = new Database(file);
const seed = () => {
  db.prepare(`INSERT INTO entities (name, kind) VALUES ('proj', 'project')`).run();
  db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (1, 'learning', '{"what":"keep me","why":"the reason"}', 0.8)`).run();
};

if (state === 'rollback') {
  db.exec(sql); seed(); db.close(); process.exit(0);
}
if (state === 'walclean') {
  db.pragma('journal_mode = WAL'); db.exec(sql); seed(); db.close(); process.exit(0);
}
if (state === 'wal') {
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(sql); seed();
  process.kill(process.pid, 'SIGKILL');
}
if (state === 'hot') {
  db.exec(sql); seed();
  db.pragma('cache_size = 1'); // force dirty pages out to memory.db mid-transaction
  db.exec('BEGIN');
  const ins = db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (1, 'context', ?, 0.1)`);
  for (let i = 0; i < 3000; i++) ins.run(JSON.stringify({ what: 'x'.repeat(400), i }));
  process.kill(process.pid, 'SIGKILL');
}
throw new Error(`unknown state ${state}`);
