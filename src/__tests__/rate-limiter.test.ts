/**
 * Rate Limiter Tests
 *
 * Tests for the sliding-window in-memory rate limiter.
 * Uses vi.useFakeTimers() for deterministic time control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter } from "../utils/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Creation ───────────────────────────────────────────────

  describe("creation", () => {
    it("creates a rate limiter with specified window and max", () => {
      const limiter = createRateLimiter(60_000, 10);

      expect(limiter).toBeDefined();
      expect(limiter.check).toBeTypeOf("function");
      expect(limiter.consume).toBeTypeOf("function");
      expect(limiter.reset).toBeTypeOf("function");
    });
  });

  // ─── consume() ──────────────────────────────────────────────

  describe("consume", () => {
    it("returns true when allowed", () => {
      const limiter = createRateLimiter(60_000, 5);
      const result = limiter.consume("user-1");
      expect(result).toBe(true);
    });

    it("allows requests within limit", () => {
      const limiter = createRateLimiter(60_000, 3);

      expect(limiter.consume("user-1")).toBe(true);
      expect(limiter.consume("user-1")).toBe(true);
      expect(limiter.consume("user-1")).toBe(true);
    });

    it("returns false when blocked (exceeding limit)", () => {
      const limiter = createRateLimiter(60_000, 2);

      expect(limiter.consume("user-1")).toBe(true);
      expect(limiter.consume("user-1")).toBe(true);
      // Third request should be blocked
      expect(limiter.consume("user-1")).toBe(false);
    });

    it("tracks keys independently", () => {
      const limiter = createRateLimiter(60_000, 1);

      expect(limiter.consume("user-a")).toBe(true);
      // user-a is now at limit, but user-b should still be allowed
      expect(limiter.consume("user-b")).toBe(true);
      // user-a is still blocked
      expect(limiter.consume("user-a")).toBe(false);
    });
  });

  // ─── check() ────────────────────────────────────────────────

  describe("check", () => {
    it("reports remaining slots correctly", () => {
      const limiter = createRateLimiter(60_000, 5);

      const initial = limiter.check("user-1");
      expect(initial.allowed).toBe(true);
      expect(initial.remaining).toBe(5);
      expect(initial.resetMs).toBe(0);

      limiter.consume("user-1");
      limiter.consume("user-1");

      const after = limiter.check("user-1");
      expect(after.allowed).toBe(true);
      expect(after.remaining).toBe(3);
    });

    it("reports allowed=false when at limit", () => {
      const limiter = createRateLimiter(60_000, 2);

      limiter.consume("user-1");
      limiter.consume("user-1");

      const result = limiter.check("user-1");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("does not consume a slot (read-only)", () => {
      const limiter = createRateLimiter(60_000, 1);

      limiter.check("user-1");
      limiter.check("user-1");
      limiter.check("user-1");

      // consume should still succeed because check() does not count
      expect(limiter.consume("user-1")).toBe(true);
    });

    it("reports resetMs as time until oldest request expires", () => {
      const limiter = createRateLimiter(60_000, 5);

      limiter.consume("user-1");

      const result = limiter.check("user-1");
      // The oldest request was just made, so resetMs should be ~60_000
      expect(result.resetMs).toBeGreaterThan(0);
      expect(result.resetMs).toBeLessThanOrEqual(60_000);
    });
  });

  // ─── reset() ────────────────────────────────────────────────

  describe("reset", () => {
    it("resets individual keys", () => {
      const limiter = createRateLimiter(60_000, 2);

      // Exhaust the limit
      limiter.consume("user-1");
      limiter.consume("user-1");
      expect(limiter.consume("user-1")).toBe(false);

      // Reset the key
      limiter.reset("user-1");

      // Should be allowed again
      expect(limiter.consume("user-1")).toBe(true);
    });

    it("does not affect other keys when resetting one key", () => {
      const limiter = createRateLimiter(60_000, 1);

      limiter.consume("user-a");
      limiter.consume("user-b");

      limiter.reset("user-a");

      // user-a is reset, user-b is still at limit
      expect(limiter.consume("user-a")).toBe(true);
      expect(limiter.consume("user-b")).toBe(false);
    });

    it("is a no-op for unknown keys", () => {
      const limiter = createRateLimiter(60_000, 5);
      // Should not throw
      expect(() => limiter.reset("nonexistent")).not.toThrow();
    });
  });

  // ─── Sliding window expiry ──────────────────────────────────

  describe("sliding window", () => {
    it("allows requests again after window expires", () => {
      const limiter = createRateLimiter(10_000, 2); // 2 per 10 seconds

      expect(limiter.consume("user-1")).toBe(true);
      expect(limiter.consume("user-1")).toBe(true);
      expect(limiter.consume("user-1")).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(11_000);

      // Requests should be allowed again
      expect(limiter.consume("user-1")).toBe(true);
    });

    it("expires entries individually (sliding, not fixed)", () => {
      const limiter = createRateLimiter(10_000, 2); // 2 per 10 seconds

      // First request at t=0
      limiter.consume("user-1");

      // Second request at t=5000
      vi.advanceTimersByTime(5_000);
      limiter.consume("user-1");

      // At t=5000, both requests are active => blocked
      expect(limiter.consume("user-1")).toBe(false);

      // Advance to t=11000 -- first request expired, second still active
      vi.advanceTimersByTime(6_000);

      // One slot should have opened up
      expect(limiter.consume("user-1")).toBe(true);
      // But not two
      expect(limiter.consume("user-1")).toBe(false);
    });
  });

  // ─── Automatic cleanup of expired entries ───────────────────

  describe("automatic cleanup", () => {
    it("cleans up expired entries via background timer", () => {
      const limiter = createRateLimiter(5_000, 100);

      // Create many keys
      for (let i = 0; i < 50; i++) {
        limiter.consume(`key-${i}`);
      }

      // All keys should report active
      const beforeCheck = limiter.check("key-0");
      expect(beforeCheck.remaining).toBe(99);

      // Advance past both the window AND the cleanup interval (60s)
      vi.advanceTimersByTime(65_000);

      // After cleanup, the expired entries should be gone.
      // Checking a previously used key should show full capacity.
      const afterCheck = limiter.check("key-0");
      expect(afterCheck.remaining).toBe(100);
      expect(afterCheck.resetMs).toBe(0);
    });
  });
});
