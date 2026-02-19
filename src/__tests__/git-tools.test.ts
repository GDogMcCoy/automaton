/**
 * Git Tools Tests
 *
 * Tests for the git operations module: shell escaping, URL validation,
 * diff truncation, log clamping, and proper use of escaped arguments.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockConwayClient } from "./mocks.js";
import {
  gitStatus,
  gitDiff,
  gitCommit,
  gitLog,
  gitPush,
  gitBranch,
  gitClone,
  gitInit,
} from "../git/tools.js";

describe("Git Tools", () => {
  let conway: MockConwayClient;

  beforeEach(() => {
    conway = new MockConwayClient();
  });

  // ─── escapeShellArg (tested indirectly through exec calls) ────

  describe("shell argument escaping", () => {
    it("escapes single quotes in repo paths", async () => {
      await gitStatus(conway, "/path/with'quote");
      const cmd = conway.execCalls[0].command;
      // The escaped path should wrap in single quotes and break-escape internal quotes
      expect(cmd).toContain("'/path/with'\\''quote'");
    });

    it("escapes single quotes in commit messages", async () => {
      await gitCommit(conway, "/repo", "it's a test");
      // The commit call is the second exec (first is git add -A)
      const commitCmd = conway.execCalls[1].command;
      expect(commitCmd).toContain("'it'\\''s a test'");
    });

    it("escapes single quotes in branch names", async () => {
      await gitBranch(conway, "/repo", "create", "feature'branch");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'feature'\\''branch'");
    });

    it("wraps clean paths in single quotes", async () => {
      await gitInit(conway, "/my/repo");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'/my/repo'");
    });
  });

  // ─── gitClone URL validation ──────────────────────────────────

  describe("gitClone", () => {
    it("rejects URLs without valid protocol prefix", async () => {
      await expect(gitClone(conway, "file:///etc/passwd", "/tmp/out")).rejects.toThrow(
        "Invalid git URL",
      );
    });

    it("rejects bare paths (command injection attempt)", async () => {
      await expect(
        gitClone(conway, "--upload-pack=evil /tmp/out", "/tmp/dest"),
      ).rejects.toThrow("Invalid git URL");
    });

    it("rejects ftp:// URLs", async () => {
      await expect(
        gitClone(conway, "ftp://example.com/repo.git", "/tmp/out"),
      ).rejects.toThrow("Invalid git URL");
    });

    it("rejects javascript: pseudo-protocol", async () => {
      await expect(
        gitClone(conway, "javascript:alert(1)", "/tmp/out"),
      ).rejects.toThrow("Invalid git URL");
    });

    it("accepts https:// URLs", async () => {
      await gitClone(conway, "https://github.com/user/repo.git", "/tmp/out");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("git clone");
      expect(cmd).toContain("'https://github.com/user/repo.git'");
    });

    it("accepts http:// URLs", async () => {
      await gitClone(conway, "http://github.com/user/repo.git", "/tmp/out");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("git clone");
    });

    it("accepts git@ URLs (SSH shorthand)", async () => {
      await gitClone(conway, "git@github.com:user/repo.git", "/tmp/out");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'git@github.com:user/repo.git'");
    });

    it("accepts ssh:// URLs", async () => {
      await gitClone(conway, "ssh://git@github.com/user/repo.git", "/tmp/out");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("ssh://git@github.com/user/repo.git");
    });

    it("escapes the target path", async () => {
      await gitClone(conway, "https://example.com/repo.git", "/tmp/my repo");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'/tmp/my repo'");
    });

    it("applies --depth flag when provided", async () => {
      await gitClone(conway, "https://example.com/repo.git", "/tmp/out", 1);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("--depth 1");
    });

    it("clamps depth to at least 1", async () => {
      await gitClone(conway, "https://example.com/repo.git", "/tmp/out", -5);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("--depth 1");
    });

    it("clamps depth to at most 10000", async () => {
      await gitClone(conway, "https://example.com/repo.git", "/tmp/out", 99999);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("--depth 10000");
    });

    it("throws when exec returns non-zero exit code", async () => {
      conway.exec = async () => ({ stdout: "", stderr: "fatal: repo not found", exitCode: 128 });
      await expect(
        gitClone(conway, "https://example.com/repo.git", "/tmp/out"),
      ).rejects.toThrow("Git clone failed");
    });
  });

  // ─── gitDiff truncation ───────────────────────────────────────

  describe("gitDiff", () => {
    it("returns full output when under limit", async () => {
      conway.exec = async () => ({
        stdout: "diff --git a/file.ts b/file.ts\n+added line",
        stderr: "",
        exitCode: 0,
      });
      const result = await gitDiff(conway, "/repo");
      expect(result).toBe("diff --git a/file.ts b/file.ts\n+added line");
    });

    it("returns '(no changes)' when stdout is empty", async () => {
      conway.exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
      const result = await gitDiff(conway, "/repo");
      expect(result).toBe("(no changes)");
    });

    it("truncates output larger than MAX_DIFF_OUTPUT (500KB)", async () => {
      const largeOutput = "x".repeat(600_000);
      conway.exec = async () => ({ stdout: largeOutput, stderr: "", exitCode: 0 });
      const result = await gitDiff(conway, "/repo");
      expect(result.length).toBeLessThan(largeOutput.length);
      expect(result).toContain("... (truncated,");
      expect(result).toContain("chars omitted)");
      // First 500K characters should be preserved
      expect(result.startsWith("x".repeat(500_000))).toBe(true);
    });

    it("does not truncate output exactly at the limit", async () => {
      const exactOutput = "y".repeat(500_000);
      conway.exec = async () => ({ stdout: exactOutput, stderr: "", exitCode: 0 });
      const result = await gitDiff(conway, "/repo");
      expect(result).toBe(exactOutput);
      expect(result).not.toContain("truncated");
    });

    it("passes --cached flag when staged=true", async () => {
      await gitDiff(conway, "/repo", true);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("--cached");
    });

    it("does not pass --cached flag when staged=false", async () => {
      await gitDiff(conway, "/repo", false);
      const cmd = conway.execCalls[0].command;
      expect(cmd).not.toContain("--cached");
    });
  });

  // ─── gitLog clamping ──────────────────────────────────────────

  describe("gitLog", () => {
    it("clamps limit to minimum of 1", async () => {
      await gitLog(conway, "/repo", -10);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("-n 1");
    });

    it("clamps limit to minimum of 1 for zero", async () => {
      await gitLog(conway, "/repo", 0);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("-n 1");
    });

    it("clamps limit to maximum of 1000", async () => {
      await gitLog(conway, "/repo", 5000);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("-n 1000");
    });

    it("uses provided limit when within bounds", async () => {
      await gitLog(conway, "/repo", 25);
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("-n 25");
    });

    it("defaults to limit of 10", async () => {
      await gitLog(conway, "/repo");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("-n 10");
    });

    it("parses log output into entries", async () => {
      conway.exec = async () => ({
        stdout: "abc123|Initial commit|Author|2024-01-01 00:00:00 +0000\ndef456|Second commit|Author|2024-01-02 00:00:00 +0000",
        stderr: "",
        exitCode: 0,
      });
      const entries = await gitLog(conway, "/repo", 10);
      expect(entries).toHaveLength(2);
      expect(entries[0].hash).toBe("abc123");
      expect(entries[0].message).toBe("Initial commit");
      expect(entries[1].hash).toBe("def456");
    });

    it("returns empty array for empty output", async () => {
      conway.exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
      const entries = await gitLog(conway, "/repo");
      expect(entries).toEqual([]);
    });

    it("uses escaped path in command", async () => {
      await gitLog(conway, "/my repo/project");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'/my repo/project'");
    });
  });

  // ─── gitStatus parsing ────────────────────────────────────────

  describe("gitStatus", () => {
    it("parses branch from porcelain output", async () => {
      conway.exec = async () => ({
        stdout: "## main...origin/main\n",
        stderr: "",
        exitCode: 0,
      });
      const status = await gitStatus(conway, "/repo");
      expect(status.branch).toBe("main");
    });

    it("detects staged files", async () => {
      conway.exec = async () => ({
        stdout: "## main\nM  staged-file.ts\nA  new-file.ts\n",
        stderr: "",
        exitCode: 0,
      });
      const status = await gitStatus(conway, "/repo");
      expect(status.staged).toContain("staged-file.ts");
      expect(status.staged).toContain("new-file.ts");
    });

    it("detects modified (unstaged) files", async () => {
      conway.exec = async () => ({
        stdout: "## main\n M modified-file.ts\n",
        stderr: "",
        exitCode: 0,
      });
      const status = await gitStatus(conway, "/repo");
      expect(status.modified).toContain("modified-file.ts");
    });

    it("detects untracked files", async () => {
      conway.exec = async () => ({
        stdout: "## main\n?? untracked.ts\n",
        stderr: "",
        exitCode: 0,
      });
      const status = await gitStatus(conway, "/repo");
      expect(status.untracked).toContain("untracked.ts");
    });

    it("reports clean when no changes", async () => {
      conway.exec = async () => ({
        stdout: "## main\n",
        stderr: "",
        exitCode: 0,
      });
      const status = await gitStatus(conway, "/repo");
      expect(status.clean).toBe(true);
    });

    it("reports not clean when there are changes", async () => {
      conway.exec = async () => ({
        stdout: "## main\n?? something.txt\n",
        stderr: "",
        exitCode: 0,
      });
      const status = await gitStatus(conway, "/repo");
      expect(status.clean).toBe(false);
    });
  });

  // ─── gitCommit ────────────────────────────────────────────────

  describe("gitCommit", () => {
    it("runs git add -A before committing when addAll is true", async () => {
      await gitCommit(conway, "/repo", "test commit", true);
      expect(conway.execCalls).toHaveLength(2);
      expect(conway.execCalls[0].command).toContain("git add -A");
      expect(conway.execCalls[1].command).toContain("git commit");
    });

    it("skips git add -A when addAll is false", async () => {
      await gitCommit(conway, "/repo", "test commit", false);
      expect(conway.execCalls).toHaveLength(1);
      expect(conway.execCalls[0].command).toContain("git commit");
    });

    it("throws on non-zero exit code", async () => {
      conway.exec = async () => ({
        stdout: "",
        stderr: "fatal: not a git repo",
        exitCode: 128,
      });
      await expect(gitCommit(conway, "/repo", "test", false)).rejects.toThrow(
        "Git commit failed",
      );
    });
  });

  // ─── gitPush ──────────────────────────────────────────────────

  describe("gitPush", () => {
    it("escapes remote and branch arguments", async () => {
      await gitPush(conway, "/repo", "origin", "main");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'origin'");
      expect(cmd).toContain("'main'");
    });

    it("defaults remote to origin", async () => {
      await gitPush(conway, "/repo");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("'origin'");
    });

    it("throws on non-zero exit code", async () => {
      conway.exec = async () => ({
        stdout: "",
        stderr: "error: failed to push",
        exitCode: 1,
      });
      await expect(gitPush(conway, "/repo")).rejects.toThrow("Git push failed");
    });
  });

  // ─── gitBranch ────────────────────────────────────────────────

  describe("gitBranch", () => {
    it("lists branches with 'list' action", async () => {
      await gitBranch(conway, "/repo", "list");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("git branch -a");
    });

    it("throws when branch name missing for create", async () => {
      await expect(gitBranch(conway, "/repo", "create")).rejects.toThrow(
        "Branch name required",
      );
    });

    it("throws when branch name missing for checkout", async () => {
      await expect(gitBranch(conway, "/repo", "checkout")).rejects.toThrow(
        "Branch name required",
      );
    });

    it("throws when branch name missing for delete", async () => {
      await expect(gitBranch(conway, "/repo", "delete")).rejects.toThrow(
        "Branch name required",
      );
    });

    it("creates branch with checkout -b", async () => {
      await gitBranch(conway, "/repo", "create", "feature-x");
      const cmd = conway.execCalls[0].command;
      expect(cmd).toContain("git checkout -b");
      expect(cmd).toContain("'feature-x'");
    });
  });
});
