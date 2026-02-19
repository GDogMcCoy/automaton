/**
 * Audit Log Module Tests
 *
 * Tests for the immutable self-modification audit trail.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  logModification,
  getRecentModifications,
  generateAuditReport,
} from "../self-mod/audit-log.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

describe("Audit Log", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ─── logModification ────────────────────────────────────────

  describe("logModification", () => {
    it("creates an audit entry with required fields", () => {
      const entry = logModification(db, "code_edit", "Updated loop logic");

      expect(entry.id).toBeDefined();
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.timestamp).toBeDefined();
      expect(entry.type).toBe("code_edit");
      expect(entry.description).toBe("Updated loop logic");
      expect(entry.reversible).toBe(true); // default
    });

    it("stores the entry in the database", () => {
      logModification(db, "config_change", "Changed heartbeat interval");

      const mods = db.getRecentModifications(10);
      expect(mods).toHaveLength(1);
      expect(mods[0].description).toBe("Changed heartbeat interval");
    });

    it("supports optional filePath", () => {
      const entry = logModification(db, "code_edit", "Refactored handler", {
        filePath: "src/agent/loop.ts",
      });

      expect(entry.filePath).toBe("src/agent/loop.ts");

      const stored = db.getRecentModifications(10);
      expect(stored[0].filePath).toBe("src/agent/loop.ts");
    });

    it("supports optional diff", () => {
      const entry = logModification(db, "code_edit", "Fixed bug", {
        diff: "-old line\n+new line",
      });

      expect(entry.diff).toBe("-old line\n+new line");
    });

    it("supports reversible flag override", () => {
      const entry = logModification(db, "prompt_change", "New genesis prompt", {
        reversible: false,
      });

      expect(entry.reversible).toBe(false);

      const stored = db.getRecentModifications(10);
      expect(stored[0].reversible).toBe(false);
    });

    it("defaults reversible to true", () => {
      const entry = logModification(db, "tool_install", "Installed new tool");
      expect(entry.reversible).toBe(true);
    });

    it("generates unique IDs for each entry", () => {
      const e1 = logModification(db, "code_edit", "Edit 1");
      const e2 = logModification(db, "code_edit", "Edit 2");
      const e3 = logModification(db, "code_edit", "Edit 3");

      expect(e1.id).not.toBe(e2.id);
      expect(e2.id).not.toBe(e3.id);
      expect(e1.id).not.toBe(e3.id);
    });

    it("handles all modification types", () => {
      const types = [
        "code_edit",
        "tool_install",
        "mcp_install",
        "config_change",
        "port_expose",
        "vm_deploy",
        "heartbeat_change",
        "prompt_change",
        "skill_install",
        "skill_remove",
        "soul_update",
        "registry_update",
        "child_spawn",
        "upstream_pull",
      ] as const;

      for (const type of types) {
        const entry = logModification(db, type, `Test ${type}`);
        expect(entry.type).toBe(type);
      }

      const all = db.getRecentModifications(100);
      expect(all).toHaveLength(types.length);
    });
  });

  // ─── getRecentModifications ─────────────────────────────────

  describe("getRecentModifications", () => {
    it("returns entries in chronological order", () => {
      // Insert directly with explicit timestamps to ensure ordering
      db.insertModification({
        id: "mod-first",
        timestamp: "2025-01-01T00:00:00Z",
        type: "code_edit",
        description: "First edit",
        reversible: true,
      });
      db.insertModification({
        id: "mod-second",
        timestamp: "2025-01-01T00:01:00Z",
        type: "config_change",
        description: "Second edit",
        reversible: true,
      });
      db.insertModification({
        id: "mod-third",
        timestamp: "2025-01-01T00:02:00Z",
        type: "tool_install",
        description: "Third edit",
        reversible: true,
      });

      const mods = getRecentModifications(db, 10);
      expect(mods).toHaveLength(3);
      expect(mods[0].description).toBe("First edit");
      expect(mods[1].description).toBe("Second edit");
      expect(mods[2].description).toBe("Third edit");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        logModification(db, "code_edit", `Edit ${i}`);
      }

      const mods = getRecentModifications(db, 3);
      expect(mods).toHaveLength(3);
    });

    it("uses default limit of 20", () => {
      for (let i = 0; i < 25; i++) {
        logModification(db, "code_edit", `Edit ${i}`);
      }

      const mods = getRecentModifications(db);
      expect(mods).toHaveLength(20);
    });

    it("returns empty array when no modifications exist", () => {
      const mods = getRecentModifications(db);
      expect(mods).toEqual([]);
    });
  });

  // ─── generateAuditReport ────────────────────────────────────

  describe("generateAuditReport", () => {
    it("returns 'no modifications' message for empty log", () => {
      const report = generateAuditReport(db);
      expect(report).toBe("No self-modifications recorded.");
    });

    it("includes header and footer markers", () => {
      logModification(db, "code_edit", "Test edit");

      const report = generateAuditReport(db);
      expect(report).toContain("=== SELF-MODIFICATION AUDIT LOG ===");
      expect(report).toContain("=================================");
    });

    it("includes total modification count", () => {
      logModification(db, "code_edit", "Edit 1");
      logModification(db, "config_change", "Edit 2");
      logModification(db, "tool_install", "Edit 3");

      const report = generateAuditReport(db);
      expect(report).toContain("Total modifications: 3");
    });

    it("includes each modification entry with type and description", () => {
      logModification(db, "code_edit", "Updated loop handler");
      logModification(db, "config_change", "Changed model to gpt-4.1");

      const report = generateAuditReport(db);
      expect(report).toContain("code_edit: Updated loop handler");
      expect(report).toContain("config_change: Changed model to gpt-4.1");
    });

    it("includes file path in parentheses when present", () => {
      logModification(db, "code_edit", "Fixed bug", {
        filePath: "src/agent/loop.ts",
      });

      const report = generateAuditReport(db);
      expect(report).toContain("(src/agent/loop.ts)");
    });

    it("does not include file path parentheses when absent", () => {
      logModification(db, "prompt_change", "Updated genesis prompt");

      const report = generateAuditReport(db);
      // Should not have trailing parentheses
      const lines = report.split("\n");
      const entryLine = lines.find((l) =>
        l.includes("prompt_change: Updated genesis prompt"),
      );
      expect(entryLine).toBeDefined();
      expect(entryLine).not.toContain("()");
    });

    it("includes timestamps in entry lines", () => {
      logModification(db, "code_edit", "Test");

      const report = generateAuditReport(db);
      // Entries are formatted as [timestamp] type: description
      const lines = report.split("\n");
      const entryLine = lines.find((l) => l.includes("code_edit: Test"));
      expect(entryLine).toMatch(/^\[.+\] code_edit: Test$/);
    });

    it("handles up to 100 entries", () => {
      for (let i = 0; i < 50; i++) {
        logModification(db, "code_edit", `Edit ${i}`);
      }

      const report = generateAuditReport(db);
      expect(report).toContain("Total modifications: 50");
    });
  });
});
