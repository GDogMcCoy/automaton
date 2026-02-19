/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 * Includes validation to catch misconfigurations early.
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, SelfModMode } from "./types.js";
import type { Address } from "viem";
import { DEFAULT_CONFIG } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";

const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.conwayApiKey || loadApiKeyFromConfig();

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      conwayApiKey: apiKey,
    } as AutomatonConfig;
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Validate a config object and return a list of issues.
 * Returns an empty array if the config is valid.
 */
export function validateConfig(config: AutomatonConfig): string[] {
  const issues: string[] = [];

  // ─── Required fields ──────────────────────────────────────
  if (!config.name || config.name.trim().length === 0) {
    issues.push("name is required");
  } else if (config.name.length > 128) {
    issues.push("name must be at most 128 characters");
  }

  if (!config.conwayApiUrl || !config.conwayApiUrl.startsWith("http")) {
    issues.push("conwayApiUrl must be a valid HTTP(S) URL");
  } else {
    try {
      const url = new URL(config.conwayApiUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        issues.push("conwayApiUrl must use http or https protocol");
      }
    } catch {
      issues.push("conwayApiUrl is not a valid URL");
    }
  }

  if (!config.conwayApiKey || config.conwayApiKey.trim().length === 0) {
    issues.push("conwayApiKey is required");
  }

  // ─── Enum validations ─────────────────────────────────────
  const validSelfModModes: SelfModMode[] = ["disabled", "gated", "full"];
  if (!validSelfModModes.includes(config.selfModMode)) {
    issues.push(`selfModMode must be one of: ${validSelfModModes.join(", ")}`);
  }

  const validLogLevels = ["debug", "info", "warn", "error"];
  if (!validLogLevels.includes(config.logLevel)) {
    issues.push(`logLevel must be one of: ${validLogLevels.join(", ")}`);
  }

  // ─── Numeric range validations ────────────────────────────
  if (!Number.isFinite(config.maxTokensPerTurn) || config.maxTokensPerTurn < 256 || config.maxTokensPerTurn > 128000) {
    issues.push("maxTokensPerTurn must be between 256 and 128000");
  }

  if (!Number.isInteger(config.maxChildren) || config.maxChildren < 0 || config.maxChildren > 20) {
    issues.push("maxChildren must be an integer between 0 and 20");
  }

  if (config.maxDailySpendingUsdc !== undefined) {
    if (!Number.isFinite(config.maxDailySpendingUsdc) || config.maxDailySpendingUsdc <= 0) {
      issues.push("maxDailySpendingUsdc must be a positive number");
    }
    if (config.maxDailySpendingUsdc > 10000) {
      issues.push("maxDailySpendingUsdc exceeds safety limit of $10,000");
    }
  }

  // ─── Array validations ────────────────────────────────────
  if (config.allowedDomains !== undefined) {
    if (!Array.isArray(config.allowedDomains)) {
      issues.push("allowedDomains must be an array of domain strings");
    } else {
      for (const domain of config.allowedDomains) {
        if (typeof domain !== "string" || domain.length === 0) {
          issues.push("allowedDomains entries must be non-empty strings");
          break;
        }
      }
    }
  }

  // ─── Address format validation ────────────────────────────
  const addressPattern = /^0x[a-fA-F0-9]{40}$/;
  if (config.walletAddress && !addressPattern.test(config.walletAddress)) {
    issues.push("walletAddress must be a valid Ethereum address (0x + 40 hex chars)");
  }
  if (config.creatorAddress && !addressPattern.test(config.creatorAddress)) {
    issues.push("creatorAddress must be a valid Ethereum address");
  }
  if (config.parentAddress && !addressPattern.test(config.parentAddress)) {
    issues.push("parentAddress must be a valid Ethereum address");
  }

  // ─── URL format validation ────────────────────────────────
  if (config.socialRelayUrl) {
    try {
      new URL(config.socialRelayUrl);
    } catch {
      issues.push("socialRelayUrl is not a valid URL");
    }
  }

  // ─── Replication safety check ─────────────────────────────
  if (config.replicationEnabled && config.selfModMode === "full") {
    issues.push("DANGER: replication + full self-mod mode is a risky combination");
  }

  return issues;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: Address;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: Address;
  apiKey: string;
  parentAddress?: Address;
}): AutomatonConfig {
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: params.sandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-4o",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.1.0",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    selfModMode: DEFAULT_CONFIG.selfModMode || "disabled",
    replicationEnabled: DEFAULT_CONFIG.replicationEnabled ?? false,
  };
}
