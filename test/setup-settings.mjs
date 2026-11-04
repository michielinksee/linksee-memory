#!/usr/bin/env node
// Regression: setup must never lose what was already in ~/.claude/settings.json (L-1-106 / audit F4).
//
// 0.17.0's Stop-hook step treated an unparseable file as `{}` and wrote it back — a UTF-8 BOM
// (Notepad's default) was enough to wipe every other hook the user had. This runs the real
// setup binary against a throwaway HOME (USERPROFILE/HOME) and LINKSEE_MEMORY_DIR, with the MCP
// server pre-registered in that HOME so setup never shells out to the real `claude` CLI.
//
// Cases: BOM-prefixed file · broken JSON · a file holding someone else's hooks · second run is a no-op.
//
// Run: node test/setup-settings.mjs   (needs `pnpm build` first)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'setup.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const homes = [];
function freshHome(settingsContent) {
  const home = mkdtempSync(join(tmpdir(), 'linksee-setup-home-'));
  homes.push(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  // Pre-registered, so step 1 never runs `claude mcp add` against the real machine.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { linksee: { command: 'npx' } } }));
  if (settingsContent !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), settingsContent);
  return home;
}
function runSetup(home, extra = []) {
  return spawnSync(process.execPath, [SETUP, '--yes', ...extra], {
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LINKSEE_MEMORY_DIR: join(home, '.linksee-memory'),
      LINKSEE_TELEMETRY: 'off',
    },
    timeout: 60000,
  });
}
const settingsPath = (home) => join(home, '.claude', 'settings.json');
const readSettings = (home) => readFileSync(settingsPath(home), 'utf8');
const backups = (home) => readdirSync(join(home, '.claude')).filter((f) => f.startsWith('settings.json.bak-'));
const leftovers = (home) => readdirSync(join(home, '.claude')).filter((f) => f.includes('.tmp-'));

console.log('setup settings-protection regression');

const FOREIGN = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node other-tool/sync.js' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node someone-elses-linter.js' }] }],
  },
};

// 1. broken JSON — left byte-for-byte untouched, no backup, no temp file
{
  const broken = '{ "hooks": { "Stop": [ ,,, this is not json';
  const home = freshHome(broken);
  const r = runSetup(home);
  check('broken JSON: setup exits cleanly', r.status === 0, `exit ${r.status} ${r.stderr}`);
  check('broken JSON: file untouched', readSettings(home) === broken);
  check('broken JSON: says it left the file alone', /left untouched/.test(r.stdout));
  check('broken JSON: no backup made (nothing was written)', backups(home).length === 0, backups(home).join(','));
  check('broken JSON: no temp file left', leftovers(home).length === 0);
}

// 2. BOM-prefixed file with foreign hooks — parsed, merged, foreign content kept, backup holds the original
{
  const original = '﻿' + JSON.stringify(FOREIGN, null, 2);
  const home = freshHome(original);
  const r = runSetup(home);
  check('BOM: setup exits cleanly', r.status === 0, `exit ${r.status} ${r.stderr}`);
  let s = {};
  try { s = JSON.parse(readSettings(home)); } catch (e) { check('BOM: result parses', false, String(e)); }
  check('BOM: foreign Stop hook kept', s.hooks?.Stop?.some((e) => e.hooks?.[0]?.command === 'node other-tool/sync.js'));
  check("BOM: someone else's PreToolUse hook kept", s.hooks?.PreToolUse?.some((e) => e.hooks?.[0]?.command === 'node someone-elses-linter.js'));
  check('BOM: non-hook keys kept', s.model === 'opus' && JSON.stringify(s.permissions) === JSON.stringify(FOREIGN.permissions));
  check('BOM: our Stop hook added', s.hooks?.Stop?.length === 2, JSON.stringify(s.hooks?.Stop));
  check('BOM: guard added to SessionStart + PreToolUse', s.hooks?.SessionStart?.length === 1 && s.hooks?.PreToolUse?.length === 2);
  const b = backups(home);
  check('BOM: exactly one .bak for the run', b.length === 1, b.join(','));
  check('BOM: .bak holds the original bytes', b.length === 1 && readFileSync(join(home, '.claude', b[0]), 'utf8') === original);
  check('BOM: no temp file left', leftovers(home).length === 0);

  // 4. second run — byte-identical, no new backup
  const before = readSettings(home);
  const r2 = runSetup(home);
  check('2nd run: exits cleanly', r2.status === 0, `exit ${r2.status} ${r2.stderr}`);
  check('2nd run: settings.json byte-identical', readSettings(home) === before);
  check('2nd run: no new .bak', backups(home).length === 1, backups(home).join(','));
}

// 3. no settings.json at all — created, nothing to back up
{
  const home = freshHome(undefined);
  const r = runSetup(home);
  check('missing file: setup exits cleanly', r.status === 0, `exit ${r.status} ${r.stderr}`);
  check('missing file: created', existsSync(settingsPath(home)));
  check('missing file: no .bak (nothing existed)', backups(home).length === 0);
  // completion text (L-1-106): no "works across 5 clients" over-claim; an empty memory gets the
  // remember → new session round trip, not a recall that is bound to come back empty
  check('completion: says auto-capture/guard are Claude Code only', /Claude Code only/.test(r.stdout) && !/Works across/.test(r.stdout));
  check('completion: gives the Codex registration line', /codex mcp add linksee -- npx -y linksee-memory/.test(r.stdout));
  check('completion (empty memory): round trip, not "How did we solve this before?"', /new.*session/.test(r.stdout) && !/How did we solve this before/.test(r.stdout));
}

// 3b. a memory that already has something in it gets the recall prompts
{
  const home = freshHome(undefined);
  const memDir = join(home, '.linksee-memory');
  process.env.LINKSEE_MEMORY_DIR = memDir;
  const { openDb, runMigrations } = await import(`../dist/db/migrate.js?d=${encodeURIComponent(memDir)}`);
  const db = openDb();
  runMigrations(db);
  db.prepare(`INSERT INTO entities (name, kind, normalized_name) VALUES ('p', 'project', 'p')`).run();
  db.prepare(`INSERT INTO memories (entity_id, layer, content, importance) VALUES (1, 'learning', '{"what":"x"}', 0.5)`).run();
  db.close();
  const r = runSetup(home);
  check('completion (non-empty memory): recall prompt shown', /How did we solve this before/.test(r.stdout));
}

// 5. a JSON array at the top level is not a settings object — refuse
{
  const home = freshHome('[1,2,3]');
  runSetup(home);
  check('top-level array: left untouched', readSettings(home) === '[1,2,3]');
}

// 6. 0.17.1: an existing 0.17.0 install (npx hooks) is switched to direct node calls in place
{
  const legacy = {
    ...FOREIGN,
    hooks: {
      Stop: [
        FOREIGN.hooks.Stop[0],
        { matcher: '', hooks: [{ type: 'command', command: 'npx -y linksee-memory sync' }] },
      ],
      PreToolUse: [
        FOREIGN.hooks.PreToolUse[0],
        { matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard', timeout: 8 }] },
      ],
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard', timeout: 15 }] }],
    },
  };
  const home = freshHome(JSON.stringify(legacy, null, 2));
  const r = runSetup(home);
  check('legacy npx: setup exits cleanly', r.status === 0, `exit ${r.status} ${r.stderr}`);
  const s = JSON.parse(readSettings(home));
  const all = Object.values(s.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
  check('legacy npx: no npx hook left', !all.some((c) => c.startsWith('npx ')), JSON.stringify(all));
  check('legacy npx: Stop now calls node on sync-session.js', /^"[^"]+" "[^"]+\/dist\/bin\/sync-session\.js"$/.test(s.hooks.Stop[1].hooks[0].command), s.hooks.Stop[1].hooks[0].command);
  check('legacy npx: guard now calls node on guard-hook.js (timeouts kept)',
    /guard-hook\.js"$/.test(s.hooks.PreToolUse[1].hooks[0].command) && s.hooks.PreToolUse[1].hooks[0].timeout === 8 && s.hooks.SessionStart[0].hooks[0].timeout === 15);
  check('legacy npx: no duplicates added', s.hooks.Stop.length === 2 && s.hooks.PreToolUse.length === 2 && s.hooks.SessionStart.length === 1);
  check('legacy npx: foreign hooks kept', s.hooks.Stop[0].hooks[0].command === 'node other-tool/sync.js' && s.hooks.PreToolUse[0].hooks[0].command === 'node someone-elses-linter.js');
  check('legacy npx: one .bak', backups(home).length === 1);
  const before = readSettings(home);
  runSetup(home);
  check('legacy npx: 2nd run byte-identical', readSettings(home) === before);
  check('legacy npx: 2nd run no new .bak', backups(home).length === 1);
  if (process.env.SHOW_DIFF) {
    console.log(['--- before', JSON.stringify(legacy.hooks, null, 2), '--- after', JSON.stringify(s.hooks, null, 2)].join('\n'));
  }
}

for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ } }
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
