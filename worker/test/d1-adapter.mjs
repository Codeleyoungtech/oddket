/**
 * Minimal D1-compatible adapter over node:sqlite (DatabaseSync).
 *
 * Cloudflare D1 speaks SQLite, so the same SQL that runs on D1 runs here.
 * Implements just the surface the worker uses:
 *   prepare(sql).bind(...).all() / .first() / .run()
 *   db.batch([boundStatements])
 *
 * Used by test/e2e.mjs and scripts/serve.mjs — the proot-friendly way to
 * run and verify the worker without workerd.
 */

import { DatabaseSync } from "node:sqlite";

export class D1Adapter {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }
  prepare(sql) {
    return {
      bind: (...params) => new BoundStmt(this.sqlite, sql, params),
      all: () => new BoundStmt(this.sqlite, sql, []).all(),
      first: () => new BoundStmt(this.sqlite, sql, []).first(),
      run: () => new BoundStmt(this.sqlite, sql, []).run(),
    };
  }
  batch(stmts) {
    return stmts.map((s) => s.run());
  }
}

class BoundStmt {
  constructor(sqlite, sql, params) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  all() {
    return { results: this.sqlite.prepare(this.sql).all(...this.params) };
  }
  first() {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  run() {
    const info = this.sqlite.prepare(this.sql).run(...this.params);
    return { meta: { changes: info.changes } };
  }
}

/** Open (or create) a database file and apply the migration SQL. */
export function openDb(dbFile) {
  const sqlite = new DatabaseSync(dbFile);
  return sqlite;
}

export function applyMigrations(sqlite, migrationSql) {
  sqlite.exec(migrationSql);
  return new D1Adapter(sqlite);
}
