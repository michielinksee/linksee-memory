// test-faults — explicit failure injection for the rename / remove steps of `migrate` and
// `runtime prune` (0.17.2, Codex second review of #19). Windows file locking cannot be relied on
// to make these fail in a test (libuv opens files with FILE_SHARE_DELETE), and CI runs on Linux.
//
//   LINKSEE_TEST_FAIL_RENAME=2,3   the 2nd and 3rd guarded rename in this process throw
//   LINKSEE_TEST_FAIL_RM=1         the 1st guarded recursive remove throws
//
// Unset (the normal case) these are plain renameSync / rmSync.

import { renameSync, rmSync, type RmOptions } from 'node:fs';

const counters: Record<string, number> = {};

function inject(kind: 'RENAME' | 'RM'): void {
  const spec = process.env[`LINKSEE_TEST_FAIL_${kind}`];
  if (!spec) return;
  counters[kind] = (counters[kind] ?? 0) + 1;
  if (spec.split(',').map((s) => Number(s.trim())).includes(counters[kind])) {
    const e = new Error(`injected ${kind.toLowerCase()} failure #${counters[kind]}`) as NodeJS.ErrnoException;
    e.code = 'EINJECTED';
    throw e;
  }
}

export function renameGuarded(from: string, to: string): void {
  inject('RENAME');
  renameSync(from, to);
}

export function rmGuarded(path: string, opts: RmOptions): void {
  inject('RM');
  rmSync(path, opts);
}

/**
 * Named fault points inside a transaction (0.18.1, Codex review 1 of #23): the rollback tests
 * need a failure AFTER some rows were written, not one at prepare() time.
 *   LINKSEE_TEST_FAULT=consolidate-after-mark | consolidate-after-edges | import-after-memories
 * Unset (the normal case) this is a no-op.
 */
export function faultPoint(name: string): void {
  const spec = process.env.LINKSEE_TEST_FAULT;
  if (!spec) return;
  if (spec.split(',').map((s) => s.trim()).includes(name)) {
    const e = new Error(`injected fault at ${name}`) as NodeJS.ErrnoException;
    e.code = 'EINJECTED';
    throw e;
  }
}
