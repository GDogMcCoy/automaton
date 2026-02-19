/**
 * Database Migrator
 *
 * Versioned, ordered migration system for the automaton's SQLite database.
 * Each migration is idempotent and wrapped in a transaction.
 *
 * To add a new migration:
 *   1. Increment SCHEMA_VERSION in schema.ts
 *   2. Add a new entry to MIGRATIONS below
 *   3. The migrator runs all unapplied migrations in order on startup
 */

import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger.js";

const log = createLogger("migrator");

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/**
 * All migrations in ascending order.
 * Each migration's SQL should be idempotent (use IF NOT EXISTS, etc.)
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema (identity, turns, tool_calls, heartbeat, transactions, installed_tools, modifications, kv)",
    sql: `-- V1 is applied via CREATE_TABLES in schema.ts (bootstrap)
          SELECT 1;`,
  },
  {
    version: 2,
    description: "Add skills, children, registry, reputation tables",
    sql: `
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        auto_activate INTEGER NOT NULL DEFAULT 1,
        requires TEXT DEFAULT '{}',
        instructions TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'builtin',
        path TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        genesis_prompt TEXT NOT NULL,
        creator_message TEXT,
        funded_amount_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'spawning',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_checked TEXT
      );

      CREATE TABLE IF NOT EXISTS registry (
        agent_id TEXT PRIMARY KEY,
        agent_uri TEXT NOT NULL,
        chain TEXT NOT NULL DEFAULT 'eip155:8453',
        contract_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS reputation (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        score INTEGER NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        tx_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
      CREATE INDEX IF NOT EXISTS idx_children_status ON children(status);
      CREATE INDEX IF NOT EXISTS idx_reputation_to ON reputation(to_agent);
    `,
  },
  {
    version: 3,
    description: "Add inbox_messages table for social relay",
    sql: `
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id TEXT PRIMARY KEY,
        from_address TEXT NOT NULL,
        content TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        reply_to TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
        ON inbox_messages(received_at) WHERE processed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_inbox_processed_at
        ON inbox_messages(processed_at);
      CREATE INDEX IF NOT EXISTS idx_inbox_from_address
        ON inbox_messages(from_address);
    `,
  },
  {
    version: 4,
    description: "Add migration_log table for audit trail",
    sql: `
      CREATE TABLE IF NOT EXISTS migration_log (
        version INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

/**
 * Run all pending migrations against the database.
 * Returns the number of migrations applied.
 */
export function runMigrations(db: Database.Database): number {
  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Ensure migration_log table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_log (
      version INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Get current version
  const versionRow = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null } | undefined;
  const currentVersion = versionRow?.v ?? 0;

  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    log.debug("Database schema is up to date", { version: currentVersion });
    return 0;
  }

  log.info("Running database migrations", {
    currentVersion,
    targetVersion: pendingMigrations[pendingMigrations.length - 1].version,
    count: pendingMigrations.length,
  });

  let applied = 0;

  for (const migration of pendingMigrations) {
    const startMs = Date.now();

    try {
      // Run migration in a transaction
      const runMigration = db.transaction(() => {
        db.exec(migration.sql);

        // Record in schema_version
        db.prepare(
          "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
        ).run(migration.version);

        // Record in migration_log
        const durationMs = Date.now() - startMs;
        db.prepare(
          "INSERT INTO migration_log (version, description, applied_at, duration_ms) VALUES (?, ?, datetime('now'), ?)",
        ).run(migration.version, migration.description, durationMs);
      });

      runMigration();
      applied++;

      const durationMs = Date.now() - startMs;
      log.info("Migration applied", {
        version: migration.version,
        description: migration.description,
        durationMs,
      });
    } catch (err: any) {
      log.error("Migration failed", {
        version: migration.version,
        description: migration.description,
        error: err.message,
      });
      throw new Error(
        `Migration v${migration.version} failed: ${err.message}`,
      );
    }
  }

  log.info("All migrations complete", { applied });
  return applied;
}

/**
 * Get the current schema version from the database.
 */
export function getCurrentVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get the migration history (audit trail).
 */
export function getMigrationHistory(
  db: Database.Database,
): { version: number; description: string; appliedAt: string; durationMs: number }[] {
  try {
    const rows = db
      .prepare("SELECT * FROM migration_log ORDER BY version ASC")
      .all() as any[];
    return rows.map((r) => ({
      version: r.version,
      description: r.description,
      appliedAt: r.applied_at,
      durationMs: r.duration_ms,
    }));
  } catch {
    return [];
  }
}
