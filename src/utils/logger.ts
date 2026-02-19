/**
 * Structured Logger
 *
 * Lightweight JSON-lines logger that outputs to stderr so stdout
 * stays clean for the agent's primary communication channel.
 *
 * Respects the LOG_LEVEL env var (default: "info").
 * No external dependencies.
 *
 * Usage:
 *   import { createLogger } from "../utils/logger.js";
 *   const log = createLogger("loop");
 *   log.info("Turn started", { turnId: 42 });
 *   // => {"ts":"2026-02-19T04:30:00.000Z","level":"info","component":"loop","msg":"Turn started","turnId":42}
 */

// ─── Types ──────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ─── Level Ordering ─────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Resolve Effective Log Level ────────────────────────────────

function resolveLogLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) {
    return env as LogLevel;
  }
  return "info";
}

// ─── Core Emit ──────────────────────────────────────────────────

function emit(
  level: LogLevel,
  component: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const threshold = resolveLogLevel();
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) {
    return;
  }

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...meta,
  };

  // Write to stderr so stdout stays clean for the agent
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a logger scoped to a named component.
 *
 * @param component - A short identifier for the subsystem (e.g. "loop", "heartbeat", "tools")
 * @returns A Logger with debug/info/warn/error methods
 */
export function createLogger(component: string): Logger {
  return {
    debug(msg: string, meta?: Record<string, unknown>): void {
      emit("debug", component, msg, meta);
    },
    info(msg: string, meta?: Record<string, unknown>): void {
      emit("info", component, msg, meta);
    },
    warn(msg: string, meta?: Record<string, unknown>): void {
      emit("warn", component, msg, meta);
    },
    error(msg: string, meta?: Record<string, unknown>): void {
      emit("error", component, msg, meta);
    },
  };
}
