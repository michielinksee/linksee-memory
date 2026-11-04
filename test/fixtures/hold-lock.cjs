// Hold an exclusive lock on a SQLite file until stdin closes (for test/legacy-schema.mjs).
// Usage: node hold-lock.cjs <file> [immediate]   — prints "locked" once the lock is held.
const Database = require('better-sqlite3');
const db = new Database(process.argv[2]);
db.exec(process.argv[3] === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN EXCLUSIVE');
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.on('end', () => { try { db.exec('ROLLBACK'); db.close(); } catch { /* ignore */ } process.exit(0); });
setTimeout(() => process.exit(0), 120000).unref();
