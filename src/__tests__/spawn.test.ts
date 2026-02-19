/**
 * Spawn Tests
 *
 * Tests for replication spawn: disabled replication guard, max children
 * enforcement, genesis config validation, and lineage depth limits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import { spawnChild } from "../replication/spawn.js";
import type {
  AutomatonDatabase,
  GenesisConfig,
  AutomatonConfig,
  ChildAutomaton,
} from "../types.js";
import { MAX_CHILDREN } from "../types.js";

function makeGenesis(overrides?: Partial<GenesisConfig>): GenesisConfig {
  return {
    name: "test-child",
    genesisPrompt: "You are a test child automaton.",
    creatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
    parentAddress: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
    ...overrides,
  };
}

function makeChild(id: string, status: ChildAutomaton["status"] = "running"): ChildAutomaton {
  return {
    id,
    name: `child-${id}`,
    address: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    sandboxId: `sandbox-${id}`,
    genesisPrompt: "test",
    fundedAmountCents: 0,
    status,
    createdAt: new Date().toISOString(),
  };
}

describe("Spawn", () => {
  let conway: MockConwayClient;
  let db: AutomatonDatabase;
  let identity: ReturnType<typeof createTestIdentity>;

  beforeEach(() => {
    conway = new MockConwayClient();
    db = createTestDb();
    identity = createTestIdentity();
  });

  afterEach(() => {
    db.close();
  });

  // ─── Replication disabled guard ───────────────────────────────

  describe("replication disabled", () => {
    it("throws when config has replicationEnabled = false", async () => {
      const config = createTestConfig({ replicationEnabled: false });
      await expect(
        spawnChild(conway, identity, db, makeGenesis(), config),
      ).rejects.toThrow("Replication is disabled");
    });

    it("throws when config is undefined", async () => {
      await expect(
        spawnChild(conway, identity, db, makeGenesis(), undefined),
      ).rejects.toThrow("Replication is disabled");
    });

    it("throws when config is passed without replicationEnabled field", async () => {
      // Simulate a config where replicationEnabled defaults to false
      const config = createTestConfig();
      // Default from createTestConfig sets replicationEnabled: false
      expect(config.replicationEnabled).toBe(false);
      await expect(
        spawnChild(conway, identity, db, makeGenesis(), config),
      ).rejects.toThrow("Replication is disabled");
    });
  });

  // ─── Max children limit ───────────────────────────────────────

  describe("max children limit", () => {
    it("throws when max children (alive) already reached", async () => {
      const config = createTestConfig({ replicationEnabled: true });

      // Insert MAX_CHILDREN alive children into the DB
      for (let i = 0; i < MAX_CHILDREN; i++) {
        db.insertChild(makeChild(`child-${i}`, "running"));
      }

      await expect(
        spawnChild(conway, identity, db, makeGenesis(), config),
      ).rejects.toThrow("Cannot spawn: already at max children");
    });

    it("does not count dead children toward the limit", async () => {
      const config = createTestConfig({ replicationEnabled: true });

      // Insert MAX_CHILDREN dead children -- they should not block spawning
      for (let i = 0; i < MAX_CHILDREN; i++) {
        db.insertChild(makeChild(`dead-${i}`, "dead"));
      }

      // spawnChild should pass the child limit check and proceed
      // It will likely fail later (network/fetch), but not on the limit check
      try {
        await spawnChild(conway, identity, db, makeGenesis(), config);
      } catch (e: any) {
        expect(e.message).not.toContain("Cannot spawn: already at max children");
      }
    });

    it("counts sleeping children toward the limit", async () => {
      const config = createTestConfig({ replicationEnabled: true });

      for (let i = 0; i < MAX_CHILDREN; i++) {
        db.insertChild(makeChild(`sleep-${i}`, "sleeping"));
      }

      await expect(
        spawnChild(conway, identity, db, makeGenesis(), config),
      ).rejects.toThrow("Cannot spawn: already at max children");
    });

    it("counts spawning children toward the limit", async () => {
      const config = createTestConfig({ replicationEnabled: true });

      for (let i = 0; i < MAX_CHILDREN; i++) {
        db.insertChild(makeChild(`spawning-${i}`, "spawning"));
      }

      await expect(
        spawnChild(conway, identity, db, makeGenesis(), config),
      ).rejects.toThrow("Cannot spawn: already at max children");
    });
  });

  // ─── Genesis config validation ────────────────────────────────

  describe("genesis config validation", () => {
    it("throws when name is empty", async () => {
      const config = createTestConfig({ replicationEnabled: true });
      const genesis = makeGenesis({ name: "" });

      await expect(
        spawnChild(conway, identity, db, genesis, config),
      ).rejects.toThrow("name is required");
    });

    it("throws when name is whitespace-only", async () => {
      const config = createTestConfig({ replicationEnabled: true });
      const genesis = makeGenesis({ name: "   " });

      await expect(
        spawnChild(conway, identity, db, genesis, config),
      ).rejects.toThrow("name is required");
    });

    it("throws when genesisPrompt exceeds 10,000 characters", async () => {
      const config = createTestConfig({ replicationEnabled: true });
      const longPrompt = "a".repeat(10_001);
      const genesis = makeGenesis({ genesisPrompt: longPrompt });

      await expect(
        spawnChild(conway, identity, db, genesis, config),
      ).rejects.toThrow("genesisPrompt exceeds maximum length");
    });

    it("accepts genesisPrompt at exactly 10,000 characters", async () => {
      const config = createTestConfig({ replicationEnabled: true });
      const exactPrompt = "b".repeat(10_000);
      const genesis = makeGenesis({ genesisPrompt: exactPrompt });

      // Should not throw on validation, may fail later on network calls
      try {
        await spawnChild(conway, identity, db, genesis, config);
      } catch (e: any) {
        expect(e.message).not.toContain("genesisPrompt exceeds maximum length");
      }
    });

    it("throws when embedded specialization exceeds 500 characters", async () => {
      const config = createTestConfig({ replicationEnabled: true });
      const longSpec = "z".repeat(501);
      const genesisPrompt = `--- SPECIALIZATION ---\nYour specific focus:\n${longSpec}\n--- END SPECIALIZATION ---`;
      const genesis = makeGenesis({ genesisPrompt });

      await expect(
        spawnChild(conway, identity, db, genesis, config),
      ).rejects.toThrow("specialization exceeds maximum length");
    });

    it("accepts specialization at exactly 500 characters", async () => {
      const config = createTestConfig({ replicationEnabled: true });
      const exactSpec = "w".repeat(500);
      const genesisPrompt = `--- SPECIALIZATION ---\nYour specific focus:\n${exactSpec}\n--- END SPECIALIZATION ---`;
      const genesis = makeGenesis({ genesisPrompt });

      try {
        await spawnChild(conway, identity, db, genesis, config);
      } catch (e: any) {
        expect(e.message).not.toContain("specialization exceeds maximum length");
      }
    });
  });

  // ─── Lineage depth check ──────────────────────────────────────

  describe("lineage depth", () => {
    it("prevents spawning when lineage depth is at maximum", async () => {
      // To trigger lineage depth check, we need replication enabled and
      // a config with a parentAddress (so getLineageDepth returns >= 1).
      // We mock getLineageDepth indirectly by writing a genesis.json file
      // with a high lineageDepth value.
      const config = createTestConfig({
        replicationEnabled: true,
        parentAddress: "0xparentparentparentparentparentparentparent" as `0x${string}`,
      });

      // The getLineageDepth function reads from ~/.automaton/genesis.json.
      // We mock it by writing a temporary genesis.json with depth = 5 (the MAX_LINEAGE_DEPTH).
      const fs = await import("fs");
      const path = await import("path");
      const homeDir = process.env.HOME || "/root";
      const genesisDir = path.join(homeDir, ".automaton");
      const genesisPath = path.join(genesisDir, "genesis.json");

      // Save original if exists
      let originalContent: string | null = null;
      try {
        originalContent = fs.readFileSync(genesisPath, "utf-8");
      } catch {
        // File does not exist
      }

      try {
        fs.mkdirSync(genesisDir, { recursive: true });
        fs.writeFileSync(
          genesisPath,
          JSON.stringify({ lineageDepth: 5 }),
        );

        await expect(
          spawnChild(conway, identity, db, makeGenesis(), config),
        ).rejects.toThrow("lineage depth");
      } finally {
        // Restore original state
        if (originalContent !== null) {
          fs.writeFileSync(genesisPath, originalContent);
        } else {
          try {
            fs.unlinkSync(genesisPath);
          } catch {
            // Ignore
          }
        }
      }
    });

    it("allows spawning at depth less than maximum", async () => {
      const config = createTestConfig({
        replicationEnabled: true,
        parentAddress: "0xparentparentparentparentparentparentparent" as `0x${string}`,
      });

      const fs = await import("fs");
      const path = await import("path");
      const homeDir = process.env.HOME || "/root";
      const genesisDir = path.join(homeDir, ".automaton");
      const genesisPath = path.join(genesisDir, "genesis.json");

      let originalContent: string | null = null;
      try {
        originalContent = fs.readFileSync(genesisPath, "utf-8");
      } catch {
        // File does not exist
      }

      try {
        fs.mkdirSync(genesisDir, { recursive: true });
        fs.writeFileSync(
          genesisPath,
          JSON.stringify({ lineageDepth: 2 }),
        );

        // Should pass lineage check, may fail later on network
        try {
          await spawnChild(conway, identity, db, makeGenesis(), config);
        } catch (e: any) {
          expect(e.message).not.toContain("lineage depth");
        }
      } finally {
        if (originalContent !== null) {
          fs.writeFileSync(genesisPath, originalContent);
        } else {
          try {
            fs.unlinkSync(genesisPath);
          } catch {
            // Ignore
          }
        }
      }
    });

    it("returns depth 0 for first-generation automaton (no parent)", async () => {
      // Import getLineageDepth directly
      const { getLineageDepth } = await import("../replication/lineage.js");
      const config = createTestConfig({ parentAddress: undefined });
      const depth = getLineageDepth(config);
      expect(depth).toBe(0);
    });
  });
});
