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

export const GUARD_COMMAND = 'npx -y linksee-memory guard';

export const GUARD_HOOKS: Record<GuardEvent, HookEntry> = {
  SessionStart: {
    matcher: 'startup|resume|compact',
    hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 15 }],
  },
  PreToolUse: {
    matcher: 'Edit|Write|Bash',
    hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 8 }],
  },
};

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
export function wireGuard(settings: ClaudeSettings): { settings: ClaudeSettings; added: GuardEvent[] } {
  const hooks = (settings.hooks ??= {});
  const added: GuardEvent[] = [];
  for (const ev of GUARD_EVENTS) {
    if (!Array.isArray(hooks[ev])) hooks[ev] = [];
    if (!guardWiredFor(settings, ev)) {
      hooks[ev].push(GUARD_HOOKS[ev]);
      added.push(ev);
    }
  }
  return { settings, added };
}
