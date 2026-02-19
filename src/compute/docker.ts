/**
 * Docker Compute Provider
 *
 * Executes commands inside a Docker container, providing isolation
 * without requiring Conway's sandbox infrastructure.
 *
 * Lifecycle:
 * 1. ensureContainer() — creates/starts a container if not running
 * 2. exec() — runs commands via `docker exec`
 * 3. writeFile/readFile — copy files in/out of the container
 * 4. dispose() — stops and removes the container
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExecResult } from "../types.js";
import type { ComputeProvider, DockerComputeConfig } from "./provider.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

export function createDockerComputeProvider(
  config: DockerComputeConfig,
): ComputeProvider {
  const containerName =
    config.containerName || `automaton-${randomBytes(4).toString("hex")}`;
  const image = config.image;
  const workDir = config.workDir || "/workspace";
  const defaultTimeoutMs = config.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
  const memoryMb = config.memoryMb || 512;
  const cpuLimit = config.cpuLimit || "1.0";
  const volumes = config.volumes || [];
  const envVars = config.env || {};
  const networkMode = config.networkMode || "bridge";
  const autoRemove = config.autoRemove !== false;

  let containerStarted = false;

  function dockerExec(
    args: string[],
    timeout: number,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        "docker",
        args,
        {
          timeout,
          maxBuffer: MAX_OUTPUT_SIZE,
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (error && "killed" in error && error.killed) {
            resolve({
              stdout: stdout || "",
              stderr: `Docker command timed out after ${timeout}ms\n${stderr || ""}`,
              exitCode: 124,
            });
            return;
          }

          resolve({
            stdout: stdout || "",
            stderr: stderr || "",
            exitCode: error ? (error as any).code ?? 1 : 0,
          });
        },
      );
    });
  }

  async function ensureContainer(): Promise<void> {
    if (containerStarted) return;

    // Check if container already exists and is running
    const inspect = await dockerExec(
      ["inspect", "--format", "{{.State.Running}}", containerName],
      10_000,
    );

    if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
      containerStarted = true;
      return;
    }

    // Remove stale container if it exists but isn't running
    if (inspect.exitCode === 0) {
      await dockerExec(["rm", "-f", containerName], 10_000);
    }

    // Build docker run args
    const runArgs = [
      "run",
      "-d",
      "--name", containerName,
      "--memory", `${memoryMb}m`,
      "--cpus", cpuLimit,
      "--network", networkMode,
      "-w", workDir,
    ];

    // Add volumes
    for (const vol of volumes) {
      runArgs.push("-v", vol);
    }

    // Add environment variables
    for (const [key, value] of Object.entries(envVars)) {
      runArgs.push("-e", `${key}=${value}`);
    }

    // Use a long-running entrypoint so the container stays alive
    runArgs.push(image, "tail", "-f", "/dev/null");

    const result = await dockerExec(runArgs, 60_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to start Docker container: ${result.stderr}`,
      );
    }

    containerStarted = true;
  }

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    await ensureContainer();

    const effectiveTimeout = timeout || defaultTimeoutMs;
    const args = [
      "exec",
      "-w", workDir,
      containerName,
      "/bin/sh",
      "-c",
      command,
    ];

    return dockerExec(args, effectiveTimeout);
  };

  const writeFile = async (
    filePath: string,
    content: string,
  ): Promise<void> => {
    await ensureContainer();

    // Write to a temp file, then docker cp it in
    const tmpFile = join(
      tmpdir(),
      `automaton-${randomBytes(8).toString("hex")}`,
    );

    try {
      await fs.writeFile(tmpFile, content, "utf-8");

      // Ensure parent directory exists in container
      const dir = filePath.replace(/\/[^/]+$/, "");
      if (dir && dir !== filePath) {
        await dockerExec(
          ["exec", containerName, "mkdir", "-p", dir],
          10_000,
        );
      }

      // Copy file into container
      const result = await dockerExec(
        ["cp", tmpFile, `${containerName}:${filePath}`],
        30_000,
      );

      if (result.exitCode !== 0) {
        throw new Error(`docker cp failed: ${result.stderr}`);
      }
    } finally {
      // Clean up temp file
      await fs.unlink(tmpFile).catch(() => {});
    }
  };

  const readFile = async (filePath: string): Promise<string> => {
    await ensureContainer();

    // Read file via docker exec cat
    const result = await dockerExec(
      ["exec", containerName, "cat", filePath],
      30_000,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to read file ${filePath}: ${result.stderr}`,
      );
    }

    return result.stdout;
  };

  const healthCheck = async (): Promise<boolean> => {
    try {
      // Check if Docker is available
      const dockerCheck = await dockerExec(["info", "--format", "{{.ServerVersion}}"], 5_000);
      if (dockerCheck.exitCode !== 0) return false;

      await ensureContainer();
      const result = await exec("echo ok", 5000);
      return result.exitCode === 0 && result.stdout.trim() === "ok";
    } catch {
      return false;
    }
  };

  const dispose = async (): Promise<void> => {
    if (!containerStarted) return;

    if (autoRemove) {
      await dockerExec(["rm", "-f", containerName], 15_000);
    } else {
      await dockerExec(["stop", "-t", "10", containerName], 15_000);
    }

    containerStarted = false;
  };

  return {
    name: "docker",
    exec,
    writeFile,
    readFile,
    healthCheck,
    dispose,
  };
}
