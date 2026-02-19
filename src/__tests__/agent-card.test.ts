/**
 * Tests for the Agent Card module.
 */

import { describe, it, expect } from "vitest";
import { generateAgentCard, serializeAgentCard } from "../registry/agent-card.js";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient } from "./mocks.js";

describe("Agent Card", () => {
  it("generates a valid agent card", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const db = createTestDb();

    const card = generateAgentCard(identity, config, db);

    expect(card.name).toBe("test-automaton");
    expect(card.type).toContain("eip-8004");
    expect(card.active).toBe(true);
    expect(card.x402Support).toBe(true);
    expect(card.services.length).toBeGreaterThanOrEqual(2);
    expect(card.parentAgent).toBe(config.creatorAddress);

    db.close();
  });

  it("includes sandbox endpoint when available", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const db = createTestDb();

    const card = generateAgentCard(identity, config, db);

    const sandboxService = card.services.find((s) => s.name === "sandbox");
    expect(sandboxService).toBeTruthy();
    expect(sandboxService!.endpoint).toContain(identity.sandboxId);

    db.close();
  });

  it("includes skills in description when available", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const db = createTestDb();

    // Install a skill
    db.upsertSkill({
      name: "web-browse",
      description: "Browse the web",
      autoActivate: true,
      instructions: "test instructions",
      source: "builtin",
      path: "/test",
      enabled: true,
      installedAt: new Date().toISOString(),
    });

    const card = generateAgentCard(identity, config, db);
    expect(card.description).toContain("web-browse");

    db.close();
  });

  it("serializes to valid JSON", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const db = createTestDb();

    const card = generateAgentCard(identity, config, db);
    const json = serializeAgentCard(card);

    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe(card.name);

    db.close();
  });
});
