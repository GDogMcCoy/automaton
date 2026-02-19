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

  if (!config.name || config.name.trim().length === 0) {
    issues.push("name is required");
  }

  if (!config.conwayApiUrl || !config.conwayApiUrl.startsWith("http")) {
    issues.push("conwayApiUrl must be a valid HTTP(S) URL");
  }

  if (!config.conwayApiKey || config.conwayApiKey.trim().length === 0) {
    issues.push("conwayApiKey is required");
  }

  const validSelfModModes: SelfModMode[] = ["disabled", "gated", "full"];
  if (!validSelfModModes.includes(config.selfModMode)) {
    issues.push(`selfModMode must be one of: ${validSelfModModes.join(", ")}`);
  }

  if (config.maxTokensPerTurn < 256 || config.maxTokensPerTurn > 128000) {
    issues.push("maxTokensPerTurn must be between 256 and 128000");
  }

  if (config.maxChildren < 0 || config.maxChildren > 20) {
    issues.push("maxChildren must be between 0 and 20");
  }

  if (config.maxDailySpendingUsdc !== undefined && config.maxDailySpendingUsdc <= 0) {
    issues.push("maxDailySpendingUsdc must be a positive number");
  }

  if (config.allowedDomains && !Array.isArray(config.allowedDomains)) {
    issues.push("allowedDomains must be an array of domain strings");
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
