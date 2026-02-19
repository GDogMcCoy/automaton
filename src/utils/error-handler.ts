/**
 * Global Error Handler
 *
 * Provides centralized error handling, circuit breaker pattern,
 * and safe utility functions for the automaton runtime.
 */

import type { AutomatonDatabase } from "../types.js";

// ─── Custom Error Classes ───────────────────────────────────────

export class AutomatonError extends Error {
  constructor(
    message: string,
    public code: string,
    public recoverable: boolean = false,
  ) {
    super(message);
    this.name = "AutomatonError";
  }
}

export class NetworkError extends AutomatonError {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message, "NETWORK_ERROR", true);
    this.name = "NetworkError";
  }
}

export class DatabaseError extends AutomatonError {
  constructor(
    message: string,
    public originalError?: unknown,
  ) {
    super(message, "DATABASE_ERROR", true);
    this.name = "DatabaseError";
  }
}

export class CircuitBreakerError extends AutomatonError {
  constructor(message: string = "Circuit breaker is open") {
    super(message, "CIRCUIT_BREAKER_OPEN", false);
    this.name = "CircuitBreakerError";
  }
}

// ─── Circuit Breaker ────────────────────────────────────────────

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // 5 minutes

export function checkCircuitBreaker(name: string): void {
  const state = circuitBreakers.get(name);
  if (state?.isOpen) {
    const timeSinceLastFailure = Date.now() - state.lastFailure;
    if (timeSinceLastFailure < CIRCUIT_BREAKER_RESET_MS) {
      throw new CircuitBreakerError();
    }
    // Reset circuit after cooldown
    circuitBreakers.delete(name);
  }
}

export function recordSuccess(name: string): void {
  circuitBreakers.delete(name);
}

export function recordFailure(name: string): void {
  const state = circuitBreakers.get(name) || {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
  };
  state.failures++;
  state.lastFailure = Date.now();
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.isOpen = true;
  }
  circuitBreakers.set(name, state);
}

// ─── Safe JSON Utilities ────────────────────────────────────────

export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function safeJsonStringify(
  obj: unknown,
  fallback: string = "{}",
): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return fallback;
  }
}

// ─── Backoff & Sleep ────────────────────────────────────────────

export function calculateBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000,
): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = Math.random() * 0.3 * exponential; // 30% jitter
  return Math.floor(exponential + jitter);
}

export function sleep(
  ms: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("Sleep aborted"));
      });
    }
  });
}

// ─── Global Error Handlers ──────────────────────────────────────

export function setupGlobalErrorHandlers(db?: AutomatonDatabase): void {
  process.on("uncaughtException", (error) => {
    console.error(`[FATAL] Uncaught exception: ${error.message}`);
    if (db) {
      try {
        db.setKV(
          "last_fatal_error",
          JSON.stringify({
            message: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch {
        // DB may be closed, nothing we can do
      }
    }
    // Give time for logging before exit
    setTimeout(() => process.exit(1), 1000);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`[FATAL] Unhandled rejection: ${reason}`);
    if (db) {
      try {
        db.setKV(
          "last_unhandled_rejection",
          JSON.stringify({
            reason: String(reason),
            timestamp: new Date().toISOString(),
          }),
        );
      } catch {
        // DB may be closed
      }
    }
  });
}
