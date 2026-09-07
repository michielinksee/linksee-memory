#!/usr/bin/env node
// Regression: the guard must land in settings without trampling anything, and only once.
//
// Guards the 2026-09-07 finding: the guard was wired per-project and opt-in, so a machine
// with 42 active anchors had it installed in zero repos — the one layer no competing memory
// tool has was switched off on the author's own machine. Setup now targets user scope by
// default, which makes "merge, don't replace" and idempotency load-bearing: it is editing the
// file that holds every other hook the user has.
//
// Run: node test/guard-wiring.mjs   (pure functions, no filesystem, no DB)

const { wireGuard, guardWiredFor, guardFullyWired, GUARD_EVENTS } = await import('../dist/lib/guard-wiring.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

console.log('guard-wiring regression');

// 1. empty settings
{
  const { settings, added } = wireGuard({});
  check('wires both events into empty settings', added.length === 2 && guardFullyWired(settings), JSON.stringify(added));
  check('PreToolUse matcher covers Edit/Write/Bash', settings.hooks.PreToolUse[0].matcher === 'Edit|Write|Bash');
  check('SessionStart matcher covers startup/resume/compact', settings.hooks.SessionStart[0].matcher === 'startup|resume|compact');
}

// 2. idempotency — the whole point of running setup again
{
  const once = wireGuard({}).settings;
  const { added } = wireGuard(once);
  check('second run adds nothing', added.length === 0, JSON.stringify(added));
  for (const ev of GUARD_EVENTS) {
    check(`${ev} has exactly one guard entry`, once.hooks[ev].length === 1, `${once.hooks[ev].length}`);
  }
}

// 3. foreign hooks survive — this is the user's global settings file
{
  const foreign = {
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node other-tool/sync.js' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node someone-elses-linter.js' }] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  };
  const { settings } = wireGuard(foreign);
  check('unrelated Stop hook untouched', settings.hooks.Stop[0].hooks[0].command === 'node other-tool/sync.js');
  check("someone else's PreToolUse hook survives", settings.hooks.PreToolUse.some((e) => e.hooks[0].command.includes('someone-elses-linter')));
  check('guard appended alongside it', settings.hooks.PreToolUse.length === 2 && guardWiredFor(settings, 'PreToolUse'));
  check('non-hook keys untouched', JSON.stringify(settings.permissions) === JSON.stringify({ allow: ['Bash(ls:*)'] }));
}

// 4. a hand-pasted README block counts as wired (dist path form, not the npx form)
{
  const manual = {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'node /home/me/linksee-memory/dist/bin/guard-hook.js' }] }],
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'linksee-memory-guard' }] }],
    },
  };
  const { added } = wireGuard(manual);
  check('hand-wired guard is not duplicated', added.length === 0, JSON.stringify(added));
}

// 4b. the dogfood exec form puts the path in `args`, not `command`
{
  const execForm = {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/dist/bin/guard-hook.js'], timeout: 15 }] }],
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/dist/bin/guard-hook.js'], timeout: 8 }] }],
    },
  };
  const { added } = wireGuard(execForm);
  check('exec-form guard (path in args) is not duplicated', added.length === 0, JSON.stringify(added));
}

// 4c. an unrelated tool's hook must not read as our guard
{
  const other = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node some-other-memory/dist/hook.js' }] }] } };
  check('a foreign hook is not mistaken for the guard', !guardWiredFor(other, 'PreToolUse'));
}

// 5. partial wiring — only the missing event is added
{
  const partial = { hooks: { PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard' }] }] } };
  const { added, settings } = wireGuard(partial);
  check('adds only the missing event', added.length === 1 && added[0] === 'SessionStart', JSON.stringify(added));
  check('existing event not duplicated', settings.hooks.PreToolUse.length === 1);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
