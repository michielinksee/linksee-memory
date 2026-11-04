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
 * Marker setup appends to every direct-node hook it writes. It is an ordinary trailing argument
 * (the hook scripts ignore argv), so it survives cmd.exe and sh alike — a `#` comment would not
 * (cmd.exe has no inline comments). Only a command carrying it is treated as setup-owned.
 */
export const MANAGED_MARKER = '--linksee-managed';

/**
 * Direct `node` form (0.17.1, L-1-106 / audit F11): `npx -y` costs 6–9 s per call on a warm
 * cache (npm start-up + a registry check), against an 8 s PreToolUse timeout — so the guard
 * could time out and silently not fire. `"<node>" "<root>/dist/bin/<bin>.js" --linksee-managed`
 * starts in well under a second.
 *
 * Shells: Claude Code runs a hook command through cmd.exe on Windows and through sh on POSIX
 * (PowerShell is not used for hooks — assumed here; under PowerShell this form would need `&`).
 * Double quotes protect spaces in both. They do NOT neutralise `$` or backticks (sh) or `%`
 * (cmd.exe), and a path containing `"` cannot be quoted at all — see `shellSafePath`; setup falls
 * back to the npx form for such paths instead of writing a command that might expand.
 */
export function nodeHookCommands(nodePath: string, packageRoot: string): HookCommands {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const bin = (file: string) => `"${fwd(nodePath)}" "${fwd(packageRoot).replace(/\/$/, '')}/dist/bin/${file}" ${MANAGED_MARKER}`;
  return { guard: bin('guard-hook.js'), sync: bin('sync-session.js') };
}

/** Can this path go inside double quotes in both cmd.exe and sh without being expanded? */
export function shellSafePath(p: string): boolean {
  return !/["$`%!\r\n]/.test(p);
}

/** Exactly the npx strings setup wrote up to 0.17.0. */
const LEGACY_NPX: Record<HookKind, string> = {
  guard: 'npx -y linksee-memory guard',
  sync: 'npx -y linksee-memory sync',
};

/** The form setup itself writes from 0.17.1 on — quoted node, quoted script, the marker. */
const MANAGED_NODE_FORM = /^"[^"]+" "[^"]+\/dist\/bin\/(guard-hook|sync-session)\.js" --linksee-managed$/;

/**
 * Is this command one setup wrote — (a) the exact 0.17.0-and-earlier npx string, or (b) the
 * 0.17.1+ direct form carrying MANAGED_MARKER? Anything else (wrappers, unquoted paths, extra
 * flags, someone else's script) is not ours to change.
 */
export function setupWrittenKind(command: string | undefined): HookKind | null {
  if (typeof command !== 'string') return null;
  const c = command.trim();
  for (const kind of ['guard', 'sync'] as const) if (LEGACY_NPX[kind] === c) return kind;
  const m = MANAGED_NODE_FORM.exec(c);
  if (m) return m[1] === 'guard-hook' ? 'guard' : 'sync';
  return null;
}

function eachCommandHook(settings: ClaudeSettings, fn: (h: HookCommand) => void): void {
  for (const entries of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) for (const h of entry?.hooks ?? []) if (h && h.type === 'command') fn(h);
  }
}

/**
 * Point the setup-written hooks of the given kinds at `commands`. Exec-form hooks (`args`), other
 * tools' hooks and hand-edited commands are never touched. Only `command` changes — matcher,
 * timeout and any other field stay. Mutates `settings`; returns the replaced commands.
 */
export function rewireLegacyHooks(
  settings: ClaudeSettings,
  commands: HookCommands,
  kinds: readonly HookKind[] = ['guard', 'sync'],
): { replaced: string[] } {
  const replaced: string[] = [];
  eachCommandHook(settings, (h) => {
    if (Array.isArray(h.args) && h.args.length) return;
    const kind = setupWrittenKind(h.command);
    if (!kind || !kinds.includes(kind) || h.command === commands[kind]) return;
    replaced.push(h.command as string);
    h.command = commands[kind];
  });
  return { replaced };
}

/**
 * Hooks that look like ours (they run the guard or the sync script) but were not written by setup —
 * hand-wired paths, wrappers, exec form. setup leaves them alone and lists them so the user knows.
 */
export function unmanagedLinkseeHooks(settings: ClaudeSettings): string[] {
  const out: string[] = [];
  eachCommandHook(settings, (h) => {
    const hay = [h.command, ...(h.args ?? [])].filter((x) => typeof x === 'string').join(' ');
    const looksOurs = /guard-hook|sync-session/.test(hay) || (/linksee-memory/.test(hay) && /\b(guard|sync)\b/.test(hay));
    if (!looksOurs) return;
    if ((!h.args || !h.args.length) && setupWrittenKind(h.command)) return;
    out.push(hay);
  });
  return out;
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
