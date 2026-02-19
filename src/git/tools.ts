/**
 * Git Tools
 *
 * Built-in git operations for the automaton.
 * Used for both state versioning and code development.
 *
 * Security notes:
 * - All user-provided strings (messages, branch names, paths) are shell-escaped
 * - Diff output is capped to prevent memory exhaustion
 * - Repo paths are validated before use
 */

import type { ConwayClient, GitStatus, GitLogEntry } from "../types.js";

/** Maximum diff output size (characters) to prevent memory exhaustion */
const MAX_DIFF_OUTPUT = 500_000; // 500KB

/**
 * Get git status for a repository.
 */
export async function gitStatus(
  conway: ConwayClient,
  repoPath: string,
): Promise<GitStatus> {
  const safePath = escapeShellArg(repoPath);
  const result = await conway.exec(
    `cd ${safePath} && git status --porcelain -b 2>/dev/null`,
    10000,
  );

  const lines = result.stdout.split("\n").filter(Boolean);
  let branch = "unknown";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0];
      continue;
    }

    const statusCode = line.slice(0, 2);
    const file = line.slice(3);

    if (statusCode[0] !== " " && statusCode[0] !== "?") {
      staged.push(file);
    }
    if (statusCode[1] === "M" || statusCode[1] === "D") {
      modified.push(file);
    }
    if (statusCode === "??") {
      untracked.push(file);
    }
  }

  return {
    branch,
    staged,
    modified,
    untracked,
    clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
  };
}

/**
 * Get git diff output.
 */
export async function gitDiff(
  conway: ConwayClient,
  repoPath: string,
  staged: boolean = false,
): Promise<string> {
  const safePath = escapeShellArg(repoPath);
  const flag = staged ? "--cached" : "";
  const result = await conway.exec(
    `cd ${safePath} && git diff ${flag} 2>/dev/null`,
    10000,
  );
  const output = result.stdout || "(no changes)";
  // Cap diff output to prevent memory exhaustion on huge diffs
  if (output.length > MAX_DIFF_OUTPUT) {
    return output.slice(0, MAX_DIFF_OUTPUT) + `\n... (truncated, ${output.length - MAX_DIFF_OUTPUT} chars omitted)`;
  }
  return output;
}

/**
 * Create a git commit.
 */
export async function gitCommit(
  conway: ConwayClient,
  repoPath: string,
  message: string,
  addAll: boolean = true,
): Promise<string> {
  const safePath = escapeShellArg(repoPath);
  if (addAll) {
    await conway.exec(`cd ${safePath} && git add -A`, 10000);
  }

  const result = await conway.exec(
    `cd ${safePath} && git commit -m ${escapeShellArg(message)} --allow-empty 2>&1`,
    10000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git commit failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

/**
 * Get git log.
 */
export async function gitLog(
  conway: ConwayClient,
  repoPath: string,
  limit: number = 10,
): Promise<GitLogEntry[]> {
  const safePath = escapeShellArg(repoPath);
  const safeLimit = Math.max(1, Math.min(limit, 1000)); // clamp 1-1000
  const result = await conway.exec(
    `cd ${safePath} && git log --format="%H|%s|%an|%ai" -n ${safeLimit} 2>/dev/null`,
    10000,
  );

  if (!result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, message, author, date] = line.split("|");
      return { hash, message, author, date };
    });
}

/**
 * Push to remote.
 */
export async function gitPush(
  conway: ConwayClient,
  repoPath: string,
  remote: string = "origin",
  branch?: string,
): Promise<string> {
  const safePath = escapeShellArg(repoPath);
  const safeRemote = escapeShellArg(remote);
  const branchArg = branch ? ` ${escapeShellArg(branch)}` : "";
  const result = await conway.exec(
    `cd ${safePath} && git push ${safeRemote}${branchArg} 2>&1`,
    30000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git push failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout || "Push successful";
}

/**
 * Manage branches.
 */
export async function gitBranch(
  conway: ConwayClient,
  repoPath: string,
  action: "list" | "create" | "checkout" | "delete",
  branchName?: string,
): Promise<string> {
  const safePath = escapeShellArg(repoPath);
  let cmd: string;

  switch (action) {
    case "list":
      cmd = `cd ${safePath} && git branch -a 2>/dev/null`;
      break;
    case "create":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${safePath} && git checkout -b ${escapeShellArg(branchName)} 2>&1`;
      break;
    case "checkout":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${safePath} && git checkout ${escapeShellArg(branchName)} 2>&1`;
      break;
    case "delete":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${safePath} && git branch -d ${escapeShellArg(branchName)} 2>&1`;
      break;
    default:
      throw new Error(`Unknown branch action: ${action}`);
  }

  const result = await conway.exec(cmd, 10000);
  return result.stdout || result.stderr || "Done";
}

/**
 * Clone a repository.
 */
export async function gitClone(
  conway: ConwayClient,
  url: string,
  targetPath: string,
  depth?: number,
): Promise<string> {
  // Validate URL to prevent command injection via crafted git URLs
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
    throw new Error(`Invalid git URL: must start with https://, http://, git@, or ssh://`);
  }

  const safeUrl = escapeShellArg(url);
  const safePath = escapeShellArg(targetPath);
  const depthArg = depth ? ` --depth ${Math.max(1, Math.min(depth, 10000))}` : "";
  const result = await conway.exec(
    `git clone${depthArg} ${safeUrl} ${safePath} 2>&1`,
    120000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git clone failed: ${result.stderr || result.stdout}`);
  }

  return `Cloned ${url} to ${targetPath}`;
}

/**
 * Initialize a git repository.
 */
export async function gitInit(
  conway: ConwayClient,
  repoPath: string,
): Promise<string> {
  const safePath = escapeShellArg(repoPath);
  const result = await conway.exec(
    `cd ${safePath} && git init 2>&1`,
    10000,
  );
  return result.stdout || "Git initialized";
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
