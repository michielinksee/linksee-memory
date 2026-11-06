// sqlite — the one place that knows which SQLite driver is underneath (0.19.0).
//
// Why: npm 12 stops dependency install scripts by default, so `npx -y linksee-memory` got
// better-sqlite3 without its native binding and died on "Could not locate the bindings file".
// Node 22.16+ ships SQLite itself (node:sqlite, with the FTS5 the schema needs), with no install script.
//
//   • default: node:sqlite when this Node has it; better-sqlite3 (now an optionalDependency)
//     only when it does not (Node 20, Node 22 < 22.16 — 22.13–22.15 have node:sqlite but no FTS5).
//   • LINKSEE_SQLITE_DRIVER=node | better forces one (tests run the whole suite under both).
//   • neither loads → NoSqliteDriverError, whose message is the one-line way out.
//
// This file exposes exactly the better-sqlite3 surface the codebase uses — Database (readonly,
// fileMustExist, timeout), prepare().get/all/run/iterate, exec, pragma, transaction (+ .deferred /
// .immediate / .exclusive, savepoints when nested), close, backup, open, inTransaction — and makes
// node:sqlite behave like it: plain-object rows, Buffer blobs, Number changes / lastInsertRowid,
// `SQLITE_*` string error codes, a 5 s busy timeout, foreign keys ON as in better-sqlite3's build.
// The driver is loaded on the first `new Database()`, not at import, so callers that wrap the open
// (hooks, the server) catch a load failure where they already catch it.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

export type DriverName = 'node' | 'better';

export type RunResult = { changes: number; lastInsertRowid: number };

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

type Fn = (...args: any[]) => any;
export type Transaction<F extends Fn> = ((...args: Parameters<F>) => ReturnType<F>) & {
  default: (...args: Parameters<F>) => ReturnType<F>;
  deferred: (...args: Parameters<F>) => ReturnType<F>;
  immediate: (...args: Parameters<F>) => ReturnType<F>;
  exclusive: (...args: Parameters<F>) => ReturnType<F>;
};

export type DatabaseOptions = {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Busy timeout in ms (better-sqlite3's default, 5000, when omitted). */
  timeout?: number;
};

export const NO_DRIVER_CODE = 'LINKSEE_NO_SQLITE_DRIVER';
export const NO_DRIVER_HINT =
  'linksee-memory: no SQLite driver could load. Use Node 22.16 or newer (it has SQLite built in), ' +
  'or let npm build better-sqlite3 (npm 12: npx --allow-scripts=better-sqlite3 -y linksee-memory, or "allowScripts" in a project package.json).';

/** Neither node:sqlite nor better-sqlite3 could be used. `message` is the one line to show. */
export class NoSqliteDriverError extends Error {
  readonly code = NO_DRIVER_CODE;
  constructor(detail: string, cause?: unknown) {
    super(`${NO_DRIVER_HINT} (${detail})`);
    this.name = 'NoSqliteDriverError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// ---- driver loading ------------------------------------------------------------------------

let nodeMod: any | null | undefined; // undefined = not tried yet
let nodeSqliteMissing = 'node:sqlite is not available';
let betterCtor: any | null | undefined;
let betterLoadError: unknown;

/** node:sqlite, or null when this Node does not have it unflagged. Silences only its ExperimentalWarning. */
function loadNodeSqlite(): any | null {
  if (nodeMod !== undefined) return nodeMod;
  const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof get !== 'function') return (nodeMod = null);
  const orig = process.emitWarning;
  // Only the "SQLite is an experimental feature" warning is dropped; every other warning is passed on.
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
    const opt = rest[0] as string | { type?: string } | undefined;
    const type = typeof opt === 'string' ? opt : opt?.type ?? (typeof warning === 'object' ? warning?.name : undefined);
    if (type === 'ExperimentalWarning' && /\bSQLite\b/i.test(msg)) return;
    return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const m = get.call(process, 'node:sqlite') as { DatabaseSync?: unknown } | undefined;
    nodeMod = m && typeof m.DatabaseSync === 'function' && hasFts5Trigram(m) ? m : null;
  } catch {
    nodeMod = null;
  } finally {
    process.emitWarning = orig;
  }
  return nodeMod;
}

/**
 * The schema needs FTS5 with the trigram tokenizer. Node 22.13–22.15 ship node:sqlite unflagged but
 * built WITHOUT FTS5 ("no such module: fts5"); 22.16 is the first 22.x with it. Checked, not version-
 * matched, so a build without it falls back to better-sqlite3 instead of failing on the first query.
 */
function hasFts5Trigram(m: any): boolean {
  let db: any;
  try {
    db = new m.DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE temp.linksee_probe USING fts5(c, tokenize='trigram')");
    return true;
  } catch {
    nodeSqliteMissing = 'node:sqlite has no FTS5 trigram (Node 22.16+ has it)';
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function loadBetter(): any | null {
  if (betterCtor !== undefined) return betterCtor;
  try {
    betterCtor = createRequire(import.meta.url)('better-sqlite3');
  } catch (e) {
    betterLoadError = e;
    betterCtor = null;
  }
  return betterCtor;
}

/** Which driver `new Database()` will use. Throws NoSqliteDriverError when none can be used. */
export function driverName(): DriverName {
  const forced = (process.env.LINKSEE_SQLITE_DRIVER ?? '').trim().toLowerCase();
  if (forced && forced !== 'auto' && forced !== 'node' && forced !== 'better') {
    throw new NoSqliteDriverError(`LINKSEE_SQLITE_DRIVER=${forced} is not one of node, better, auto`);
  }
  if (forced === 'node') {
    if (loadNodeSqlite()) return 'node';
    throw new NoSqliteDriverError(`LINKSEE_SQLITE_DRIVER=node but ${nodeSqliteMissing} in Node ${process.versions.node}`);
  }
  if (forced === 'better') {
    if (loadBetter()) return 'better';
    throw new NoSqliteDriverError(`LINKSEE_SQLITE_DRIVER=better but better-sqlite3 could not be loaded: ${firstLine(betterLoadError)}`, betterLoadError);
  }
  if (loadNodeSqlite()) return 'node';
  if (loadBetter()) return 'better';
  throw new NoSqliteDriverError(`Node ${process.versions.node}: ${nodeSqliteMissing}, and better-sqlite3 could not be loaded: ${firstLine(betterLoadError)}`, betterLoadError);
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e ?? 'unknown').split('\n')[0];
}

/** The better-sqlite3 native .node is only loaded at `new Database()`; a failure there is the npm 12 case. */
function isBindingFailure(e: unknown): boolean {
  const t = `${(e as { code?: string })?.code ?? ''}\n${(e as Error)?.message ?? e}`;
  return /Could not locate the bindings file|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node|better_sqlite3\.node|not a valid Win32 application|invalid ELF header|wrong ELF class|mach-o/i.test(t);
}

// ---- node:sqlite error codes → better-sqlite3's `SQLITE_*` strings ----------------------------

const PRIMARY: Record<number, string> = {
  0: 'OK', 1: 'ERROR', 2: 'INTERNAL', 3: 'PERM', 4: 'ABORT', 5: 'BUSY', 6: 'LOCKED', 7: 'NOMEM', 8: 'READONLY',
  9: 'INTERRUPT', 10: 'IOERR', 11: 'CORRUPT', 12: 'NOTFOUND', 13: 'FULL', 14: 'CANTOPEN', 15: 'PROTOCOL',
  16: 'EMPTY', 17: 'SCHEMA', 18: 'TOOBIG', 19: 'CONSTRAINT', 20: 'MISMATCH', 21: 'MISUSE', 22: 'NOLFS',
  23: 'AUTH', 24: 'FORMAT', 25: 'RANGE', 26: 'NOTADB', 27: 'NOTICE', 28: 'WARNING', 100: 'ROW', 101: 'DONE',
};
// Extended codes are primary | (n << 8); n = index + 1 in these lists (sqlite3.h order).
const EXTENDED: Record<number, string[]> = {
  0: ['LOAD_PERMANENTLY', 'SYMLINK'],
  1: ['MISSING_COLLSEQ', 'RETRY', 'SNAPSHOT'],
  4: ['ROLLBACK'],
  5: ['RECOVERY', 'SNAPSHOT', 'TIMEOUT'],
  6: ['SHAREDCACHE', 'VTAB'],
  8: ['RECOVERY', 'CANTLOCK', 'ROLLBACK', 'DBMOVED', 'CANTINIT', 'DIRECTORY'],
  10: ['READ', 'SHORT_READ', 'WRITE', 'FSYNC', 'DIR_FSYNC', 'TRUNCATE', 'FSTAT', 'UNLOCK', 'RDLOCK', 'DELETE',
    'BLOCKED', 'NOMEM', 'ACCESS', 'CHECKRESERVEDLOCK', 'LOCK', 'CLOSE', 'DIR_CLOSE', 'SHMOPEN', 'SHMSIZE',
    'SHMLOCK', 'SHMMAP', 'SEEK', 'DELETE_NOENT', 'MMAP', 'GETTEMPPATH', 'CONVPATH', 'VNODE', 'AUTH',
    'BEGIN_ATOMIC', 'COMMIT_ATOMIC', 'ROLLBACK_ATOMIC', 'DATA', 'CORRUPTFS', 'IN_PAGE'],
  11: ['VTAB', 'SEQUENCE', 'INDEX'],
  14: ['NOTEMPDIR', 'ISDIR', 'FULLPATH', 'CONVPATH', 'DIRTYWAL', 'SYMLINK'],
  19: ['CHECK', 'COMMITHOOK', 'FOREIGNKEY', 'FUNCTION', 'NOTNULL', 'PRIMARYKEY', 'TRIGGER', 'UNIQUE', 'VTAB',
    'ROWID', 'PINNED', 'DATATYPE'],
  23: ['USER'],
  27: ['RECOVER_WAL', 'RECOVER_ROLLBACK', 'RBU'],
  28: ['AUTOINDEX'],
};

export function sqliteCodeName(errcode: number): string {
  const primary = errcode & 0xff;
  const ext = errcode >> 8;
  const base = PRIMARY[primary];
  if (!base) return `SQLITE_UNKNOWN_${errcode}`;
  if (ext === 0) return `SQLITE_${base}`;
  const name = EXTENDED[primary]?.[ext - 1];
  return name ? `SQLITE_${base}_${name}` : `SQLITE_${base}`;
}

/** Give a node:sqlite error the `code` better-sqlite3 would have given it (the number stays in `errcode`). */
function asSqliteError(e: unknown): unknown {
  const err = e as { code?: string; errcode?: number };
  if (err && err.code === 'ERR_SQLITE_ERROR' && typeof err.errcode === 'number') {
    try { err.code = sqliteCodeName(err.errcode); } catch { /* frozen: leave it */ }
  }
  return e;
}

function guard<T>(f: () => T): T {
  try { return f(); } catch (e) { throw asSqliteError(e); }
}

// ---- node:sqlite → better-sqlite3 shapes -------------------------------------------------------

function isNamedObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || ArrayBuffer.isView(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** better-sqlite3 takes positional values, arrays of them, and one object of named values, in any order. */
function bindArgs(params: unknown[]): unknown[] {
  let named: Record<string, unknown> | undefined;
  const anon: unknown[] = [];
  const add = (v: unknown) => {
    if (isNamedObject(v)) {
      if (named) throw new TypeError('You cannot specify named parameters in two different objects');
      named = v;
    } else anon.push(v);
  };
  for (const p of params) {
    if (Array.isArray(p)) for (const x of p) add(x);
    else add(p);
  }
  return named ? [named, ...anon] : anon;
}

function plainRow(r: unknown): unknown {
  if (r === undefined || r === null || typeof r !== 'object') return r;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r as object)) {
    const v = (r as Record<string, unknown>)[k];
    out[k] = v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
  }
  return out;
}

class NodeStatement implements Statement {
  constructor(private readonly s: any) {}
  get(...params: unknown[]): unknown {
    return plainRow(guard(() => this.s.get(...bindArgs(params))));
  }
  all(...params: unknown[]): unknown[] {
    return (guard(() => this.s.all(...bindArgs(params))) as unknown[]).map(plainRow);
  }
  run(...params: unknown[]): RunResult {
    const r = guard(() => this.s.run(...bindArgs(params))) as { changes: number | bigint; lastInsertRowid: number | bigint };
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  *iterate(...params: unknown[]): IterableIterator<unknown> {
    const it = guard(() => this.s.iterate(...bindArgs(params))) as Iterator<unknown>;
    while (true) {
      const n = guard(() => it.next());
      if (n.done) return;
      yield plainRow(n.value);
    }
  }
}

// ---- the Database every caller uses ----------------------------------------------------------

export class Database {
  /** 'node' (node:sqlite) or 'better' (better-sqlite3). */
  readonly driver: DriverName;
  readonly name: string;
  readonly readonly: boolean;
  private readonly raw: any;
  private closed = false;

  constructor(path: string, opts: DatabaseOptions = {}) {
    this.driver = driverName();
    this.name = path;
    this.readonly = !!opts.readonly;
    const timeout = opts.timeout ?? 5000;
    if (this.driver === 'better') {
      const Ctor = loadBetter();
      try {
        this.raw = new Ctor(path, { readonly: !!opts.readonly, fileMustExist: !!opts.fileMustExist, timeout });
      } catch (e) {
        // The npm 12 case: the JS is there, the native binding never got built.
        // Default and forced paths alike: one line saying how to get a driver (Codex R4 #27).
        if (isBindingFailure(e)) {
          throw new NoSqliteDriverError(`better-sqlite3 has no usable native binding: ${firstLine(e)}`, e);
        }
        throw e;
      }
      return;
    }
    const { DatabaseSync } = loadNodeSqlite();
    const memory = path === ':memory:' || path === '';
    if (opts.fileMustExist && !memory && !existsSync(path)) {
      throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN', errcode: 14, errstr: 'unable to open database file' });
    }
    // Same start as better-sqlite3's build: foreign keys ON (SQLITE_DEFAULT_FOREIGN_KEYS=1), double-quoted
    // string literals off (SQLITE_DQS=0), a 16 MB page cache (SQLITE_DEFAULT_CACHE_SIZE=-16000).
    this.raw = guard(() => new DatabaseSync(path, { readOnly: !!opts.readonly, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false }));
    try {
      guard(() => this.raw.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(timeout)) || 0)}; PRAGMA cache_size = -16000`));
    } catch (e) {
      try { this.raw.close(); } catch { /* ignore */ }
      throw e;
    }
  }

  get open(): boolean {
    if (this.driver === 'better') return this.raw.open;
    // Node 22.13–22.14 have no isOpen: keep our own mark (set by close()).
    return typeof this.raw.isOpen === 'boolean' ? this.raw.isOpen : !this.closed;
  }

  get inTransaction(): boolean {
    if (this.driver === 'better') return this.raw.inTransaction;
    if (typeof this.raw.isTransaction === 'boolean') return this.raw.isTransaction;
    // Node 22.13–22.15 have no isTransaction. BEGIN inside a transaction fails with exactly this
    // message; any other failure (closed, busy, I/O) is not an answer and is rethrown (Codex R4 #27).
    try {
      this.raw.exec('BEGIN');
    } catch (e) {
      if (/cannot start a transaction within a transaction/i.test((e as Error)?.message ?? '')) return true;
      throw asSqliteError(e);
    }
    guard(() => this.raw.exec('ROLLBACK'));
    return false;
  }

  prepare(sql: string): Statement {
    if (this.driver === 'better') return this.raw.prepare(sql);
    return new NodeStatement(guard(() => this.raw.prepare(sql)));
  }

  exec(sql: string): this {
    if (this.driver === 'better') this.raw.exec(sql);
    else guard(() => this.raw.exec(sql));
    return this;
  }

  /** `PRAGMA <source>`: all rows, or with { simple: true } the first column of the first row. */
  pragma(source: string, opts: { simple?: boolean } = {}): unknown {
    if (this.driver === 'better') return this.raw.pragma(source, opts);
    const rows = this.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
    if (!opts.simple) return rows;
    const first = rows[0];
    return first ? first[Object.keys(first)[0]] : undefined;
  }

  /** better-sqlite3's transaction(): BEGIN … COMMIT, ROLLBACK on throw, a SAVEPOINT when nested. */
  transaction<F extends Fn>(fn: F): Transaction<F> {
    if (this.driver === 'better') return this.raw.transaction(fn);
    if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function');
    const db = this;
    const make = (begin: string) => function (this: unknown, ...args: unknown[]) {
      const nested = db.inTransaction;
      const [start, done, undo] = nested
        ? ['SAVEPOINT "\t_bs3.\t"', 'RELEASE "\t_bs3.\t"', 'ROLLBACK TO "\t_bs3.\t"']
        : [begin, 'COMMIT', 'ROLLBACK'];
      db.exec(start);
      try {
        const result = fn.apply(this, args);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          throw new TypeError('Transaction function cannot return a promise');
        }
        db.exec(done);
        return result;
      } catch (e) {
        if (db.inTransaction) {
          db.exec(undo);
          if (nested) db.exec(done);
        }
        throw e;
      }
    };
    const t = make('BEGIN') as unknown as Transaction<F>;
    t.default = t;
    t.deferred = make('BEGIN DEFERRED') as unknown as Transaction<F>;
    t.immediate = make('BEGIN IMMEDIATE') as unknown as Transaction<F>;
    t.exclusive = make('BEGIN EXCLUSIVE') as unknown as Transaction<F>;
    return t;
  }

  /** Online backup to `destination` (a new file). Resolves when done. */
  async backup(destination: string): Promise<void> {
    if (this.driver === 'better') { await this.raw.backup(destination); return; }
    const { backup } = loadNodeSqlite();
    if (typeof backup !== 'function') throw new Error('node:sqlite backup() needs Node 22.16 or newer');
    try { await backup(this.raw, destination); } catch (e) { throw asSqliteError(e); }
  }

  close(): this {
    if (this.driver === 'better') this.raw.close();
    else if (this.open) { guard(() => this.raw.close()); this.closed = true; }
    return this;
  }
}

/** Shorthand for `new Database(path, opts)`. */
export function openDatabase(path: string, opts?: DatabaseOptions): Database {
  return new Database(path, opts);
}

export default Database;
