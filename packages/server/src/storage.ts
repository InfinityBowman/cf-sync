export interface Meta {
  backendId: string
  currentVersion: number
  minCursorVersion: number
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
    .exec<{ backend_id: string; current_version: number; min_cursor_version: number; schema_version: string }>(
      `SELECT backend_id, current_version, min_cursor_version, schema_version FROM meta WHERE id = 1`,
    )
    .toArray()
  const row = rows[0]
  if (!row) {
    const backendId = crypto.randomUUID()
    sql.exec(
      `INSERT INTO meta (id, backend_id, current_version, min_cursor_version, schema_version) VALUES (1, ?, 0, 0, ?)`,
      backendId,
      schemaVersion,
    )
    return { backendId, currentVersion: 0, minCursorVersion: 0 }
  }
  if (row.schema_version !== schemaVersion) {
    // The server is the authority on the live schema version; old clients are
    // rejected at hello. Data migration hooks are out of scope for M0.
    sql.exec(`UPDATE meta SET schema_version = ? WHERE id = 1`, schemaVersion)
  }
  return {
    backendId: row.backend_id,
    currentVersion: Number(row.current_version),
    minCursorVersion: Number(row.min_cursor_version),
  }
}
