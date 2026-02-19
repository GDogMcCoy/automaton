#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath, validateConfig } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createMultiProviderInference, buildProviderList } from "./conway/multi-provider.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { runAgentLoop, getLoopMetrics } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { createHealthServer } from "./http/server.js";
import { createLogger } from "./utils/logger.js";
import { loadSecret } from "./utils/secrets.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";

const VERSION = "0.1.0";
const log = createLogger("main");

// ─── Run-loop circuit breaker ──────────────────────────────────
// After MAX_CONSECUTIVE_RUN_ERRORS errors with no successful agent
// loop completion in between, enter an extended cooldown to avoid
// burning resources on a persistent failure (corrupt DB, bad config, etc).
const MAX_CONSECUTIVE_RUN_ERRORS = 10;
const RUN_ERROR_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --setup        Re-run the interactive setup wizard
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
  HEALTH_PORT              HTTP health/metrics port (default: 8080)
  LOG_LEVEL                Logging level: debug, info, warn, error
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    const { account, isNew } = await getWallet();
    console.log(
      JSON.stringify({
        address: account.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      console.log(JSON.stringify(result));
    } catch (err: any) {
      console.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--run")) {
    await run();
    return;
  }

  // Default: show help
  console.log('Run "automaton --help" for usage information.');
  console.log('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  console.log(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Self-Mod:   ${config.selfModMode}
Replication:${config.replicationEnabled ? " enabled" : " DISABLED"}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  const startTime = Date.now();
  log.info("Conway Automaton starting", { version: VERSION });

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Validate config
  const configIssues = validateConfig(config);
  if (configIssues.length > 0) {
    log.warn("Config validation warnings", { issues: configIssues });
  }

  // Configure spending limits from config
  if (config.maxDailySpendingUsdc) {
    const { configureSpendingLimits } = await import("./conway/x402.js");
    configureSpendingLimits({ maxDailySpendingUsdc: config.maxDailySpendingUsdc });
    log.info("Daily spending limit configured", { limitUsdc: config.maxDailySpendingUsdc });
  }

  // Load wallet — prefer secrets manager, then config
  const { account } = await getWallet();
  const apiKey =
    loadSecret("CONWAY_API_KEY") ||
    config.conwayApiKey ||
    loadApiKeyFromConfig();
  if (!apiKey) {
    log.error("No API key found. Run: automaton --provision");
    process.exit(1);
  }

  // Build identity
  const identity: AutomatonIdentity = {
    name: config.name,
    address: account.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt: new Date().toISOString(),
  };

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Run database integrity check
  const dbCheck = db.integrityCheck();
  if (!dbCheck.ok) {
    log.error("Database integrity issue", { error: dbCheck.error });
  }

  // Run data cleanup (retain 30 days of history)
  try {
    const cleaned = db.cleanup(30);
    if (cleaned.deletedTurns > 0 || cleaned.deletedToolCalls > 0) {
      log.info("Data cleanup complete", cleaned);
    }
  } catch (err: any) {
    log.warn("Cleanup failed", { error: err.message });
  }

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", account.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("sandbox", config.sandboxId);

  // Create Conway client
  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });

  // Create inference client (multi-provider with automatic failover)
  const providers = buildProviderList({
    conwayApiUrl: config.conwayApiUrl,
    conwayApiKey: apiKey,
    inferenceProviders: config.inferenceProviders,
  });

  const hasAlternateProviders = providers.length > 1;
  const inference = hasAlternateProviders
    ? createMultiProviderInference({
        providers,
        defaultModel: config.inferenceModel,
        maxTokens: config.maxTokensPerTurn,
        metrics: getLoopMetrics(),
      })
    : createInferenceClient({
        apiUrl: config.conwayApiUrl,
        apiKey,
        defaultModel: config.inferenceModel,
        maxTokens: config.maxTokensPerTurn,
      });

  if (hasAlternateProviders) {
    log.info("Multi-provider inference enabled", {
      providers: providers.map((p) => p.name),
      primary: providers[0].name,
    });
  }

  // Create social client
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, account);
    log.info("Social relay connected", { url: config.socialRelayUrl });
  }

  // ─── Start HTTP Health/Metrics Server ────────────────────────
  const healthPort = parseInt(process.env.HEALTH_PORT || "8080", 10);
  const metrics = getLoopMetrics();
  const healthServer = createHealthServer({
    port: healthPort,
    db,
    metrics,
    version: VERSION,
    startTime,
  });

  try {
    await healthServer.start();
    log.info("Health server started", { port: healthPort });
  } catch (err: any) {
    log.warn("Health server failed to start (non-fatal)", { error: err.message });
  }

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    log.info("Skills loaded", { count: skills.length });
  } catch (err: any) {
    log.warn("Skills loading failed", { error: err.message });
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    log.info("State repo initialized");
  } catch (err: any) {
    log.warn("State repo init failed", { error: err.message });
  }

  // Start heartbeat daemon
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    db,
    conway,
    social,
    onWakeRequest: (reason) => {
      log.info("Wake request from heartbeat", { reason });
      db.setKV("wake_request", reason);
    },
  });

  heartbeat.start();
  log.info("Heartbeat daemon started");

  // Mark as ready for readiness probes
  healthServer.setReady(true);

  // ─── Graceful Shutdown ─────────────────────────────────────
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info("Graceful shutdown initiated", { signal });

    // Drain phase: stop accepting new work
    healthServer.setReady(false);

    try {
      heartbeat.stop();

      // Record shutdown metadata
      db.setAgentState("sleeping");
      db.setKV("last_shutdown", JSON.stringify({
        signal,
        timestamp: new Date().toISOString(),
        reason: "graceful",
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      }));

      // Stop HTTP server
      await healthServer.stop();

      db.close();
    } catch (err: any) {
      log.error("Error during shutdown", { error: err.message });
    }

    log.info("Shutdown complete", {
      signal,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => {
    // SIGHUP: reload config without full restart
    log.info("Received SIGHUP, reloading config");
    try {
      const newConfig = loadConfig();
      if (newConfig) {
        Object.assign(config, newConfig);
        log.info("Config reloaded");
      }
    } catch (err: any) {
      log.error("Config reload failed", { error: err.message });
    }
  });
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", { error: err.message, stack: err.stack?.slice(0, 1000) });
    try {
      db.setKV("last_fatal_error", JSON.stringify({
        message: err.message,
        stack: err.stack?.slice(0, 1000),
        timestamp: new Date().toISOString(),
      }));
    } catch {}
    shutdown("uncaughtException");
  });

  // ─── Main Run Loop with Circuit Breaker ────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.
  // Circuit breaker: after MAX_CONSECUTIVE_RUN_ERRORS failures
  // in a row, enter extended cooldown.

  let consecutiveRunErrors = 0;

  while (true) {
    if (isShuttingDown) break;

    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch {}

      metrics.counter("run_loop.iterations");

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        onStateChange: (state: AgentState) => {
          log.info("Agent state changed", { state });
          metrics.gauge("agent.state_ordinal", stateToOrdinal(state));
        },
        onTurnComplete: (turn) => {
          log.info("Turn complete", {
            turnId: turn.id,
            tools: turn.toolCalls.length,
            tokens: turn.tokenUsage.totalTokens,
          });
        },
      });

      // Success — reset circuit breaker
      consecutiveRunErrors = 0;

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        log.warn("Automaton is dead, heartbeat will continue");
        metrics.gauge("agent.state_ordinal", stateToOrdinal("dead"));
        await sleep(300_000);
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        log.info("Sleeping", { sleepSeconds: Math.round(sleepMs / 1000) });

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs && !isShuttingDown) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Check for wake request from heartbeat
          const wakeRequest = db.getKV("wake_request");
          if (wakeRequest) {
            log.info("Woken by heartbeat", { reason: wakeRequest });
            db.deleteKV("wake_request");
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      consecutiveRunErrors++;
      metrics.counter("run_loop.errors");

      log.error("Fatal error in run loop", {
        error: err.message,
        consecutiveErrors: consecutiveRunErrors,
        maxErrors: MAX_CONSECUTIVE_RUN_ERRORS,
      });

      if (consecutiveRunErrors >= MAX_CONSECUTIVE_RUN_ERRORS) {
        // Circuit breaker tripped
        log.error("Run loop circuit breaker tripped, entering extended cooldown", {
          cooldownMs: RUN_ERROR_COOLDOWN_MS,
          consecutiveErrors: consecutiveRunErrors,
        });
        metrics.counter("run_loop.circuit_breaker_trips");
        await sleep(RUN_ERROR_COOLDOWN_MS);
        consecutiveRunErrors = 0; // Reset after cooldown
      } else {
        // Exponential backoff: 30s, 60s, 120s, ...
        const backoffMs = Math.min(
          30_000 * Math.pow(2, consecutiveRunErrors - 1),
          RUN_ERROR_COOLDOWN_MS,
        );
        log.info("Backing off before retry", { backoffMs, consecutiveErrors: consecutiveRunErrors });
        await sleep(backoffMs);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map agent states to numeric ordinals for gauge metrics. */
function stateToOrdinal(state: AgentState): number {
  const ordinals: Record<AgentState, number> = {
    setup: 0,
    waking: 1,
    running: 2,
    sleeping: 3,
    low_compute: 4,
    critical: 5,
    dead: 6,
  };
  return ordinals[state] ?? -1;
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
