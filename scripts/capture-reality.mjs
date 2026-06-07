// P1b ④ — the agent-AGNOSTIC reality floor: git commits (+ npm) → reality_events.
// Whoever (Claude/Codex/Gemini/human) committed, git records it identically → uniform capture.
// Idempotent: dedup by commit hash. This is what the background auto-trigger will call.
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { execSync } from 'node:child_process';

const db = openDb();
runMigrations(db);
const now = Math.floor(Date.now() / 1000);

const git = (path, args) =>
  execSync(`git -C "${path}" ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const REPOS = [{ scope: 'KanseiLINK', path: 'C:\\Users\\HP\\KanseiLINK\\kansei-link-mcp' }];

const insert = db.prepare(`INSERT INTO reality_events
  (scope, source_type, summary, file_path, raw_ref, hash, evidence_refs, occurred_at, captured_at)
  VALUES (@scope,@source_type,@summary,@file_path,@raw_ref,@hash,@evidence_refs,@occurred_at,@captured_at)`);
const existing = new Set(db.prepare('SELECT hash FROM reality_events WHERE hash IS NOT NULL').all().map((r) => r.hash));

let added = 0, repos = 0;
for (const r of REPOS) {
  let root;
  try { root = git(r.path, 'rev-parse --show-toplevel'); } catch { console.log(`[skip] not a git repo: ${r.path}`); continue; }
  repos++;
  let log;
  // tab-separated (%x09) so cmd doesn't treat | as a pipe
  try { log = git(root, 'log -n 80 --pretty=format:%H%x09%ct%x09%s'); } catch (e) { console.log(`[skip] git log failed: ${e?.message ?? e}`); continue; }
  const lines = log.split('\n').filter(Boolean);
  db.transaction(() => {
    for (const line of lines) {
      const parts = line.split('\t');
      const sha = parts[0]; const ct = Number(parts[1]); const subj = parts.slice(2).join('\t');
      if (!sha || existing.has(sha)) continue;
      insert.run({
        scope: r.scope, source_type: 'git_commit', summary: (subj || '(no subject)').slice(0, 280),
        file_path: null, raw_ref: sha.slice(0, 10), hash: sha,
        evidence_refs: JSON.stringify([{ source_type: 'git_commit', commit_sha: sha, captured_at: now }]),
        occurred_at: Number.isFinite(ct) ? ct : now, captured_at: now,
      });
      existing.add(sha); added++;
    }
  })();
}

// npm publish as a reality event (asset freshness floor)
try {
  const res = await fetch('https://registry.npmjs.org/@kansei-link%2Fmcp-server', { signal: AbortSignal.timeout(12000) });
  if (res.ok) {
    const j = await res.json();
    const v = j['dist-tags']?.latest;
    const mt = j.time?.modified || (v && j.time?.[v]);
    const ts = mt ? Math.floor(new Date(mt).getTime() / 1000) : now;
    const h = 'npm:' + v;
    if (v && !existing.has(h)) {
      insert.run({ scope: 'KanseiLINK', source_type: 'npm', summary: `npm @kansei-link/mcp-server latest=${v}`,
        file_path: null, raw_ref: String(v), hash: h,
        evidence_refs: JSON.stringify([{ source_type: 'npm', uri: 'https://www.npmjs.com/package/@kansei-link/mcp-server', captured_at: now }]),
        occurred_at: ts, captured_at: now });
      added++;
    }
  }
} catch { /* offline / not published — skip */ }

const total = db.prepare('SELECT count(*) c FROM reality_events').get().c;
const byType = db.prepare('SELECT source_type, count(*) c FROM reality_events GROUP BY source_type').all();
const recent = db.prepare("SELECT source_type, raw_ref, substr(summary,1,56) s, date(occurred_at,'unixepoch') t FROM reality_events ORDER BY occurred_at DESC LIMIT 6").all();
console.log(JSON.stringify({ repos_captured: repos, added, total_reality_events: total, by_source_type: byType, recent }, null, 2));
db.close();
