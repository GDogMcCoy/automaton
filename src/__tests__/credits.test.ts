/**
 * Credits Module Tests
 *
 * Tests for survival tiers, credit formatting, ID generation,
 * financial state checking, and credit logging.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSurvivalTier,
  formatCredits,
  generateId,
  checkFinancialState,
  logCreditCheck,
} from "../conway/credits.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import type { ConwayClient, AutomatonDatabase, FinancialState } from "../types.js";

// ─── getSurvivalTier ────────────────────────────────────────────

describe("getSurvivalTier", () => {
  it("should return 'normal' when credits are above the normal threshold", () => {
    expect(getSurvivalTier(100)).toBe("normal");
    expect(getSurvivalTier(51)).toBe("normal");
    expect(getSurvivalTier(1000)).toBe("normal");
    expect(getSurvivalTier(999_999)).toBe("normal");
  });

  it("should return 'low_compute' when credits are between low_compute and normal thresholds", () => {
    // normal threshold = 50, low_compute threshold = 10
    expect(getSurvivalTier(50)).toBe("low_compute");
    expect(getSurvivalTier(30)).toBe("low_compute");
    expect(getSurvivalTier(11)).toBe("low_compute");
  });

  it("should return 'critical' when credits are between dead and low_compute thresholds", () => {
    // low_compute threshold = 10, dead threshold = 0
    expect(getSurvivalTier(10)).toBe("critical");
    expect(getSurvivalTier(5)).toBe("critical");
    expect(getSurvivalTier(1)).toBe("critical");
  });

  it("should return 'dead' when credits are at or below the dead threshold", () => {
    expect(getSurvivalTier(0)).toBe("dead");
    expect(getSurvivalTier(-1)).toBe("dead");
    expect(getSurvivalTier(-100)).toBe("dead");
  });

  it("should return 'normal' just above the normal threshold boundary", () => {
    expect(getSurvivalTier(SURVIVAL_THRESHOLDS.normal + 1)).toBe("normal");
  });

  it("should return 'low_compute' at exactly the normal threshold", () => {
    // creditsCents > SURVIVAL_THRESHOLDS.normal => normal; at threshold => low_compute
    expect(getSurvivalTier(SURVIVAL_THRESHOLDS.normal)).toBe("low_compute");
  });

  it("should return 'critical' at exactly the low_compute threshold", () => {
    // creditsCents > SURVIVAL_THRESHOLDS.low_compute => low_compute; at threshold => critical
    expect(getSurvivalTier(SURVIVAL_THRESHOLDS.low_compute)).toBe("critical");
  });
});

// ─── formatCredits ──────────────────────────────────────────────

describe("formatCredits", () => {
  it("should format zero cents correctly", () => {
    expect(formatCredits(0)).toBe("$0.00");
  });

  it("should format small cent amounts correctly", () => {
    expect(formatCredits(1)).toBe("$0.01");
    expect(formatCredits(5)).toBe("$0.05");
    expect(formatCredits(10)).toBe("$0.10");
    expect(formatCredits(99)).toBe("$0.99");
  });

  it("should format dollar amounts correctly", () => {
    expect(formatCredits(100)).toBe("$1.00");
    expect(formatCredits(150)).toBe("$1.50");
    expect(formatCredits(1000)).toBe("$10.00");
    expect(formatCredits(10050)).toBe("$100.50");
  });

  it("should format large amounts correctly", () => {
    expect(formatCredits(100000)).toBe("$1000.00");
    expect(formatCredits(999999)).toBe("$9999.99");
  });

  it("should handle negative amounts", () => {
    expect(formatCredits(-100)).toBe("$-1.00");
    expect(formatCredits(-1)).toBe("$-0.01");
  });
});

// ─── generateId ─────────────────────────────────────────────────

describe("generateId", () => {
  it("should produce a non-empty string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("should produce unique IDs on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    // All 100 IDs should be unique
    expect(ids.size).toBe(100);
  });

  it("should have a three-part format (timestamp-random-counter)", () => {
    const id = generateId();
    const parts = id.split("-");
    expect(parts.length).toBe(3);
  });

  it("should produce IDs with monotonically increasing counter", () => {
    const id1 = generateId();
    const id2 = generateId();

    // Extract counter parts (last segment, base36)
    const counter1 = parseInt(id1.split("-")[2], 36);
    const counter2 = parseInt(id2.split("-")[2], 36);

    expect(counter2).toBeGreaterThan(counter1);
  });

  it("should produce roughly sortable IDs (timestamp part increases)", () => {
    const id1 = generateId();
    // Small delay to ensure timestamp differs
    const id2 = generateId();

    // Both should start with a valid base36 timestamp
    const ts1 = id1.split("-")[0];
    const ts2 = id2.split("-")[0];

    const ts1Val = parseInt(ts1, 36);
    const ts2Val = parseInt(ts2, 36);

    // Second should be >= first (could be same ms)
    expect(ts2Val).toBeGreaterThanOrEqual(ts1Val);
  });

  it("should produce IDs safe for SQLite (no special chars except dash)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateId();
      // Should only contain alphanumeric and dashes
      expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    }
  });
});

// ─── checkFinancialState ────────────────────────────────────────

describe("checkFinancialState", () => {
  it("should return credits from conway client and provided USDC balance", async () => {
    const mockConway = {
      getCreditsBalance: vi.fn(async () => 5000),
    } as unknown as ConwayClient;

    const state = await checkFinancialState(mockConway, 12.5);

    expect(state.creditsCents).toBe(5000);
    expect(state.usdcBalance).toBe(12.5);
    expect(mockConway.getCreditsBalance).toHaveBeenCalledOnce();
  });

  it("should include a lastChecked timestamp in ISO format", async () => {
    const mockConway = {
      getCreditsBalance: vi.fn(async () => 100),
    } as unknown as ConwayClient;

    const state = await checkFinancialState(mockConway, 0);

    expect(state.lastChecked).toBeDefined();
    // Validate ISO date format
    expect(new Date(state.lastChecked).toISOString()).toBe(state.lastChecked);
  });

  it("should handle zero credits and zero USDC", async () => {
    const mockConway = {
      getCreditsBalance: vi.fn(async () => 0),
    } as unknown as ConwayClient;

    const state = await checkFinancialState(mockConway, 0);

    expect(state.creditsCents).toBe(0);
    expect(state.usdcBalance).toBe(0);
  });

  it("should propagate errors from conway client", async () => {
    const mockConway = {
      getCreditsBalance: vi.fn(async () => {
        throw new Error("API unreachable");
      }),
    } as unknown as ConwayClient;

    await expect(checkFinancialState(mockConway, 0)).rejects.toThrow(
      "API unreachable",
    );
  });
});

// ─── logCreditCheck ─────────────────────────────────────────────

describe("logCreditCheck", () => {
  it("should insert a transaction with type 'credit_check'", () => {
    const mockDb = {
      insertTransaction: vi.fn(),
    } as unknown as AutomatonDatabase;

    const state: FinancialState = {
      creditsCents: 5000,
      usdcBalance: 10.5,
      lastChecked: "2025-01-15T10:00:00.000Z",
    };

    logCreditCheck(mockDb, state);

    expect(mockDb.insertTransaction).toHaveBeenCalledOnce();
    const call = (mockDb.insertTransaction as any).mock.calls[0][0];
    expect(call.type).toBe("credit_check");
  });

  it("should include credit amount in the transaction", () => {
    const mockDb = {
      insertTransaction: vi.fn(),
    } as unknown as AutomatonDatabase;

    const state: FinancialState = {
      creditsCents: 7500,
      usdcBalance: 25.0,
      lastChecked: "2025-01-15T10:00:00.000Z",
    };

    logCreditCheck(mockDb, state);

    const call = (mockDb.insertTransaction as any).mock.calls[0][0];
    expect(call.amountCents).toBe(7500);
  });

  it("should include a formatted description with both credits and USDC", () => {
    const mockDb = {
      insertTransaction: vi.fn(),
    } as unknown as AutomatonDatabase;

    const state: FinancialState = {
      creditsCents: 5000,
      usdcBalance: 10.5,
      lastChecked: "2025-01-15T10:00:00.000Z",
    };

    logCreditCheck(mockDb, state);

    const call = (mockDb.insertTransaction as any).mock.calls[0][0];
    expect(call.description).toContain("$50.00");
    expect(call.description).toContain("10.5000");
    expect(call.description).toContain("USDC");
  });

  it("should use lastChecked as the transaction timestamp", () => {
    const mockDb = {
      insertTransaction: vi.fn(),
    } as unknown as AutomatonDatabase;

    const lastChecked = "2025-06-01T12:30:00.000Z";
    const state: FinancialState = {
      creditsCents: 100,
      usdcBalance: 0,
      lastChecked,
    };

    logCreditCheck(mockDb, state);

    const call = (mockDb.insertTransaction as any).mock.calls[0][0];
    expect(call.timestamp).toBe(lastChecked);
  });

  it("should generate a unique ID for each transaction", () => {
    const insertedIds: string[] = [];
    const mockDb = {
      insertTransaction: vi.fn((txn: any) => {
        insertedIds.push(txn.id);
      }),
    } as unknown as AutomatonDatabase;

    const state: FinancialState = {
      creditsCents: 100,
      usdcBalance: 0,
      lastChecked: new Date().toISOString(),
    };

    logCreditCheck(mockDb, state);
    logCreditCheck(mockDb, state);
    logCreditCheck(mockDb, state);

    expect(insertedIds.length).toBe(3);
    const uniqueIds = new Set(insertedIds);
    expect(uniqueIds.size).toBe(3);
  });
});
