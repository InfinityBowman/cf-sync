export interface Meta {
  backendId: string
  currentVersion: number
  minCursorVersion: number
  /** The DO's own name; ctx.id.name can be absent on alarm wakes, so it's persisted. */
  workspaceId: string
  /** Highest mutation_log.log_seq already exported to R2. */
  lastExportedSeq: number
  /**
   * The schema version the stored data was written under. May differ from the
   * configured version when the DO first wakes after a deploy — the engine
   * then runs the schema migration (do.ts) and restamps it.
   */
  schemaVersion: string
}

// Storage schema per DESIGN.md §5. mutation_log has its own sequence because a
// mutation that writes no rows (app error, no-op) advances the client's LMID
// without advancing the data version — cursor versions track data changes only.
//
// Migrations are append-only: each entry runs once per DO, tracked in
// _migrations. Never edit a shipped migration; add a new one. (DO SQLite does
// not expose PRAGMA user_version, hence the tracking table.)
const MIGRATIONS: ReadonlyArray<readonly string[]> = [
  // v1 — initial schema
  [
    `CREATE TABLE IF NOT EXISTS rows (
      tbl     TEXT    NOT NULL,
      id      TEXT    NOT NULL,
      data    TEXT    NOT NULL,
      version INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tbl, id)
    ) STRICT`,
    `CREATE INDEX IF NOT EXISTS rows_by_version ON rows (version)`,
    `CREATE TABLE IF NOT EXISTS mutation_log (
      log_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      version     INTEGER,
      client_id   TEXT    NOT NULL,
      mutation_id INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      args        TEXT    NOT NULL,
      result      TEXT    NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS clients (
      client_id        TEXT PRIMARY KEY,
      last_mutation_id INTEGER NOT NULL DEFAULT 0,
      last_seen_at     TEXT NOT NULL
    ) STRICT`,
    `CREATE TABLE IF NOT EXISTS meta (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      backend_id         TEXT    NOT NULL,
      current_version    INTEGER NOT NULL DEFAULT 0,
      min_cursor_version INTEGER NOT NULL DEFAULT 0,
      schema_version     TEXT    NOT NULL
    ) STRICT`,
  ],
  // v2 — wall-clock timestamps on the mutation log (R2 export, debugging)
  [`ALTER TABLE mutation_log ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`],
  // v3 — workspace identity (a DO can't rely on ctx.id.name on alarm wakes)
  //      and the R2 export cursor
  [
    `ALTER TABLE meta ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE meta ADD COLUMN last_exported_seq INTEGER NOT NULL DEFAULT 0`,
  ],
]

export function migrate(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)`)
  const row = sql.exec<{ v: number | null }>(`SELECT MAX(version) AS v FROM _migrations`).one()
  const applied = row.v === null ? 0 : Number(row.v)
  for (let version = applied; version < MIGRATIONS.length; version++) {
    for (const statement of MIGRATIONS[version]!) sql.exec(statement)
    sql.exec(`INSERT INTO _migrations (version) VALUES (?)`, version + 1)
  }
}

export function loadOrInitMeta(sql: SqlStorage, schemaVersion: string): Meta {
  const rows = sql
    .exec<{
      backend_id: string
      current_version: number
      min_cursor_version: number
      schema_version: string
      workspace_id: string
      last_exported_seq: number
    }>(
      `SELECT backend_id, current_version, min_cursor_version, schema_version, workspace_id, last_exported_seq
       FROM meta WHERE id = 1`,
    )
    .toArray()
  const row = rows[0]
  if (!row) {
    const backendId = crypto.randomUUID()
    sql.exec(
      `INSERT INTO meta (id, backend_id, current_version, min_cursor_version, schema_version, workspace_id, last_exported_seq)
       VALUES (1, ?, 0, 0, ?, '', 0)`,
      backendId,
      schemaVersion,
    )
    return {
      backendId,
      currentVersion: 0,
      minCursorVersion: 0,
      workspaceId: '',
      lastExportedSeq: 0,
      schemaVersion,
    }
  }
  // A stored schema version differing from the configured one is surfaced to
  // the caller (the DO runs the migration hook and restamps) — never silently
  // overwritten here.
  return {
    backendId: row.backend_id,
    currentVersion: Number(row.current_version),
    minCursorVersion: Number(row.min_cursor_version),
    workspaceId: row.workspace_id,
    lastExportedSeq: Number(row.last_exported_seq),
    schemaVersion: row.schema_version,
  }
}
