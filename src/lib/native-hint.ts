// native-hint — tell the user, in one line, when the SQLite native addon cannot load.
//
// 0.17.1 (Codex re-review of #15): hooks call `node <runtime>/dist/bin/*.js` with the node that ran
// setup. After a Node major upgrade the pinned better-sqlite3 addon no longer matches the ABI. That
// failure happens at `new Database()` (better-sqlite3 loads the .node lazily), not at import — so
// the hooks catch it around opening the DB. They still fail open (exit 0), but say why once on
// stderr; any other failure stays silent and goes to hook.log only.
//
// Must not import better-sqlite3 (it is used exactly when that import is the problem).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const NATIVE_HINT = 'linksee-memory: native module failed to load (Node changed?). Re-run: npx -y linksee-memory setup';

const NATIVE_PATTERNS = [
  /NODE_MODULE_VERSION/,
  /was compiled against a different Node\.js version/i,
  /Could not locate the bindings file/i,
  /ERR_DLOPEN_FAILED/,
  /not a valid Win32 application/i,
  /invalid ELF header/i,
  /wrong ELF class/i,
  /mach-o, but wrong architecture|not a mach-o file/i,
  /better_sqlite3\.node/,
  /Cannot find (module|package) 'better-sqlite3'/,
];

/** Does this error (or child-process stderr) look like the native addon failing to load? */
export function isNativeLoadError(e: unknown): boolean {
  const text = typeof e === 'string'
    ? e
    : [(e as { code?: string })?.code, (e as Error)?.message, (e as Error)?.stack].filter(Boolean).join('\n');
  return NATIVE_PATTERNS.some((re) => re.test(text));
}

/** Append one line to <memory dir>/hook.log; never throws. */
export function hookLog(msg: string): void {
  try {
    const dir = process.env.LINKSEE_MEMORY_DIR ?? join(homedir(), '.linksee-memory');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* never throw from log */ }
}
