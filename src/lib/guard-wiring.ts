// guard-wiring — merge the re-injection guard's hooks into a Claude Code settings object.
//
// Extracted from bin/setup.ts so the merge is testable without running the installer (which
// also registers an MCP server and copies a skill). The rules that matter here:
//
//   • merge, never replace — other people's hooks in the same event must survive
//   • idempotent — running setup twice must not produce two guard entries
//   • recognise a hand-pasted guard from the README as already-wired (match on the bin name,
//     not on the exact command string, which differs between `npx` and a dist path)

export type HookCommand = { type: string; command?: string; timeout?: number; args?: string[] };
export type HookEntry = { matcher?: string; hooks?: HookCommand[] };
export type ClaudeSettings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

export const GUARD_EVENTS = ['SessionStart', 'PreToolUse'] as const;
export type GuardEvent = (typeof GUARD_EVENTS)[number];

/** The bin every wiring form resolves to; used as the idempotency key. */
export const GUARD_BIN = 'linksee-memory-guard';

/** The npx form setup wrote before 0.17.1. Still the fallback when no stable install exists. */
export const GUARD_COMMAND = 'npx -y linksee-memory guard';
export const SYNC_COMMAND = 'npx -y linksee-memory sync';

export type HookKind = 'guard' | 'sync';
export type HookCommands = Record<HookKind, string>;

export const NPX_HOOK_COMMANDS: HookCommands = { guard: GUARD_COMMAND, sync: SYNC_COMMAND };

/**
 * Direct `node` form (0.17.1, L-1-106 / audit F11): `npx -y` costs 6–9 s per call on a warm
 * cache (npm start-up + a registry check), against an 8 s PreToolUse timeout — so the guard
 * could time out and silently not fire. `"<node>" "<root>/dist/bin/<bin>.js"` starts in well under
 * a second. Both paths are quoted (spaces in `Program Files` / user names) and use forward
 * slashes, which cmd.exe, PowerShell and Git Bash all accept.
 */
export function nodeHookCommands(nodePath: string, packageRoot: string): HookCommands {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const bin = (file: string) => `"${fwd(nodePath)}" "${fwd(packageRoot).replace(/\/$/, '')}/dist/bin/${file}"`;
  return { guard: bin('guard-hook.js'), sync: bin('sync-session.js') };
}

/** Exactly the npx strings earlier setups wrote. Anything else is someone's hand edit — left alone. */
const LEGACY_NPX: Record<HookKind, string[]> = {
  guard: ['npx -y linksee-memory guard', 'npx linksee-memory guard'],
  sync: ['npx -y linksee-memory sync', 'npx linksee-memory sync'],
};

/** The quoted direct form setup itself writes (0.17.1+), so a re-run after an upgrade can repoint it. */
const SETUP_NODE_FORM = /^"[^"]+" "([^"]*linksee-memory[^"]*)\/dist\/bin\/(guard-hook|sync-session)\.js"$/;

/** Which of our setup-written forms is this command, if any? Whole-string matches only. */
export function setupWrittenKind(command: string | undefined): HookKind | null {
  if (typeof command !== 'string') return null;
  const c = command.trim();
  for (const kind of ['guard', 'sync'] as const) if (LEGACY_NPX[kind].includes(c)) return kind;
  const m = SETUP_NODE_FORM.exec(c);
  if (m) return m[2] === 'guard-hook' ? 'guard' : 'sync';
  return null;
}

/**
 * Point every hook that setup itself wrote (the npx forms, or an older direct form) at `commands`.
 * Exec-form hooks (`args`), other tools' hooks and hand-edited commands are never touched.
 * Only `command` changes — matcher, timeout and any other field stay as the user left them.
 * Mutates `settings`; returns the commands that were replaced (empty = nothing to do).
 */
export function rewireLegacyHooks(settings: ClaudeSettings, commands: HookCommands): { replaced: string[] } {
  const replaced: string[] = [];
  for (const entries of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of entry?.hooks ?? []) {
        if (!h || h.type !== 'command' || (Array.isArray(h.args) && h.args.length)) continue;
        const kind = setupWrittenKind(h.command);
        if (!kind || h.command === commands[kind]) continue;
        replaced.push(h.command as string);
        h.command = commands[kind];
      }
    }
  }
  return { replaced };
}

export function guardHooks(command: string = GUARD_COMMAND): Record<GuardEvent, HookEntry> {
  return {
    SessionStart: {
      matcher: 'startup|resume|compact',
      hooks: [{ type: 'command', command, timeout: 15 }],
    },
    PreToolUse: {
      matcher: 'Edit|Write|Bash',
      hooks: [{ type: 'command', command, timeout: 8 }],
    },
  };
}

export const GUARD_HOOKS: Record<GuardEvent, HookEntry> = guardHooks();

/** Everything a hook entry could carry an identifier in: `command`, or `args` for the exec form. */
function hookHaystack(h: HookCommand | undefined): string {
  return [h?.command, ...(h?.args ?? [])].filter((x) => typeof x === 'string').join(' ');
}

/**
 * Is one of OUR hooks of `kind` already wired for this event?
 *
 * Shared by the guard and the session-sync hook because they hit the same trap: each has been
 * wired as an npx subcommand, as a global bin, as a dist path, and in exec form with the path
 * in `args`. A probe that knows only one shape appends a duplicate — which is exactly what
 * happened to the Stop hook on 2026-09-07 (`sync-session.js` did not match `linksee-memory-sync`,
 * so setup added a second one and sessions were captured twice).
 */
export function linkseeHookWired(settings: ClaudeSettings, event: string, kind: 'guard' | 'sync'): boolean {
  const bare = kind === 'guard' ? 'guard-hook' : 'sync-session';
  return (settings.hooks?.[event] ?? []).some((entry) =>
    entry?.hooks?.some((h) => {
      const hay = hookHaystack(h);
      if (!hay) return false;
      return hay.includes(bare) || (hay.includes('linksee-memory') && hay.includes(kind));
    }),
  );
}

/** Is the session-sync (Stop) hook already wired? */
export function syncWiredFor(settings: ClaudeSettings, event = 'Stop'): boolean {
  return linkseeHookWired(settings, event, 'sync');
}

/**
 * Is OUR guard already wired for this event?
 *
 * Has to recognise every shape the guard has ever been wired in, or setup duplicates it:
 *   npx -y linksee-memory guard                              (what setup writes)
 *   linksee-memory-guard                                     (the global bin)
 *   node /path/to/linksee-memory/dist/bin/guard-hook.js      (the old README block)
 *   { command: 'node', args: ['.../dist/bin/guard-hook.js'] } (exec form — the path is in args)
 *
 * The last two put the identifying part in different places, so match against command and args
 * joined together. `guard-hook` alone is accepted because the exec form carries no package name.
 */
export function guardWiredFor(settings: ClaudeSettings, event: string): boolean {
  return linkseeHookWired(settings, event, 'guard');
}

export function guardFullyWired(settings: ClaudeSettings): boolean {
  return GUARD_EVENTS.every((ev) => guardWiredFor(settings, ev));
}

/**
 * Add the guard to any event it does not already own. Mutates and returns `settings`, plus the
 * events that were actually added (empty when it was already wired).
 */
export function wireGuard(settings: ClaudeSettings, command: string = GUARD_COMMAND): { settings: ClaudeSettings; added: GuardEvent[] } {
  const hooks = (settings.hooks ??= {});
  const added: GuardEvent[] = [];
  const wanted = guardHooks(command);
  for (const ev of GUARD_EVENTS) {
    if (!Array.isArray(hooks[ev])) hooks[ev] = [];
    if (!guardWiredFor(settings, ev)) {
      hooks[ev].push(wanted[ev]);
      added.push(ev);
    }
  }
  return { settings, added };
}
