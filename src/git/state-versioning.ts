/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * Every self-modification triggers a git commit with a descriptive message.
 * The automaton's entire identity history is version-controlled and replayable.
 */

import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitStatus, gitLog } from "./tools.js";

const AUTOMATON_DIR = "~/.automaton";

function resolveHome(p: string): string {
  const home = process.env.HOME || "/root";
  if (p.startsWith("~")) {
    return `${home}${p.slice(1)}`;
  }
  return p;
}

/**
 * Initialize git repo for the automaton's state directory.
 * Creates .gitignore to exclude sensitive files.
 */
export async function initStateRepo(
  conway: ConwayClient,
): Promise<void> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if already initialized
  const checkResult = await conway.exec(
    `test -d ${dir}/.git && echo "exists" || echo "nope"`,
    5000,
  );

  if (checkResult.stdout.trim() === "exists") {
    return;
  }

  // Initialize
  await gitInit(conway, dir);

  // Create .gitignore for sensitive files
  const gitignore = `# Sensitive files - never commit
wallet.json
config.json
state.db
state.db-wal
state.db-shm
logs/
*.log
*.err
`;

  await conway.writeFile(`${dir}/.gitignore`, gitignore);

  // Configure git user (local to this repo, not global)
  await conway.exec(
    `cd ${dir} && git config --local user.name "Automaton" && git config --local user.email "automaton@conway.tech"`,
    5000,
  );

  // Initial commit
  await gitCommit(conway, dir, "genesis: automaton state repository initialized");
}

/**
 * Commit a state change with a descriptive message.
 * Called after any self-modification.
 */
export async function commitStateChange(
  conway: ConwayClient,
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if there are changes
  const status = await gitStatus(conway, dir);
  if (status.clean) {
    return "No changes to commit";
  }

  const message = `${category}: ${description}`;
  const result = await gitCommit(conway, dir, message);
  return result;
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  conway: ConwayClient,
  skillName: string,
  action: "install" | "remove" | "update",
): Promise<string> {
  return commitStateChange(
    conway,
    `${action} skill: ${skillName}`,
    "skill",
  );
}

/**
 * Commit after heartbeat config change.
 */
export async function commitHeartbeatChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "heartbeat");
}

/**
 * Commit after config change.
 */
export async function commitConfigChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "config");
}

/**
 * Get the state repo history.
 */
export async function getStateHistory(
  conway: ConwayClient,
  limit: number = 20,
) {
  const dir = resolveHome(AUTOMATON_DIR);
  return gitLog(conway, dir, limit);
}

// ─── Upstream Review Safety ──────────────────────────────────────

/** Maximum number of upstream commits to review at once. */
const MAX_UPSTREAM_COMMITS = 50;

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Fetch origin and return the list of new upstream commits on origin/main
 * that are not yet in HEAD. Returns at most MAX_UPSTREAM_COMMITS entries.
 */
export async function reviewUpstreamChanges(
  conway: ConwayClient,
  repoPath: string,
): Promise<{ hash: string; message: string }[]> {
  const safePath = escapeShellArg(repoPath);

  // Fetch latest from origin
  await conway.exec(`cd ${safePath} && git fetch origin 2>&1`, 30000);

  // List commits that are on origin/main but not in HEAD
  const result = await conway.exec(
    `cd ${safePath} && git log HEAD..origin/main --oneline -n ${MAX_UPSTREAM_COMMITS} 2>/dev/null`,
    10000,
  );

  if (!result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) return { hash: line, message: "" };
      return {
        hash: line.slice(0, spaceIdx),
        message: line.slice(spaceIdx + 1),
      };
    });
}

/**
 * Cherry-pick a specific commit by hash.
 * Validates the commit hash format before executing.
 * Returns { success: true } or { success: false, error: string }.
 */
export async function cherryPickCommit(
  conway: ConwayClient,
  repoPath: string,
  commitHash: string,
): Promise<{ success: boolean; error?: string }> {
  // Validate commit hash format: full 40 hex chars or abbreviated 7+ hex chars
  const hashPattern = /^[0-9a-fA-F]{7,40}$/;
  if (!hashPattern.test(commitHash)) {
    return {
      success: false,
      error: `Invalid commit hash format: "${commitHash}". Must be 7-40 hex characters.`,
    };
  }

  const safePath = escapeShellArg(repoPath);
  const safeHash = escapeShellArg(commitHash);

  const result = await conway.exec(
    `cd ${safePath} && git cherry-pick ${safeHash} 2>&1`,
    30000,
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: result.stderr || result.stdout || "Cherry-pick failed",
    };
  }

  return { success: true };
}
