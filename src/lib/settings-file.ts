// settings-file — read and write ~/.claude/settings.json without ever losing what was there.
//
// Why (L-1-106 / audit F4, 2026-11-04): setup's Stop-hook step parsed the file, and on a parse
// failure carried on with `{}` and wrote it back — wiping every other hook and setting the user
// had. A UTF-8 BOM (Notepad's default on Windows) was enough to trigger it. The guard step
// already refused to touch a file it could not parse; this module gives both steps one set of
// rules:
//
//   • strip a leading BOM before parsing
//   • if the file exists but does not parse to an object, refuse — never write
//   • before the first write of a run, leave one `settings.json.bak-<timestamp>` copy
//   • write to a temp file in the same folder, then rename (no half-written settings.json)
//   • write nothing when nothing changed (a second setup run is a no-op)

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, unlinkSync, statSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

export type SettingsRead =
  | { ok: true; exists: boolean; settings: Record<string, unknown>; raw: string }
  | { ok: false; reason: string };

export function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** Read a settings file. A missing file is `{}`; an unreadable or non-object file is a refusal. */
export function readSettingsFile(path: string): SettingsRead {
  if (!existsSync(path)) return { ok: true, exists: false, settings: {}, raw: '' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `could not read: ${(e as Error)?.message ?? e}` };
  }
  const body = stripBom(raw);
  if (body.trim() === '') return { ok: true, exists: true, settings: {}, raw };
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'top level is not a JSON object' };
    }
    return { ok: true, exists: true, settings: parsed, raw };
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${(e as Error)?.message ?? e}` };
  }
}

/**
 * Paths this process already backed up (value = the .bak path) or created (value = ''), so one
 * setup run leaves at most one .bak per file — and none for a file the run itself created.
 */
const backedUp = new Map<string, string>();

export function backupTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `backup` is set only on the write that created it. */
export type SettingsWrite = { written: boolean; backup?: string };

/**
 * Write `settings` to `path` if (and only if) it differs from what is on disk.
 * Leaves `<path>.bak-<timestamp>` before the first write of this process; writes atomically.
 */
export function writeSettingsFile(path: string, settings: Record<string, unknown>): SettingsWrite {
  const next = JSON.stringify(settings, null, 2);
  let current: string | null = null;
  if (existsSync(path)) {
    current = readFileSync(path, 'utf8');
    // Compare structurally so formatting or a BOM alone never triggers a rewrite.
    try {
      if (JSON.stringify(JSON.parse(stripBom(current)), null, 2) === next) return { written: false };
    } catch {
      // The caller should have refused an unparseable file; refuse here too rather than clobber it.
      throw new Error(`refusing to overwrite unparseable ${path}`);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  let backup = backedUp.get(path);
  let created = false;
  if (backup === undefined) {
    created = true;
    if (current !== null) {
      backup = `${path}.bak-${backupTimestamp()}`;
      copyFileSync(path, backup);
    } else {
      backup = '';
    }
    backedUp.set(path, backup);
  }

  // If settings.json is a symlink (dotfiles repos), replace the file it points to, not the link.
  let target = path;
  try { if (lstatSync(path).isSymbolicLink()) target = realpathSync(path); } catch { /* new file */ }
  // Keep the original permission bits (e.g. 600) — a fresh temp file gets the umask default.
  // On Windows chmod only toggles read-only, so this is effectively a no-op there.
  let mode: number | undefined;
  try { mode = statSync(target).mode & 0o7777; } catch { /* new file */ }

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, next, 'utf8');
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  // Report the backup only on the write that made it, so callers print it once.
  return { written: true, backup: created && backup ? backup : undefined };
}
