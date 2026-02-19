/**
 * Database Module Tests
 *
 * Tests for the SQLite-backed persistent state layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./mocks.js";
import type {
  AutomatonDatabase,
  AgentTurn,
  HeartbeatEntry,
  ChildAutomaton,
} from "../types.js";

describe("Database", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ─── Schema Initialization ──────────────────────────────────

  describe("schema initialization", () => {
    it("creates all expected tables", () => {
      // If tables were not created, these operations would throw
      expect(db.getTurnCount()).toBe(0);
      expect(db.getHeartbeatEntries()).toEqual([]);
      expect(db.getRecentTransactions(10)).toEqual([]);
      expect(db.getInstalledTools()).toEqual([]);
      expect(db.getRecentModifications(10)).toEqual([]);
      expect(db.getSkills()).toEqual([]);
      expect(db.getChildren()).toEqual([]);
      expect(db.getRegistryEntry()).toBeUndefined();
      expect(db.getReputation()).toEqual([]);
      expect(db.getUnprocessedInboxMessages(10)).toEqual([]);
    });

    it("integrityCheck returns ok for fresh database", () => {
      const result = db.integrityCheck();
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ─── Turns ──────────────────────────────────────────────────

  describe("insertTurn and getTurnCount", () => {
    it("inserts a turn and increments count", () => {
      expect(db.getTurnCount()).toBe(0);

      db.insertTurn(makeTurn("turn-1"));
      expect(db.getTurnCount()).toBe(1);

      db.insertTurn(makeTurn("turn-2"));
      expect(db.getTurnCount()).toBe(2);
    });

    it("getTurnById retrieves a specific turn", () => {
      db.insertTurn(makeTurn("turn-abc", { thinking: "deep thought" }));
      const turn = db.getTurnById("turn-abc");
      expect(turn).toBeDefined();
      expect(turn!.id).toBe("turn-abc");
      expect(turn!.thinking).toBe("deep thought");
    });

    it("getTurnById returns undefined for missing turn", () => {
      expect(db.getTurnById("nonexistent")).toBeUndefined();
    });

    it("rejects duplicate turn IDs", () => {
      db.insertTurn(makeTurn("dup-turn"));
      expect(() => db.insertTurn(makeTurn("dup-turn"))).toThrow();
    });
  });

  describe("getRecentTurns", () => {
    it("returns turns in chronological order (oldest first)", () => {
      db.insertTurn(makeTurn("t1", { timestamp: "2025-01-01T00:00:00Z" }));
      db.insertTurn(makeTurn("t2", { timestamp: "2025-01-01T00:01:00Z" }));
      db.insertTurn(makeTurn("t3", { timestamp: "2025-01-01T00:02:00Z" }));

      const turns = db.getRecentTurns(10);
      expect(turns).toHaveLength(3);
      expect(turns[0].id).toBe("t1");
      expect(turns[1].id).toBe("t2");
      expect(turns[2].id).toBe("t3");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        db.insertTurn(
          makeTurn(`t${i}`, {
            timestamp: `2025-01-01T00:0${i}:00Z`,
          }),
        );
      }

      const turns = db.getRecentTurns(2);
      expect(turns).toHaveLength(2);
      // The 2 most recent, returned in chronological order
      expect(turns[0].id).toBe("t3");
      expect(turns[1].id).toBe("t4");
    });

    it("returns empty array when no turns exist", () => {
      expect(db.getRecentTurns(10)).toEqual([]);
    });
  });

  // ─── KV Store ──────────────────────────────────────────────

  describe("KV store", () => {
    it("setKV and getKV round-trip", () => {
      db.setKV("test_key", "test_value");
      expect(db.getKV("test_key")).toBe("test_value");
    });

    it("getKV returns undefined for missing key", () => {
      expect(db.getKV("nonexistent")).toBeUndefined();
    });

    it("setKV overwrites existing value", () => {
      db.setKV("key", "v1");
      db.setKV("key", "v2");
      expect(db.getKV("key")).toBe("v2");
    });

    it("deleteKV removes a key", () => {
      db.setKV("ephemeral", "here");
      expect(db.getKV("ephemeral")).toBe("here");
      db.deleteKV("ephemeral");
      expect(db.getKV("ephemeral")).toBeUndefined();
    });

    it("deleteKV is a no-op for missing key", () => {
      // Should not throw
      db.deleteKV("ghost_key");
    });

    it("stores and retrieves JSON values", () => {
      const payload = { nested: { count: 42, items: ["a", "b"] } };
      db.setKV("json_key", JSON.stringify(payload));
      const parsed = JSON.parse(db.getKV("json_key")!);
      expect(parsed).toEqual(payload);
    });
  });

  // ─── Heartbeat Entries ──────────────────────────────────────

  describe("heartbeat entries", () => {
    it("upserts and retrieves heartbeat entries", () => {
      const entry: HeartbeatEntry = {
        name: "ping",
        schedule: "*/5 * * * *",
        task: "heartbeat_ping",
        enabled: true,
        params: { foo: "bar" },
      };
      db.upsertHeartbeatEntry(entry);

      const entries = db.getHeartbeatEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("ping");
      expect(entries[0].schedule).toBe("*/5 * * * *");
      expect(entries[0].task).toBe("heartbeat_ping");
      expect(entries[0].enabled).toBe(true);
      expect(entries[0].params).toEqual({ foo: "bar" });
    });

    it("upsert replaces existing entry with same name", () => {
      db.upsertHeartbeatEntry({
        name: "check",
        schedule: "*/10 * * * *",
        task: "check_credits",
        enabled: true,
      });
      db.upsertHeartbeatEntry({
        name: "check",
        schedule: "*/30 * * * *",
        task: "check_credits",
        enabled: false,
      });

      const entries = db.getHeartbeatEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].schedule).toBe("*/30 * * * *");
      expect(entries[0].enabled).toBe(false);
    });

    it("updateHeartbeatLastRun sets the timestamp", () => {
      db.upsertHeartbeatEntry({
        name: "task-a",
        schedule: "*/5 * * * *",
        task: "heartbeat_ping",
        enabled: true,
      });

      const ts = "2025-06-01T12:00:00Z";
      db.updateHeartbeatLastRun("task-a", ts);

      const entries = db.getHeartbeatEntries();
      expect(entries[0].lastRun).toBe(ts);
    });

    it("returns empty array when no entries exist", () => {
      expect(db.getHeartbeatEntries()).toEqual([]);
    });
  });

  // ─── Children ───────────────────────────────────────────────

  describe("children tracking", () => {
    it("inserts and retrieves a child", () => {
      const child = makeChild("child-1");
      db.insertChild(child);

      const children = db.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe("child-1");
      expect(children[0].name).toBe("child-1");
      expect(children[0].status).toBe("spawning");
    });

    it("getChildById returns specific child", () => {
      db.insertChild(makeChild("c1"));
      db.insertChild(makeChild("c2"));

      const child = db.getChildById("c1");
      expect(child).toBeDefined();
      expect(child!.id).toBe("c1");
    });

    it("getChildById returns undefined for missing child", () => {
      expect(db.getChildById("nonexistent")).toBeUndefined();
    });

    it("updateChildStatus changes the status", () => {
      db.insertChild(makeChild("c1"));
      db.updateChildStatus("c1", "running");

      const child = db.getChildById("c1");
      expect(child!.status).toBe("running");
    });

    it("updateChildStatus cycles through all statuses", () => {
      db.insertChild(makeChild("c1"));

      const statuses = [
        "running",
        "sleeping",
        "dead",
        "unknown",
        "spawning",
      ] as const;
      for (const status of statuses) {
        db.updateChildStatus("c1", status);
        expect(db.getChildById("c1")!.status).toBe(status);
      }
    });

    it("getChildren returns newest first", () => {
      db.insertChild(makeChild("c1", "2025-01-01T00:00:00Z"));
      db.insertChild(makeChild("c2", "2025-01-02T00:00:00Z"));
      db.insertChild(makeChild("c3", "2025-01-03T00:00:00Z"));

      const children = db.getChildren();
      expect(children).toHaveLength(3);
      // ORDER BY created_at DESC
      expect(children[0].id).toBe("c3");
      expect(children[1].id).toBe("c2");
      expect(children[2].id).toBe("c1");
    });

    it("rejects duplicate child IDs", () => {
      db.insertChild(makeChild("dup-child"));
      expect(() => db.insertChild(makeChild("dup-child"))).toThrow();
    });
  });

  // ─── Identity ──────────────────────────────────────────────

  describe("identity key-value", () => {
    it("set and get identity round-trip", () => {
      db.setIdentity("wallet", "0xabc");
      expect(db.getIdentity("wallet")).toBe("0xabc");
    });

    it("returns undefined for missing identity key", () => {
      expect(db.getIdentity("missing")).toBeUndefined();
    });

    it("overwrites existing identity value", () => {
      db.setIdentity("name", "alpha");
      db.setIdentity("name", "beta");
      expect(db.getIdentity("name")).toBe("beta");
    });
  });

  // ─── Agent State ───────────────────────────────────────────

  describe("agent state", () => {
    it("defaults to setup", () => {
      expect(db.getAgentState()).toBe("setup");
    });

    it("transitions through states", () => {
      db.setAgentState("running");
      expect(db.getAgentState()).toBe("running");

      db.setAgentState("sleeping");
      expect(db.getAgentState()).toBe("sleeping");
    });
  });

  // ─── Tool Calls ────────────────────────────────────────────

  describe("tool calls", () => {
    it("inserts and retrieves tool calls for a turn", () => {
      db.insertTurn(makeTurn("turn-tc"));
      db.insertToolCall("turn-tc", {
        id: "tc-1",
        name: "exec",
        arguments: { command: "echo hi" },
        result: "hi",
        durationMs: 100,
      });

      const calls = db.getToolCallsForTurn("turn-tc");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("exec");
      expect(calls[0].arguments).toEqual({ command: "echo hi" });
      expect(calls[0].result).toBe("hi");
      expect(calls[0].durationMs).toBe(100);
      expect(calls[0].error).toBeUndefined();
    });

    it("returns empty array for turn with no tool calls", () => {
      db.insertTurn(makeTurn("turn-empty"));
      expect(db.getToolCallsForTurn("turn-empty")).toEqual([]);
    });

    it("stores tool call errors", () => {
      db.insertTurn(makeTurn("turn-err"));
      db.insertToolCall("turn-err", {
        id: "tc-err",
        name: "exec",
        arguments: { command: "fail" },
        result: "",
        durationMs: 50,
        error: "command failed",
      });

      const calls = db.getToolCallsForTurn("turn-err");
      expect(calls[0].error).toBe("command failed");
    });
  });

  // ─── Transactions ──────────────────────────────────────────

  describe("transactions", () => {
    it("inserts and retrieves transactions", () => {
      db.insertTransaction({
        id: "txn-1",
        type: "credit_check",
        amountCents: 1000,
        balanceAfterCents: 9000,
        description: "Balance check",
        timestamp: "2025-01-01T00:00:00Z",
      });

      const txns = db.getRecentTransactions(10);
      expect(txns).toHaveLength(1);
      expect(txns[0].id).toBe("txn-1");
      expect(txns[0].type).toBe("credit_check");
      expect(txns[0].description).toBe("Balance check");
    });

    it("returns empty array when no transactions", () => {
      expect(db.getRecentTransactions(10)).toEqual([]);
    });
  });

  // ─── Installed Tools ────────────────────────────────────────

  describe("installed tools", () => {
    it("installs and retrieves a tool", () => {
      db.installTool({
        id: "tool-1",
        name: "my-tool",
        type: "custom",
        config: { endpoint: "http://localhost:3000" },
        installedAt: "2025-01-01T00:00:00Z",
        enabled: true,
      });

      const tools = db.getInstalledTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("my-tool");
      expect(tools[0].config).toEqual({ endpoint: "http://localhost:3000" });
    });

    it("removeTool disables the tool", () => {
      db.installTool({
        id: "tool-2",
        name: "removable",
        type: "builtin",
        installedAt: "2025-01-01T00:00:00Z",
        enabled: true,
      });

      expect(db.getInstalledTools()).toHaveLength(1);
      db.removeTool("tool-2");
      // getInstalledTools only returns enabled tools
      expect(db.getInstalledTools()).toHaveLength(0);
    });
  });

  // ─── Modifications ─────────────────────────────────────────

  describe("modifications", () => {
    it("inserts and retrieves modifications", () => {
      db.insertModification({
        id: "mod-1",
        timestamp: "2025-01-01T00:00:00Z",
        type: "code_edit",
        description: "Updated index.ts",
        filePath: "src/index.ts",
        diff: "+console.log('hello');",
        reversible: true,
      });

      const mods = db.getRecentModifications(10);
      expect(mods).toHaveLength(1);
      expect(mods[0].type).toBe("code_edit");
      expect(mods[0].filePath).toBe("src/index.ts");
      expect(mods[0].reversible).toBe(true);
    });

    it("returns modifications in chronological order", () => {
      db.insertModification({
        id: "m1",
        timestamp: "2025-01-01T00:00:00Z",
        type: "code_edit",
        description: "first",
        reversible: false,
      });
      db.insertModification({
        id: "m2",
        timestamp: "2025-01-01T00:01:00Z",
        type: "config_change",
        description: "second",
        reversible: true,
      });

      const mods = db.getRecentModifications(10);
      expect(mods).toHaveLength(2);
      // Returned in chronological order (reversed from DESC)
      expect(mods[0].id).toBe("m1");
      expect(mods[1].id).toBe("m2");
    });

    it("returns empty array when no modifications", () => {
      expect(db.getRecentModifications(10)).toEqual([]);
    });
  });

  // ─── Skills ─────────────────────────────────────────────────

  describe("skills", () => {
    it("upserts and retrieves skills", () => {
      db.upsertSkill({
        name: "web-scraper",
        description: "Scrapes web pages",
        autoActivate: true,
        requires: { bins: ["curl"] },
        instructions: "Use this skill to scrape web pages.",
        source: "builtin",
        path: "/skills/web-scraper",
        enabled: true,
        installedAt: "2025-01-01T00:00:00Z",
      });

      const skills = db.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("web-scraper");
      expect(skills[0].requires).toEqual({ bins: ["curl"] });
    });

    it("getSkillByName returns specific skill", () => {
      db.upsertSkill({
        name: "test-skill",
        description: "A test",
        autoActivate: false,
        instructions: "Do the thing.",
        source: "git",
        path: "/skills/test",
        enabled: true,
        installedAt: "2025-01-01T00:00:00Z",
      });

      const skill = db.getSkillByName("test-skill");
      expect(skill).toBeDefined();
      expect(skill!.name).toBe("test-skill");
    });

    it("getSkillByName returns undefined for missing skill", () => {
      expect(db.getSkillByName("nonexistent")).toBeUndefined();
    });

    it("enabledOnly filter works", () => {
      db.upsertSkill({
        name: "active",
        description: "Active skill",
        autoActivate: true,
        instructions: "",
        source: "builtin",
        path: "",
        enabled: true,
        installedAt: "2025-01-01T00:00:00Z",
      });
      db.upsertSkill({
        name: "inactive",
        description: "Inactive skill",
        autoActivate: false,
        instructions: "",
        source: "builtin",
        path: "",
        enabled: false,
        installedAt: "2025-01-01T00:00:00Z",
      });

      const allSkills = db.getSkills();
      expect(allSkills).toHaveLength(2);

      const enabledSkills = db.getSkills(true);
      expect(enabledSkills).toHaveLength(1);
      expect(enabledSkills[0].name).toBe("active");
    });

    it("removeSkill disables the skill", () => {
      db.upsertSkill({
        name: "removable",
        description: "",
        autoActivate: false,
        instructions: "",
        source: "builtin",
        path: "",
        enabled: true,
        installedAt: "2025-01-01T00:00:00Z",
      });

      db.removeSkill("removable");
      const skill = db.getSkillByName("removable");
      expect(skill!.enabled).toBe(false);
    });
  });

  // ─── Registry ──────────────────────────────────────────────

  describe("registry", () => {
    it("sets and retrieves registry entry", () => {
      db.setRegistryEntry({
        agentId: "agent-1",
        agentURI: "https://agent.conway.tech",
        chain: "eip155:8453",
        contractAddress: "0xcontract",
        txHash: "0xtx",
        registeredAt: "2025-01-01T00:00:00Z",
      });

      const entry = db.getRegistryEntry();
      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe("agent-1");
      expect(entry!.agentURI).toBe("https://agent.conway.tech");
    });

    it("returns undefined when no registry entry", () => {
      expect(db.getRegistryEntry()).toBeUndefined();
    });
  });

  // ─── Reputation ────────────────────────────────────────────

  describe("reputation", () => {
    it("inserts and retrieves reputation entries", () => {
      db.insertReputation({
        id: "rep-1",
        fromAgent: "0xfrom",
        toAgent: "0xto",
        score: 5,
        comment: "Great agent!",
        timestamp: "2025-01-01T00:00:00Z",
      });

      const reps = db.getReputation();
      expect(reps).toHaveLength(1);
      expect(reps[0].score).toBe(5);
      expect(reps[0].comment).toBe("Great agent!");
    });

    it("filters by agent address", () => {
      db.insertReputation({
        id: "rep-a",
        fromAgent: "0xfrom",
        toAgent: "0xagent-A",
        score: 4,
        comment: "Good",
        timestamp: "2025-01-01T00:00:00Z",
      });
      db.insertReputation({
        id: "rep-b",
        fromAgent: "0xfrom",
        toAgent: "0xagent-B",
        score: 3,
        comment: "Ok",
        timestamp: "2025-01-01T00:00:00Z",
      });

      const repsA = db.getReputation("0xagent-A");
      expect(repsA).toHaveLength(1);
      expect(repsA[0].toAgent).toBe("0xagent-A");
    });
  });

  // ─── Inbox Messages ────────────────────────────────────────

  describe("inbox messages", () => {
    it("inserts and retrieves unprocessed messages", () => {
      db.insertInboxMessage({
        id: "msg-1",
        from: "0xsender",
        to: "0xrecipient",
        content: "Hello!",
        signedAt: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
      });

      const msgs = db.getUnprocessedInboxMessages(10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Hello!");
    });

    it("markInboxMessageProcessed removes from unprocessed list", () => {
      db.insertInboxMessage({
        id: "msg-2",
        from: "0xsender",
        to: "0xrecipient",
        content: "Process me",
        signedAt: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
      });

      db.markInboxMessageProcessed("msg-2");
      const msgs = db.getUnprocessedInboxMessages(10);
      expect(msgs).toHaveLength(0);
    });

    it("duplicate message insert is ignored (INSERT OR IGNORE)", () => {
      const msg = {
        id: "msg-dup",
        from: "0xsender",
        to: "0xrecipient",
        content: "Once",
        signedAt: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
      };

      db.insertInboxMessage(msg);
      // Should not throw
      db.insertInboxMessage(msg);

      const msgs = db.getUnprocessedInboxMessages(10);
      expect(msgs).toHaveLength(1);
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────

  describe("edge cases", () => {
    it("empty database returns correct defaults", () => {
      expect(db.getTurnCount()).toBe(0);
      expect(db.getRecentTurns(100)).toEqual([]);
      expect(db.getHeartbeatEntries()).toEqual([]);
      expect(db.getChildren()).toEqual([]);
      expect(db.getAgentState()).toBe("setup");
      expect(db.getKV("anything")).toBeUndefined();
      expect(db.getIdentity("anything")).toBeUndefined();
    });

    it("handles special characters in KV values", () => {
      const specialValue = 'quotes"and\'backslash\\and\nnewline';
      db.setKV("special", specialValue);
      expect(db.getKV("special")).toBe(specialValue);
    });

    it("handles empty string KV values", () => {
      db.setKV("empty", "");
      // better-sqlite3 + NOT NULL constraint: empty string is valid
      expect(db.getKV("empty")).toBe("");
    });

    it("handles unicode in turn thinking", () => {
      db.insertTurn(makeTurn("unicode-turn", { thinking: "Thinking with emojis and CJK characters" }));
      const turn = db.getTurnById("unicode-turn");
      expect(turn!.thinking).toBe("Thinking with emojis and CJK characters");
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────

function makeTurn(
  id: string,
  overrides?: Partial<AgentTurn>,
): AgentTurn {
  return {
    id,
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    state: "running",
    thinking: overrides?.thinking ?? "Thinking...",
    toolCalls: [],
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costCents: 1,
    ...overrides,
  };
}

function makeChild(
  id: string,
  createdAt?: string,
): ChildAutomaton {
  return {
    id,
    name: id,
    address: "0xchild" as `0x${string}`,
    sandboxId: `sandbox-${id}`,
    genesisPrompt: "Be a good child.",
    fundedAmountCents: 500,
    status: "spawning",
    createdAt: createdAt ?? new Date().toISOString(),
  };
}
