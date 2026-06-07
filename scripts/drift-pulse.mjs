// #3 — background auto-trigger: the gated capture+reconcile PULSE. AGENT-AGNOSTIC (git-driven),
// idempotent, cheap when idle. The OS scheduler fires this frequently; THIS decides whether to do
// the heavy work via the "蓄積量＋時間上限" gate (≥N new commits OR ≥maxHours since last pulse).
// = GitOps scheduled-reconcile, applied to the Current Truth Map. No agent / no tool-summary needed.
import { openDb } from '../dist/db/migrate.js';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_NEW_COMMITS = 5;   // accumulate enough reality to be worth re-reconciling
const MAX_HOURS = 24;        // ...but never go stale beyond this (freshness ceiling)
const REPOS = [{ scope: 'KanseiLINK', path: 'C:\\Users\\HP\\KanseiLINK\\kansei-link-mcp' }];
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const now = Math.floor(Date.now() / 1000);
const git = (p, a) => execSync(`git -C "${p}" ${a}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function readState() {
  const db = openDb();
  const g = (k, d) => { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : d; };
  const at = Number(g('drift_last_pulse_at', '0'));
  let shas = {}; try { shas = JSON.parse(g('drift_last_pulse_shas', '{}')); } catch { /* ignore */ }
  db.close();
  return { at, shas };
}
function writeState(shas) {
  const db = openDb();
  const s = db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  s.run('drift_last_pulse_at', String(now));
  s.run('drift_last_pulse_shas', JSON.stringify(shas));
  db.close();
}

const { at: lastAt, shas: lastShas } = readState();
let newCommits = 0;
const curShas = {};
for (const r of REPOS) {
  try {
    const head = git(r.path, 'rev-parse HEAD');
    curShas[r.scope] = head;
    const last = lastShas[r.scope];
    if (!last) newCommits += MIN_NEW_COMMITS;                 // first pulse → trigger
    else if (last !== head) newCommits += Number(git(r.path, `rev-list --count ${last}..HEAD`)) || 0;
  } catch { /* repo missing / git absent → ignore */ }
}
const hoursSince = lastAt ? (now - lastAt) / 3600 : Infinity;
const gate = newCommits >= MIN_NEW_COMMITS || hoursSince >= MAX_HOURS;

if (!gate) {
  console.log(JSON.stringify({ pulse: 'skipped', reason: 'gate not met', newCommits, hoursSince: Math.round(hoursSince), need: `>=${MIN_NEW_COMMITS} commits OR >=${MAX_HOURS}h` }));
} else {
  console.log(`[pulse] gate MET (newCommits=${newCommits}, hoursSince=${hoursSince === Infinity ? 'first' : Math.round(hoursSince)}) -> capture + reconcile`);
  execSync(`node "${join(SCRIPTS, 'capture-reality.mjs')}"`, { stdio: 'inherit' });
  execSync(`node "${join(SCRIPTS, 'reconcile-once.mjs')}"`, { stdio: 'inherit' });
  execSync(`node "${join(SCRIPTS, 't2-a21-sweep.mjs')}"`, { stdio: 'inherit' }); // T2 mechanical re-verify (A21_APP_DEEPLINK_REQUIRED) — auto-catches regressions / new tools
  execSync(`node "${join(SCRIPTS, 'drift-map-html.mjs')}"`, { stdio: 'inherit' }); // refresh Drift Map: static demo -> continuously-updated map
  writeState(curShas);
  console.log('\n' + JSON.stringify({ pulse: 'ran', newCommits, state_updated: true }));
}
