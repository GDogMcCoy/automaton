/**
 * Request Tracing
 *
 * Lightweight distributed tracing via correlation IDs.
 * Each turn gets a unique trace ID that propagates through all
 * log entries, API calls, and tool executions for that turn.
 *
 * Uses AsyncLocalStorage for implicit context propagation.
 *
 * Usage:
 *   import { withTrace, getTraceId } from "../utils/tracing.js";
 *
 *   await withTrace("turn-123", async () => {
 *     log.info("processing", { traceId: getTraceId() });
 *   });
 */

import { AsyncLocalStorage } from "async_hooks";
import { ulid } from "ulid";

// ─── Trace Context ──────────────────────────────────────────────

export interface TraceContext {
  /** Unique ID for this trace (typically a turn ID) */
  traceId: string;
  /** Optional parent span for nested operations */
  parentSpanId?: string;
  /** When this trace started */
  startedAt: number;
  /** Arbitrary metadata carried through the trace */
  metadata: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * Run a function within a trace context.
 * All code executed within the callback (including async operations)
 * will have access to the trace ID via getTraceId().
 */
export function withTrace<T>(
  traceId: string,
  fn: () => T | Promise<T>,
  metadata?: Record<string, unknown>,
): T | Promise<T> {
  const ctx: TraceContext = {
    traceId,
    startedAt: Date.now(),
    metadata: metadata || {},
  };
  return storage.run(ctx, fn);
}

/**
 * Get the current trace ID, or undefined if not in a trace context.
 */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Get the full trace context, or undefined if not in a trace context.
 */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Generate a new unique trace ID.
 */
export function generateTraceId(): string {
  return ulid();
}

/**
 * Create a child span within the current trace.
 * Useful for tracking sub-operations (tool calls, API requests).
 */
export function createSpan(
  name: string,
): { spanId: string; end: () => number } {
  const spanId = ulid();
  const startMs = Date.now();

  return {
    spanId,
    end(): number {
      return Date.now() - startMs;
    },
  };
}

/**
 * Get trace metadata suitable for including in log entries.
 * Returns an empty object if no trace is active.
 */
export function getTraceMetadata(): Record<string, unknown> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  return {
    traceId: ctx.traceId,
    traceElapsedMs: Date.now() - ctx.startedAt,
  };
}
