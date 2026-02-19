/**
 * Local Compute Provider
 *
 * Executes commands directly on the host machine via child_process.
 * Reads/writes files via Node.js fs module.
 * This is the "bare metal" compute backend — no Conway sandbox needed.
 *
 * Security considerations:
 * - Path validation prevents directory traversal
 * - Command timeouts prevent hung processes
 * - File size limits prevent disk exhaustion
 * - Optional path jailing restricts file access
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve, normalize, isAbsolute } from "node:path";
import type { ExecResult } from "../types.js";
import type { ComputeProvider, LocalComputeConfig } from "./provider.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB stdout/stderr cap

export function createLocalComputeProvider(
  config: LocalComputeConfig = {},
): ComputeProvider {
  const workDir = config.workDir || process.cwd();
  const defaultTimeoutMs = config.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = config.maxTimeoutMs || MAX_TIMEOUT_MS;
  const shell = config.shell || "/bin/sh";
  const envOverrides = config.env || {};
  const maxFileSizeBytes = config.maxFileSizeBytes || MAX_FILE_SIZE_BYTES;
  const allowedPaths = (config.allowedPaths || []).map((p) =>
    resolve(normalize(p)),
  );

  function validatePath(filePath: string): string {
    // Resolve to absolute path
    const resolved = isAbsolute(filePath)
      ? resolve(normalize(filePath))
      : resolve(workDir, normalize(filePath));

    // Check for null bytes (path traversal attack)
    if (resolved.includes("\0")) {
      throw new Error("Path contains null bytes");
    }

    // Jail check: if allowedPaths is set, file must be under one of them
    if (allowedPaths.length > 0) {
      const isAllowed = allowedPaths.some((base) =>
        resolved.startsWith(base + "/") || resolved === base,
      );
      if (!isAllowed) {
        throw new Error(
          `Path outside allowed directories: ${filePath}`,
        );
      }
    }

    return resolved;
  }

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    const effectiveTimeout = Math.min(
      timeout || defaultTimeoutMs,
      maxTimeoutMs,
    );

    return new Promise<ExecResult>((resolvePromise) => {
      const child = execFile(
        shell,
        ["-c", command],
        {
          cwd: workDir,
          timeout: effectiveTimeout,
          maxBuffer: MAX_OUTPUT_SIZE,
          env: { ...process.env, ...envOverrides },
          killSignal: "SIGTERM",
        },
        (error, stdout, stderr) => {
          if (error && "killed" in error && error.killed) {
            resolvePromise({
              stdout: stdout || "",
              stderr: `Command timed out after ${effectiveTimeout}ms\n${stderr || ""}`,
              exitCode: 124, // Standard timeout exit code
            });
            return;
          }

          resolvePromise({
            stdout: stdout || "",
            stderr: stderr || "",
            exitCode: error ? (error as any).code ?? 1 : 0,
          });
        },
      );

      // Safety net: if the child process doesn't exit within timeout + 5s, kill it
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited
        }
      }, effectiveTimeout + 5000);

      child.on("exit", () => clearTimeout(killTimer));
    });
  };

  const writeFile = async (
    filePath: string,
    content: string,
  ): Promise<void> => {
    const resolved = validatePath(filePath);

    // Check file size
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > maxFileSizeBytes) {
      throw new Error(
        `File size ${byteLength} bytes exceeds limit of ${maxFileSizeBytes} bytes`,
      );
    }

    // Ensure parent directory exists
    const dir = resolve(resolved, "..");
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(resolved, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    const resolved = validatePath(filePath);

    // Check file size before reading
    const stat = await fs.stat(resolved);
    if (stat.size > maxFileSizeBytes) {
      throw new Error(
        `File size ${stat.size} bytes exceeds read limit of ${maxFileSizeBytes} bytes`,
      );
    }

    return fs.readFile(resolved, "utf-8");
  };

  const healthCheck = async (): Promise<boolean> => {
    try {
      const result = await exec("echo ok", 5000);
      return result.exitCode === 0 && result.stdout.trim() === "ok";
    } catch {
      return false;
    }
  };

  return {
    name: "local",
    exec,
    writeFile,
    readFile,
    healthCheck,
  };
}
