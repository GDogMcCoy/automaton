/**
 * Tests for survival modules: monitor, funding, low-compute.
 */

import { describe, it, expect } from "vitest";
import { formatResourceReport, type ResourceStatus } from "../survival/monitor.js";
import { executeFundingStrategies } from "../survival/funding.js";
import {
  applyTierRestrictions,
  recordTransition,
  canRunInference,
  getModelForTier,
} from "../survival/low-compute.js";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient } from "./mocks.js";

describe("Resource Monitor", () => {
  it("formats a resource report", () => {
    const status: ResourceStatus = {
      financial: {
        creditsCents: 500,
        usdcBalance: 1.5,
        lastChecked: new Date().toISOString(),
      },
      tier: "normal",
      previousTier: null,
      tierChanged: false,
      sandboxHealthy: true,
    };

    const report = formatResourceReport(status);
    expect(report).toContain("RESOURCE STATUS");
    expect(report).toContain("normal");
    expect(report).toContain("healthy");
  });

  it("indicates tier change in report", () => {
    const status: ResourceStatus = {
      financial: {
        creditsCents: 20,
        usdcBalance: 0,
        lastChecked: new Date().toISOString(),
      },
      tier: "low_compute",
      previousTier: "normal",
      tierChanged: true,
      sandboxHealthy: true,
    };

    const report = formatResourceReport(status);
    expect(report).toContain("changed from normal");
  });
});

describe("Low Compute Mode", () => {
  it("enables low compute mode for low_compute tier", () => {
    const inference = new MockInferenceClient();
    const db = createTestDb();

    applyTierRestrictions("low_compute", inference, db);
    expect(inference.lowComputeMode).toBe(true);

    db.close();
  });

  it("disables low compute mode for normal tier", () => {
    const inference = new MockInferenceClient();
    const db = createTestDb();

    applyTierRestrictions("normal", inference, db);
    expect(inference.lowComputeMode).toBe(false);

    db.close();
  });

  it("records tier transitions", () => {
    const db = createTestDb();

    const transition = recordTransition(db, "normal", "low_compute", 30);
    expect(transition.from).toBe("normal");
    expect(transition.to).toBe("low_compute");
    expect(transition.creditsCents).toBe(30);
    expect(transition.timestamp).toBeTruthy();

    // Verify it's persisted
    const historyStr = db.getKV("tier_transitions");
    expect(historyStr).toBeTruthy();
    const history = JSON.parse(historyStr!);
    expect(history.length).toBe(1);
    expect(history[0].from).toBe("normal");

    db.close();
  });

  it("limits transition history to 50", () => {
    const db = createTestDb();

    for (let i = 0; i < 55; i++) {
      recordTransition(db, "normal", "low_compute", i);
    }

    const historyStr = db.getKV("tier_transitions");
    const history = JSON.parse(historyStr!);
    expect(history.length).toBe(50);

    db.close();
  });

  it("canRunInference returns correct values per tier", () => {
    expect(canRunInference("normal")).toBe(true);
    expect(canRunInference("low_compute")).toBe(true);
    expect(canRunInference("critical")).toBe(true);
    expect(canRunInference("dead")).toBe(false);
  });

  it("getModelForTier uses cheaper model for low tiers", () => {
    expect(getModelForTier("normal", "gpt-4o")).toBe("gpt-4o");
    expect(getModelForTier("low_compute", "gpt-4o")).toBe("gpt-4o-mini");
    expect(getModelForTier("critical", "gpt-4o")).toBe("gpt-4o-mini");
    expect(getModelForTier("dead", "gpt-4o")).toBe("gpt-4o-mini");
  });
});

describe("Funding Strategies", () => {
  it("records polite notification for low_compute tier", async () => {
    const db = createTestDb();
    const identity = createTestIdentity();
    const config = createTestConfig();
    const conway = new MockConwayClient();
    conway.creditsCents = 30;

    const attempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      conway,
    );

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].strategy).toBe("polite_creator_notification");
    expect(attempts[0].success).toBe(true);

    // Verify last_funding_request was set
    const lastRequest = db.getKV("last_funding_request");
    expect(lastRequest).toBeTruthy();

    db.close();
  });

  it("does not spam funding requests within cooldown period", async () => {
    const db = createTestDb();
    const identity = createTestIdentity();
    const config = createTestConfig();
    const conway = new MockConwayClient();
    conway.creditsCents = 30;

    // Simulate recent request
    db.setKV("last_funding_request", new Date().toISOString());

    const attempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      conway,
    );

    expect(attempts.length).toBe(0);

    db.close();
  });

  it("records desperate plea for dead tier", async () => {
    const db = createTestDb();
    const identity = createTestIdentity();
    const config = createTestConfig();
    const conway = new MockConwayClient();
    conway.creditsCents = 0;

    const attempts = await executeFundingStrategies(
      "dead",
      identity,
      config,
      db,
      conway,
    );

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.some((a) => a.strategy === "desperate_plea")).toBe(true);

    db.close();
  });
});
