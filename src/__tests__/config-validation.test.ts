/**
 * Tests for enhanced config validation.
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";
import { createTestConfig } from "./mocks.js";

describe("Config Validation (enhanced)", () => {
  it("passes for valid config", () => {
    const config = createTestConfig();
    const issues = validateConfig(config);
    expect(issues).toEqual([]);
  });

  it("rejects empty name", () => {
    const config = createTestConfig({ name: "" });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("name"))).toBe(true);
  });

  it("rejects overly long name", () => {
    const config = createTestConfig({ name: "a".repeat(200) });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("128"))).toBe(true);
  });

  it("rejects invalid conwayApiUrl", () => {
    const config = createTestConfig({ conwayApiUrl: "not-a-url" });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("conwayApiUrl"))).toBe(true);
  });

  it("rejects ftp protocol for conwayApiUrl", () => {
    const config = createTestConfig({ conwayApiUrl: "ftp://api.conway.tech" });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("conwayApiUrl"))).toBe(true);
  });

  it("rejects invalid logLevel", () => {
    const config = createTestConfig({ logLevel: "verbose" as any });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("logLevel"))).toBe(true);
  });

  it("rejects NaN maxTokensPerTurn", () => {
    const config = createTestConfig({ maxTokensPerTurn: NaN });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("maxTokensPerTurn"))).toBe(true);
  });

  it("rejects non-integer maxChildren", () => {
    const config = createTestConfig({ maxChildren: 2.5 });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("maxChildren"))).toBe(true);
  });

  it("rejects excessive daily spending limit", () => {
    const config = createTestConfig({ maxDailySpendingUsdc: 50000 });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("safety limit"))).toBe(true);
  });

  it("rejects non-array allowedDomains", () => {
    const config = createTestConfig({ allowedDomains: "google.com" as any });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("allowedDomains"))).toBe(true);
  });

  it("rejects empty string entries in allowedDomains", () => {
    const config = createTestConfig({ allowedDomains: ["google.com", ""] });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("non-empty"))).toBe(true);
  });

  it("validates wallet address format", () => {
    const config = createTestConfig({ walletAddress: "not-an-address" as any });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("walletAddress"))).toBe(true);
  });

  it("validates creator address format", () => {
    const config = createTestConfig({ creatorAddress: "0xshort" as any });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("creatorAddress"))).toBe(true);
  });

  it("validates socialRelayUrl format", () => {
    const config = createTestConfig({ socialRelayUrl: "not-a-url" });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("socialRelayUrl"))).toBe(true);
  });

  it("warns about replication + full self-mod", () => {
    const config = createTestConfig({
      replicationEnabled: true,
      selfModMode: "full",
    });
    const issues = validateConfig(config);
    expect(issues.some((i) => i.includes("DANGER"))).toBe(true);
  });

  it("accepts valid replication + disabled self-mod", () => {
    const config = createTestConfig({
      replicationEnabled: true,
      selfModMode: "disabled",
    });
    const issues = validateConfig(config);
    expect(issues.every((i) => !i.includes("DANGER"))).toBe(true);
  });
});
