/**
 * Rate Limiter
 *
 * In-memory sliding window rate limiter. No external dependencies.
 *
 * Usage:
 *   import { createRateLimiter } from "../utils/rate-limiter.js";
 *   const limiter = createRateLimiter(60_000, 10); // 10 requests per minute
 *   if (limiter.consume("user-123")) {
 *     // allowed
 *   }
 */

// ─── Types ──────────────────────────────────────────────────────

export interface RateLimitResult {
  /** Whether the request is within the rate limit. */
  allowed: boolean;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Milliseconds until the oldest request in the window expires. 0 if no active requests. */
  resetMs: number;
}

export interface RateLimiter {
  /** Check whether a request for `key` would be allowed, without consuming a slot. */
  check(key: string): RateLimitResult;
  /** Check and consume a slot for `key`. Returns true if the request was allowed. */
  consume(key: string): boolean;
  /** Reset all tracked requests for `key`. */
  reset(key: string): void;
}

// ─── Internals ──────────────────────────────────────────────────

/**
 * Each key maps to a sorted array of timestamps (epoch ms) representing
 * requests within the current sliding window.
 */
type WindowStore = Map<string, number[]>;

// CLEANUP_INTERVAL_MS: How often the background sweep runs to purge keys
// whose entire window has expired. Prevents unbounded memory growth from
// keys that are hit once then never seen again.
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Remove timestamps that have fallen outside the sliding window and delete
 * entries that have no active timestamps left.
 */
function pruneStore(store: WindowStore, windowMs: number, now: number): void {
  const cutoff = now - windowMs;
  for (const [key, timestamps] of store) {
    // Find the first index that is still within the window.
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) {
      firstValid++;
    }

    if (firstValid === timestamps.length) {
      // All entries expired -- remove the key entirely.
      store.delete(key);
    } else if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a sliding-window rate limiter.
 *
 * @param windowMs   - Size of the sliding window in milliseconds.
 * @param maxRequests - Maximum number of requests allowed within the window.
 * @returns A RateLimiter instance.
 */
export function createRateLimiter(
  windowMs: number,
  maxRequests: number,
): RateLimiter {
  const store: WindowStore = new Map();

  // Background cleanup timer. Uses unref() so it does not keep the
  // process alive when nothing else is running.
  const cleanupTimer = setInterval(() => {
    pruneStore(store, windowMs, Date.now());
  }, CLEANUP_INTERVAL_MS);

  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }

  function getActiveTimestamps(key: string, now: number): number[] {
    const cutoff = now - windowMs;
    let timestamps = store.get(key);

    if (!timestamps) {
      return [];
    }

    // Prune expired entries lazily on access.
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }
    if (timestamps.length === 0) {
      store.delete(key);
      return [];
    }

    return timestamps;
  }

  function check(key: string): RateLimitResult {
    const now = Date.now();
    const active = getActiveTimestamps(key, now);
    const count = active.length;
    const allowed = count < maxRequests;
    const remaining = Math.max(0, maxRequests - count);

    // resetMs: time until the oldest active request expires, opening a new slot.
    const resetMs = active.length > 0 ? active[0] + windowMs - now : 0;

    return { allowed, remaining, resetMs };
  }

  function consume(key: string): boolean {
    const now = Date.now();
    const active = getActiveTimestamps(key, now);

    if (active.length >= maxRequests) {
      return false;
    }

    // Record the new request timestamp.
    let timestamps = store.get(key);
    if (!timestamps) {
      timestamps = [];
      store.set(key, timestamps);
    }
    timestamps.push(now);

    return true;
  }

  function reset(key: string): void {
    store.delete(key);
  }

  return { check, consume, reset };
}
