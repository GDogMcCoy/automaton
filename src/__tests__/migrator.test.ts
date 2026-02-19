/**
 * Tests for the database migration system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import {
  runMigrations,
  getCurrentVersion,
  getMigrationHistory,
  MIGRATIONS,
} from "../state/migrator.js";

describe("Database Migrator", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrator-test-"));
    dbPath = path.join(tmpDir, "test.db");
    db = new Database(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch {}
  });

  it("creates schema_version table if not exists", () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as any;
    expect(tables).toBeTruthy();
    expect(tables.name).toBe("schema_version");
  });

  it("creates migration_log table", () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_log'")
      .get() as any;
    expect(tables).toBeTruthy();
  });

  it("applies all migrations on fresh database", () => {
    const applied = runMigrations(db);
    expect(applied).toBe(MIGRATIONS.length);

    const version = getCurrentVersion(db);
    expect(version).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it("skips already-applied migrations", () => {
    // Run once
    runMigrations(db);
    const firstVersion = getCurrentVersion(db);

    // Run again — should apply 0
    const applied = runMigrations(db);
    expect(applied).toBe(0);
    expect(getCurrentVersion(db)).toBe(firstVersion);
  });

  it("records migration history", () => {
    runMigrations(db);
    const history = getMigrationHistory(db);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].version).toBe(MIGRATIONS[0].version);
    expect(history[0].description).toBeTruthy();
    expect(history[0].appliedAt).toBeTruthy();
  });

  it("handles empty database with getCurrentVersion", () => {
    // Before any migrations
    const version = getCurrentVersion(db);
    expect(version).toBe(0);
  });

  it("migrations are ordered ascending", () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version);
    }
  });

  it("all migrations have descriptions", () => {
    for (const m of MIGRATIONS) {
      expect(m.description.length).toBeGreaterThan(0);
    }
  });
});
