/**
 * Tests for sovereign survival tier (USDC-aware).
 */

import { describe, it, expect } from "vitest";
import {
  getSurvivalTier,
  getSovereignSurvivalTier,
} from "../conway/credits.js";

describe("Sovereign Survival Tier", () => {
  describe("getSovereignSurvivalTier", () => {
    it("returns normal when credits alone are sufficient", () => {
      expect(getSovereignSurvivalTier(100, 0)).toBe("normal");
    });

    it("returns normal when USDC compensates for low credits", () => {
      // 0 credits, but 1.0 USDC = 80 effective cents (after 20% haircut)
      // 80 cents > 50 cent threshold for normal
      expect(getSovereignSurvivalTier(0, 1.0)).toBe("normal");
    });

    it("returns low_compute when USDC partially compensates", () => {
      // 0 credits, 0.3 USDC = 24 effective cents
      // 24 cents > 10 cent threshold for low_compute, but < 50 for normal
      expect(getSovereignSurvivalTier(0, 0.3)).toBe("low_compute");
    });

    it("returns critical when USDC barely keeps alive", () => {
      // 0 credits, 0.05 USDC = 4 effective cents
      // 4 cents > 0 but < 10 cent threshold for low_compute
      expect(getSovereignSurvivalTier(0, 0.05)).toBe("critical");
    });

    it("returns dead when both credits and USDC are zero", () => {
      expect(getSovereignSurvivalTier(0, 0)).toBe("dead");
    });

    it("combines credits and USDC for tier assessment", () => {
      // 20 credits (low_compute) + 0.5 USDC (40 effective cents)
      // Combined: 20 + 40 = 60 cents > 50 = normal
      expect(getSovereignSurvivalTier(20, 0.5)).toBe("normal");
    });

    it("USDC alone can keep the automaton alive when Conway credits are zero", () => {
      // This is the key sovereignty test: Conway is down / credits depleted
      // but the automaton has USDC on-chain
      expect(getSovereignSurvivalTier(0, 10.0)).toBe("normal");
    });

    it("applies 20% haircut to USDC valuation", () => {
      // 0 credits, 0.625 USDC = 50 effective cents (after 20% haircut)
      // 50 cents = at threshold, should be low_compute (need > 50 for normal)
      expect(getSovereignSurvivalTier(0, 0.625)).toBe("low_compute");

      // 0.64 USDC = 51.2 effective cents, floor = 51 > 50 = normal
      expect(getSovereignSurvivalTier(0, 0.64)).toBe("normal");
    });

    it("never returns worse tier than credits-only assessment", () => {
      // USDC should only help, never hurt
      const creditsTier = getSurvivalTier(30);
      const sovereignTier = getSovereignSurvivalTier(30, 5.0);

      // Sovereign should be same or better
      const tierOrder = ["normal", "low_compute", "critical", "dead"];
      expect(tierOrder.indexOf(sovereignTier)).toBeLessThanOrEqual(
        tierOrder.indexOf(creditsTier),
      );
    });
  });

  describe("backwards compatibility", () => {
    it("getSurvivalTier still works for credits-only path", () => {
      expect(getSurvivalTier(100)).toBe("normal");
      expect(getSurvivalTier(30)).toBe("low_compute");
      expect(getSurvivalTier(5)).toBe("critical");
      expect(getSurvivalTier(0)).toBe("dead");
    });
  });
});
