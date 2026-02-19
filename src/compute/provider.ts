/**
 * Compute Provider Interface
 *
 * Abstraction layer for executing commands and managing files.
 * Replaces Conway sandbox operations with pluggable backends:
 * - local: child_process + fs (bare metal / systemd)
 * - docker: Docker container exec (isolated)
 *
 * The automaton doesn't need Conway's sandbox — it needs exec, readFile,
 * writeFile, and optionally port exposure. This interface provides exactly that.
 */

import type { ExecResult, PortInfo } from "../types.js";

/**
 * A compute provider that can execute commands and manage files.
 * This is the minimal surface area the automaton needs from its host.
 */
export interface ComputeProvider {
  /** Provider name for logging/metrics */
  readonly name: string;

  /** Execute a shell command */
  exec(command: string, timeout?: number): Promise<ExecResult>;

  /** Write a file to the filesystem */
  writeFile(path: string, content: string): Promise<void>;

  /** Read a file from the filesystem */
  readFile(path: string): Promise<string>;

  /** Expose a local port via reverse proxy / tunnel (optional) */
  exposePort?(port: number): Promise<PortInfo>;

  /** Remove a previously exposed port */
  removePort?(port: number): Promise<void>;

  /** Check if the provider is available and functional */
  healthCheck(): Promise<boolean>;

  /** Clean up resources on shutdown */
  dispose?(): Promise<void>;
}

/**
 * Configuration for the local compute provider (bare metal).
 */
export interface LocalComputeConfig {
  /** Working directory for command execution (default: process.cwd()) */
  workDir?: string;
  /** Default command timeout in ms (default: 120000) */
  defaultTimeoutMs?: number;
  /** Maximum allowed command timeout in ms (default: 300000) */
  maxTimeoutMs?: number;
  /** Shell to use for command execution (default: /bin/sh) */
  shell?: string;
  /** Environment variables to inject into commands */
  env?: Record<string, string>;
  /** Maximum file size in bytes that can be written (default: 50MB) */
  maxFileSizeBytes?: number;
  /** Allowed base paths for file operations (jail). Empty = no restriction. */
  allowedPaths?: string[];
}

/**
 * Configuration for the Docker compute provider.
 */
export interface DockerComputeConfig {
  /** Docker image to use */
  image: string;
  /** Container name (auto-generated if not provided) */
  containerName?: string;
  /** Working directory inside the container */
  workDir?: string;
  /** Default command timeout in ms (default: 120000) */
  defaultTimeoutMs?: number;
  /** Maximum memory in MB (default: 512) */
  memoryMb?: number;
  /** CPU limit (e.g., "1.0" for 1 core, default: "1.0") */
  cpuLimit?: string;
  /** Volume mounts (host:container format) */
  volumes?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Network mode (default: "bridge") */
  networkMode?: string;
  /** Whether to auto-remove the container on dispose (default: true) */
  autoRemove?: boolean;
}

export type ComputeProviderType = "local" | "docker";

export interface ComputeProviderConfig {
  type: ComputeProviderType;
  local?: LocalComputeConfig;
  docker?: DockerComputeConfig;
}
