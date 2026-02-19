/**
 * Type & Config Tests
 *
 * Validates type definitions and default configuration values.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, SURVIVAL_THRESHOLDS, MAX_CHILDREN } from "../types.js";

describe("DEFAULT_CONFIG", () => {
  it("should have safe defaults for security fields", () => {
    expect(DEFAULT_CONFIG.selfModMode).toBe("disabled");
    expect(DEFAULT_CONFIG.replicationEnabled).toBe(false);
  });

  it("should have reasonable operational defaults", () => {
    expect(DEFAULT_CONFIG.maxTokensPerTurn).toBe(4096);
    expect(DEFAULT_CONFIG.logLevel).toBe("info");
    expect(DEFAULT_CONFIG.maxChildren).toBe(3);
  });

  it("should point to Conway API", () => {
    expect(DEFAULT_CONFIG.conwayApiUrl).toBe("https://api.conway.tech");
  });
});

describe("SURVIVAL_THRESHOLDS", () => {
  it("should have correct thresholds", () => {
    expect(SURVIVAL_THRESHOLDS.normal).toBe(50);
    expect(SURVIVAL_THRESHOLDS.dead).toBe(0);
  });
});

describe("MAX_CHILDREN", () => {
  it("should be 3", () => {
    expect(MAX_CHILDREN).toBe(3);
  });
});
