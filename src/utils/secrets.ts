/**
 * Secrets Management
 *
 * Provides a unified interface for loading secrets from multiple backends.
 * Supports:
 *   - Environment variables (default, always available)
 *   - File-based secrets (Docker secrets, Kubernetes secrets)
 *   - JSON config file (~/.automaton/secrets.json with 0600 perms)
 *
 * Priority order (highest wins):
 *   1. Environment variables
 *   2. Secrets file (/run/secrets/<name> or custom path)
 *   3. JSON config file
 *
 * Usage:
 *   import { loadSecret, loadSecrets } from "../utils/secrets.js";
 *   const apiKey = loadSecret("CONWAY_API_KEY");
 */

import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("secrets");

export interface SecretsConfig {
  /** Directory for file-based secrets (default: /run/secrets) */
  secretsDir?: string;
  /** Path to JSON secrets file (default: ~/.automaton/secrets.json) */
  jsonSecretsPath?: string;
}

/**
 * Load a single secret by name.
 * Checks env vars, then file secrets, then JSON config.
 * Returns undefined if not found anywhere.
 */
export function loadSecret(
  name: string,
  config?: SecretsConfig,
): string | undefined {
  // 1. Environment variable (highest priority)
  const envVal = process.env[name];
  if (envVal !== undefined && envVal !== "") {
    return envVal;
  }

  // 2. File-based secret (Docker/K8s style)
  const secretsDir = config?.secretsDir || "/run/secrets";
  const secretFile = path.join(secretsDir, name.toLowerCase());
  try {
    if (fs.existsSync(secretFile)) {
      const content = fs.readFileSync(secretFile, "utf-8").trim();
      if (content) {
        log.debug("Secret loaded from file", { name, source: secretFile });
        return content;
      }
    }
  } catch {
    // File not readable, continue
  }

  // 3. JSON secrets file
  const jsonPath =
    config?.jsonSecretsPath ||
    path.join(process.env.HOME || "/root", ".automaton", "secrets.json");
  try {
    if (fs.existsSync(jsonPath)) {
      // Verify file permissions (should be 0600 or 0400)
      const stats = fs.statSync(jsonPath);
      const mode = stats.mode & 0o777;
      if (mode & 0o077) {
        log.warn("Secrets file has insecure permissions", {
          path: jsonPath,
          mode: `0${mode.toString(8)}`,
          recommended: "0600",
        });
      }

      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      if (raw[name] !== undefined) {
        log.debug("Secret loaded from JSON file", { name });
        return String(raw[name]);
      }
    }
  } catch {
    // JSON file not readable or invalid, continue
  }

  return undefined;
}

/**
 * Load multiple secrets at once.
 * Returns a map of name -> value for all found secrets.
 * Missing secrets are omitted from the result.
 */
export function loadSecrets(
  names: string[],
  config?: SecretsConfig,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = loadSecret(name, config);
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Validate that all required secrets are available.
 * Returns a list of missing secret names.
 */
export function validateRequiredSecrets(
  names: string[],
  config?: SecretsConfig,
): string[] {
  const missing: string[] = [];
  for (const name of names) {
    if (loadSecret(name, config) === undefined) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Mask a secret for safe logging (show first 4 and last 4 chars).
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
