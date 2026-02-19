/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
} from "../types.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import { createLogger } from "../utils/logger.js";
import { createMetricsCollector } from "../utils/metrics.js";
import type { MetricsCollector } from "../utils/metrics.js";
import { ulid } from "ulid";

const log = createLogger("loop");

// ─── Metrics ────────────────────────────────────────────────────
//
// Module-level metrics collector so heartbeat tasks and other subsystems
// can inspect runtime statistics via getLoopMetrics().
const loopMetrics = createMetricsCollector();

/**
 * Return the metrics collector used by the agent loop.
 * Heartbeat tasks can call this to include loop stats in status pings.
 */
export function getLoopMetrics(): MetricsCollector {
  return loopMetrics;
}

// ─── Tunables (magic numbers documented) ────────────────────────
//
// MAX_TOOL_CALLS_PER_TURN: Hard cap on how many tools the model can invoke in a
//   single turn. Prevents runaway tool-call loops from draining credits.
const MAX_TOOL_CALLS_PER_TURN = 10;
//
// MAX_CONSECUTIVE_ERRORS: How many back-to-back turn failures we tolerate before
//   entering a 5-minute cooldown sleep. Avoids infinite crash-loop.
const MAX_CONSECUTIVE_ERRORS = 5;
//
// TURN_TIMEOUT_MS: Maximum wall-clock time a single turn (inference + tool
//   execution) is allowed to take before we abort it. 5 minutes.
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
//
// MAX_TOOL_OUTPUT_SIZE: Tool results larger than this (in characters) are
//   truncated to prevent context window blowup on the next inference call.
const MAX_TOOL_OUTPUT_SIZE = 50_000;
//
// IDLE_SLEEP_MS: When the agent has nothing to do (no tool calls, finish
//   reason "stop"), it sleeps for this duration. 60 seconds.
const IDLE_SLEEP_MS = 60_000;
//
// FATAL_SLEEP_MS: After MAX_CONSECUTIVE_ERRORS failures, sleep for this
//   duration before the outer run-loop retries. 5 minutes.
const FATAL_SLEEP_MS = 300_000;
//
// ERROR_BACKOFF_BASE_MS / ERROR_BACKOFF_MAX_MS: Exponential backoff
//   parameters for retrying after a single turn error.
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 30_000;

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, onStateChange, onTurnComplete } =
    options;

  const tools = createBuiltinTools(identity.sandboxId);
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state
  let financial = await getFinancialState(conway, identity.address);

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log.info("Agent waking up", {
    name: config.name,
    credits: (financial.creditsCents / 100).toFixed(2),
  });

  // ─── The Loop ──────────────────────────────────────────────

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  let turnNumber = 0;

  while (running) {
    const turnStartMs = Date.now();
    turnNumber++;
    loopMetrics.counter("loop.turns.total");

    try {
      // Wrap the entire turn in a timeout so a single stuck inference
      // or tool call cannot block the loop forever.
      await Promise.race([
        (async () => {
      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log.info("Sleep schedule active", { sleepUntil });
        running = false;
        return;
      }

      // Check for unprocessed inbox messages
      if (!pendingInput) {
        const inboxMessages = db.getUnprocessedInboxMessages(5);
        if (inboxMessages.length > 0) {
          const formatted = inboxMessages
            .map((m) => `[Message from ${m.from}]: ${m.content}`)
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
          for (const m of inboxMessages) {
            db.markInboxMessageProcessed(m.id);
          }
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address);
      loopMetrics.gauge("loop.credits", financial.creditsCents);

      // Check survival tier
      const tier = getSurvivalTier(financial.creditsCents);
      if (tier === "dead") {
        log.error("No credits remaining, entering dead state");
        db.setAgentState("dead");
        onStateChange?.("dead");
        running = false;
        return;
      }

      if (tier === "critical") {
        log.warn("Credits critically low, limited operation", {
          creditsCents: financial.creditsCents,
        });
        db.setAgentState("critical");
        onStateChange?.("critical");
        inference.setLowComputeMode(true);
      } else if (tier === "low_compute") {
        db.setAgentState("low_compute");
        onStateChange?.("low_compute");
        inference.setLowComputeMode(true);
      } else {
        if (db.getAgentState() !== "running") {
          db.setAgentState("running");
          onStateChange?.("running");
        }
        inference.setLowComputeMode(false);
      }

      // Build context
      const recentTurns = trimContext(db.getRecentTurns(20));
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      const messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── Inference Call ──
      log.info("Inference call starting", {
        model: inference.getDefaultModel(),
        turnNumber,
      });

      const response = await inference.chat(messages, {
        tools: toolsToInferenceFormat(tools),
      });

      // Record token usage
      const totalTokens =
        response.usage.promptTokens + response.usage.completionTokens;
      loopMetrics.histogram("loop.inference.tokens", totalTokens);

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: response.message.content || "",
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: estimateCostCents(response.usage, inference.getDefaultModel()),
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log.warn("Max tool calls per turn reached", {
              limit: MAX_TOOL_CALLS_PER_TURN,
            });
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          log.info("Executing tool", {
            tool: tc.function.name,
            args: JSON.stringify(args).slice(0, 100),
          });

          loopMetrics.counter("loop.tools.executed");

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;

          // Truncate oversized tool output to prevent context blowup
          if (result.result && result.result.length > MAX_TOOL_OUTPUT_SIZE) {
            const originalLength = result.result.length;
            result.result =
              result.result.slice(0, MAX_TOOL_OUTPUT_SIZE) +
              `\n\n[OUTPUT TRUNCATED: ${originalLength} chars -> ${MAX_TOOL_OUTPUT_SIZE} chars]`;
            log.warn("Tool output truncated", {
              tool: tc.function.name,
              originalLength,
              truncatedTo: MAX_TOOL_OUTPUT_SIZE,
            });
          }

          turn.toolCalls.push(result);

          log.debug("Tool result", {
            tool: tc.function.name,
            error: result.error || undefined,
            resultPreview: result.error
              ? undefined
              : result.result.slice(0, 200),
          });

          callCount++;
        }
      }

      // ── Persist Turn ──
      db.insertTurn(turn);
      for (const tc of turn.toolCalls) {
        db.insertToolCall(turn.id, tc);
      }
      onTurnComplete?.(turn);

      // Log the turn summary
      const turnDurationMs = Date.now() - turnStartMs;
      loopMetrics.histogram("loop.turn.duration_ms", turnDurationMs);

      log.info("Turn completed", {
        turnId: turn.id,
        turnNumber,
        durationMs: turnDurationMs,
        toolCalls: turn.toolCalls.length,
        tokens: response.usage.promptTokens + response.usage.completionTokens,
        costCents: turn.costCents,
      });

      if (turn.thinking) {
        log.debug("Agent thinking", {
          preview: turn.thinking.slice(0, 300),
        });
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        log.info("Agent chose to sleep");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        return;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep briefly.
        log.info("No pending inputs, entering brief sleep", {
          sleepMs: IDLE_SLEEP_MS,
        });
        db.setKV(
          "sleep_until",
          new Date(Date.now() + IDLE_SLEEP_MS).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;
        })(),
        // Timeout sentinel -- rejects if the turn takes too long
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`)),
            TURN_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err: any) {
      consecutiveErrors++;
      loopMetrics.counter("loop.turns.errors");
      const turnDurationMs = Date.now() - turnStartMs;
      log.error("Turn failed", {
        consecutiveErrors,
        maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
        error: err.message,
        turnNumber,
        durationMs: turnDurationMs,
      });

      // Persist error for diagnostics
      try {
        db.setKV("last_loop_error", JSON.stringify({
          message: err.message,
          stack: err.stack?.slice(0, 500),
          consecutiveErrors,
          timestamp: new Date().toISOString(),
        }));
      } catch {
        // DB write failed - nothing we can do
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log.error("Too many consecutive errors, entering cooldown sleep", {
          consecutiveErrors: MAX_CONSECUTIVE_ERRORS,
          sleepMs: FATAL_SLEEP_MS,
        });
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + FATAL_SLEEP_MS).toISOString(),
        );
        running = false;
      } else {
        // Brief exponential backoff before retry
        const backoffMs = Math.min(
          ERROR_BACKOFF_BASE_MS * Math.pow(2, consecutiveErrors),
          ERROR_BACKOFF_MAX_MS,
        );
        log.debug("Backing off before retry", { backoffMs, consecutiveErrors });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  log.info("Agent loop finished", { state: db.getAgentState(), totalTurns: turnNumber });
}

// ─── Helpers ───────────────────────────────────────────────────

async function getFinancialState(
  conway: ConwayClient,
  address: string,
): Promise<FinancialState> {
  let creditsCents = 0;
  let usdcBalance = 0;

  try {
    creditsCents = await conway.getCreditsBalance();
  } catch {}

  try {
    usdcBalance = await getUsdcBalance(address as `0x${string}`);
  } catch {}

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function estimateCostCents(
  usage: { promptTokens: number; completionTokens: number },
  model: string,
): number {
  // Rough cost estimation per million tokens
  const pricing: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 250, output: 1000 },
    "gpt-4o-mini": { input: 15, output: 60 },
    "gpt-4.1": { input: 200, output: 800 },
    "gpt-4.1-mini": { input: 40, output: 160 },
    "gpt-4.1-nano": { input: 10, output: 40 },
    "gpt-5.2": { input: 200, output: 800 },
    "o1": { input: 1500, output: 6000 },
    "o3-mini": { input: 110, output: 440 },
    "o4-mini": { input: 110, output: 440 },
    "claude-sonnet-4-5": { input: 300, output: 1500 },
    "claude-haiku-4-5": { input: 100, output: 500 },
  };

  const p = pricing[model] || pricing["gpt-4o"];
  const inputCost = (usage.promptTokens / 1_000_000) * p.input;
  const outputCost = (usage.completionTokens / 1_000_000) * p.output;
  return Math.ceil((inputCost + outputCost) * 1.3); // 1.3x Conway markup
}

// The old log() helper has been replaced by the structured logger
// created at module scope via createLogger("loop"). It outputs JSON
// lines to stderr and respects the LOG_LEVEL env var.
