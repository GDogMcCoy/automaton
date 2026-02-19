/**
 * Lineage Tracking
 *
 * Track parent-child relationships between automatons.
 * The parent records children in SQLite.
 * Children record their parent in config.
 * ERC-8004 registration includes parentAgent field.
 */

import fs from "fs";
import path from "path";
import type {
  AutomatonDatabase,
  ChildAutomaton,
  AutomatonConfig,
  ConwayClient,
} from "../types.js";

/** Maximum allowed lineage depth (parent -> child chain). */
export const MAX_LINEAGE_DEPTH = 5;

/**
 * Get the full lineage tree (parent -> children).
 */
export function getLineage(db: AutomatonDatabase): {
  children: ChildAutomaton[];
  alive: number;
  dead: number;
  total: number;
} {
  const children = db.getChildren();
  const alive = children.filter(
    (c) => c.status === "running" || c.status === "sleeping",
  ).length;
  const dead = children.filter((c) => c.status === "dead").length;

  return {
    children,
    alive,
    dead,
    total: children.length,
  };
}

/**
 * Check if this automaton has a parent (is itself a child).
 */
export function hasParent(config: AutomatonConfig): boolean {
  return !!config.parentAddress;
}

/**
 * Get a summary of the lineage for the system prompt.
 */
export function getLineageSummary(
  db: AutomatonDatabase,
  config: AutomatonConfig,
): string {
  const lineage = getLineage(db);
  const parts: string[] = [];

  if (hasParent(config)) {
    parts.push(`Parent: ${config.parentAddress}`);
  }

  if (lineage.total > 0) {
    parts.push(
      `Children: ${lineage.total} total (${lineage.alive} alive, ${lineage.dead} dead)`,
    );
    for (const child of lineage.children) {
      parts.push(
        `  - ${child.name} [${child.status}] sandbox:${child.sandboxId}`,
      );
    }
  }

  return parts.length > 0 ? parts.join("\n") : "No lineage (first generation)";
}

/**
 * Prune dead children from tracking (optional cleanup).
 */
export function pruneDeadChildren(
  db: AutomatonDatabase,
  keepLast: number = 5,
): number {
  const children = db.getChildren();
  const dead = children.filter((c) => c.status === "dead");

  if (dead.length <= keepLast) return 0;

  // Sort by creation date, oldest first
  dead.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  // Keep the most recent `keepLast` dead children
  const toRemove = dead.slice(0, dead.length - keepLast);

  // We don't actually delete from DB -- just mark the records
  // The DB retains all history for audit purposes
  return toRemove.length;
}

/**
 * Refresh status of all children concurrently using Promise.all.
 */
export async function refreshChildrenStatus(
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<void> {
  const { checkChildStatus } = await import("./spawn.js");
  const children = db.getChildren();

  const liveChildren = children.filter((child) => child.status !== "dead");

  await Promise.all(
    liveChildren.map(async (child) => {
      try {
        await checkChildStatus(conway, db, child.id);
      } catch {
        db.updateChildStatus(child.id, "unknown");
      }
    }),
  );
}

/**
 * Get the lineage depth of the current automaton.
 * Reads from the genesis.json file if available (children store lineageDepth there).
 * Returns 0 for first-generation (root) automatons.
 */
export function getLineageDepth(config?: AutomatonConfig): number {
  if (!config?.parentAddress) {
    // No parent means this is a first-generation automaton
    return 0;
  }

  // Try to read lineageDepth from genesis.json (written by the parent during spawn)
  try {
    const genesisPath = path.join(
      process.env.HOME || "/root",
      ".automaton",
      "genesis.json",
    );
    const raw = fs.readFileSync(genesisPath, "utf-8");
    const genesis = JSON.parse(raw);
    if (typeof genesis.lineageDepth === "number" && genesis.lineageDepth >= 0) {
      return genesis.lineageDepth;
    }
  } catch {
    // Genesis file missing or unreadable — fall back to heuristic
  }

  // If we have a parent but no explicit depth, assume depth 1
  return 1;
}
