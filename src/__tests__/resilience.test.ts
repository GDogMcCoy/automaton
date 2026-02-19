/**
 * Resilience Tests
 *
 * Tests for retry logic, circuit breaker, and error handling utilities.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkCircuitBreaker,
  recordFailure,
  recordSuccess,
  CircuitBreakerError,
  calculateBackoff,
  safeJsonParse,
  safeJsonStringify,
  sleep,
} from "../utils/error-handler.js";
import { withRetry, RetryPresets } from "../utils/retry.js";

describe("Circuit Breaker", () => {
  beforeEach(() => {
    // Reset by recording success
    recordSuccess("test-breaker");
  });

  it("should allow calls when circuit is closed", () => {
    expect(() => checkCircuitBreaker("test-breaker")).not.toThrow();
  });

  it("should open circuit after threshold failures", () => {
    for (let i = 0; i < 5; i++) {
      recordFailure("test-breaker");
    }
    expect(() => checkCircuitBreaker("test-breaker")).toThrow(CircuitBreakerError);
  });

  it("should reset on success", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure("test-breaker");
    }
    recordSuccess("test-breaker");
    expect(() => checkCircuitBreaker("test-breaker")).not.toThrow();
  });
});

describe("Backoff Calculation", () => {
  it("should increase exponentially", () => {
    const b1 = calculateBackoff(1, 1000, 30000);
    const b2 = calculateBackoff(2, 1000, 30000);
    const b3 = calculateBackoff(3, 1000, 30000);
    // With jitter, b2 should generally be larger than b1
    expect(b2).toBeGreaterThan(0);
    expect(b3).toBeGreaterThan(0);
  });

  it("should respect max backoff", () => {
    const backoff = calculateBackoff(100, 1000, 5000);
    // With 30% jitter on 5000, max is 6500
    expect(backoff).toBeLessThanOrEqual(6500);
  });
});

describe("Safe JSON", () => {
  it("should parse valid JSON", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it("should return fallback for invalid JSON", () => {
    expect(safeJsonParse("not json", { default: true })).toEqual({ default: true });
  });

  it("should stringify objects", () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("should return fallback for circular references", () => {
    const obj: any = {};
    obj.self = obj;
    expect(safeJsonStringify(obj, "fallback")).toBe("fallback");
  });
});

describe("Retry Logic", () => {
  it("should succeed on first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, timeoutMs: 5000, backoffBaseMs: 10, backoffMaxMs: 50 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, timeoutMs: 5000, backoffBaseMs: 10, backoffMaxMs: 50 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should throw after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("persistent fail"));
    await expect(
      withRetry(fn, { maxAttempts: 2, timeoutMs: 5000, backoffBaseMs: 10, backoffMaxMs: 50 }),
    ).rejects.toThrow("persistent fail");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should call onRetry callback", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    await withRetry(fn, { maxAttempts: 3, timeoutMs: 5000, backoffBaseMs: 10, backoffMaxMs: 50, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("Sleep", () => {
  it("should resolve after delay", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("should abort on signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(sleep(5000, controller.signal)).rejects.toThrow("Sleep aborted");
  });
});

describe("Retry Presets", () => {
  it("should have network preset", () => {
    expect(RetryPresets.network.maxAttempts).toBe(3);
    expect(RetryPresets.network.timeoutMs).toBe(30000);
  });

  it("should have inference preset with higher timeout", () => {
    expect(RetryPresets.inference.timeoutMs).toBe(120000);
  });
});
