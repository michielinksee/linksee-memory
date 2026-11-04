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

const { wireGuard, guardWiredFor, guardFullyWired, syncWiredFor, GUARD_EVENTS, nodeHookCommands, rewireLegacyHooks, setupWrittenKind, shellSafePath, unmanagedLinkseeHooks } = await import('../dist/lib/guard-wiring.js');

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

// 6. the sync (Stop) hook shares the probe — a narrow one duplicated it on a real machine
{
  const forms = [
    ['npx subcommand', 'npx -y linksee-memory sync'],
    ['global bin', 'linksee-memory-sync'],
    ['dist path', 'node "C:/Users/HP/linksee-memory/dist/bin/sync-session.js"'],
  ];
  for (const [label, command] of forms) {
    const s = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } };
    check(`sync recognised: ${label}`, syncWiredFor(s), command);
  }
  const exec = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['/x/dist/bin/sync-session.js'] }] }] } };
  check('sync recognised: exec form (path in args)', syncWiredFor(exec));

  const foreign = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node kansei-link-mcp/dist/bin/usage-hook.js' }] }] } };
  check('a foreign Stop hook is not mistaken for sync', !syncWiredFor(foreign));

  // the two kinds must not be confused with each other
  const guardOnly = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard' }] }] } };
  check('the guard hook does not read as the sync hook', !syncWiredFor(guardOnly));
}

// 7. 0.17.1 (L-1-106 + Codex review of #15): direct node form, and which hooks setup may rewrite.
//    Only (a) the exact 0.17.0 npx strings and (b) the form 0.17.1 writes, which carries
//    --linksee-managed. Wrappers, unquoted paths, extra flags and exec form are never touched.
{
  const cmds = nodeHookCommands('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Jane Doe\\.linksee-memory\\runtime\\0.17.1\\node_modules\\linksee-memory');
  check('node form: both paths quoted, forward slashes, managed marker',
    cmds.guard === '"C:/Program Files/nodejs/node.exe" "C:/Users/Jane Doe/.linksee-memory/runtime/0.17.1/node_modules/linksee-memory/dist/bin/guard-hook.js" --linksee-managed', cmds.guard);
  check('node form for sync points at sync-session.js', cmds.sync.includes('/dist/bin/sync-session.js" --linksee-managed'));
  check('node form reads as our guard', guardWiredFor({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmds.guard }] }] } }, 'PreToolUse'));
  check('node form reads as our sync', syncWiredFor({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cmds.sync }] }] } }));
  check('shellSafePath: spaces ok', shellSafePath('C:/Program Files/x'));
  check('shellSafePath: $ ` % " rejected', !shellSafePath('/home/a$b') && !shellSafePath('/x/`y`') && !shellSafePath('C:/%USERNAME%/x') && !shellSafePath('C:/a"b'));

  const wrapper = '"C:/Program Files/nodejs/node.exe" "C:/tools/linksee-memory/dist/bin/guard-hook.js"';
  const legacy = {
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: 'npx -y linksee-memory sync' }] },
        { matcher: '*', hooks: [{ type: 'command', command: 'node other-tool/sync.js' }] },
      ],
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard', timeout: 15 }] }],
      PreToolUse: [
        { matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard', timeout: 8 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard --verbose' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo npx -y linksee-memory guard' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'node C:/Users/HP/linksee-memory/dist/bin/guard-hook.js' }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: 'npx -y linksee-memory guard', args: ['x'] }] },
        { matcher: 'Glob', hooks: [{ type: 'command', command: wrapper }] },
        { matcher: 'Grep', hooks: [{ type: 'command', command: 'npx linksee-memory guard' }] },
      ],
    },
  };

  // kinds filter: a guard-less run touches only the Stop hook
  const onlySync = JSON.parse(JSON.stringify(legacy));
  const rs = rewireLegacyHooks(onlySync, cmds, ['sync']).replaced;
  check('kinds=[sync]: only the Stop hook replaced', rs.length === 1 && onlySync.hooks.Stop[0].hooks[0].command === cmds.sync && onlySync.hooks.PreToolUse[0].hooks[0].command === 'npx -y linksee-memory guard', JSON.stringify(rs));

  const { replaced } = rewireLegacyHooks(legacy, cmds);
  check('three exact 0.17.0 npx hooks replaced', replaced.length === 3, JSON.stringify(replaced));
  check('SessionStart → node guard, timeout kept', legacy.hooks.SessionStart[0].hooks[0].command === cmds.guard && legacy.hooks.SessionStart[0].hooks[0].timeout === 15);
  check('PreToolUse → node guard, matcher + timeout kept', legacy.hooks.PreToolUse[0].hooks[0].command === cmds.guard && legacy.hooks.PreToolUse[0].matcher === 'Edit|Write|Bash' && legacy.hooks.PreToolUse[0].hooks[0].timeout === 8);
  check('foreign Stop hook untouched', legacy.hooks.Stop[1].hooks[0].command === 'node other-tool/sync.js');
  check('npx form with extra flags untouched', legacy.hooks.PreToolUse[1].hooks[0].command === 'npx -y linksee-memory guard --verbose');
  check('command merely containing the npx string untouched', legacy.hooks.PreToolUse[2].hooks[0].command === 'echo npx -y linksee-memory guard');
  check('hand-written unquoted node path untouched', legacy.hooks.PreToolUse[3].hooks[0].command === 'node C:/Users/HP/linksee-memory/dist/bin/guard-hook.js');
  check('exec form (args) untouched', legacy.hooks.PreToolUse[4].hooks[0].command === 'npx -y linksee-memory guard');
  check('quoted node + dist path WITHOUT the marker (a wrapper) untouched', legacy.hooks.PreToolUse[5].hooks[0].command === wrapper);
  check('npx without -y (never written by setup) untouched', legacy.hooks.PreToolUse[6].hooks[0].command === 'npx linksee-memory guard');
  check('second rewire is a no-op', rewireLegacyHooks(legacy, cmds).replaced.length === 0);

  const left = unmanagedLinkseeHooks(legacy);
  check('hand-wired look-alikes are listed for the closing message', left.includes(wrapper) && left.some((c) => c.includes('--verbose')) && !left.includes(cmds.guard), JSON.stringify(left));

  // an upgrade repoints our own marked form
  const newer = nodeHookCommands('/usr/bin/node', '/home/j/.linksee-memory/runtime/0.17.2/node_modules/linksee-memory');
  const { replaced: r2 } = rewireLegacyHooks(legacy, newer);
  check('marked 0.17.1 form is repointed on upgrade', r2.length === 3 && legacy.hooks.Stop[0].hooks[0].command === newer.sync, JSON.stringify(r2));
  check('setupWrittenKind ignores unmarked commands', setupWrittenKind('node "x/dist/bin/guard-hook.js"') === null && setupWrittenKind(wrapper) === null);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
