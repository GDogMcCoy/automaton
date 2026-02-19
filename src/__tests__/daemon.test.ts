/**
 * Heartbeat Daemon Tests
 *
 * Tests for the heartbeat daemon lifecycle: create, start, stop, isRunning, forceRun.
 * Uses mock clients to avoid real side effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createHeartbeatDaemon,
  type HeartbeatDaemon,
  type HeartbeatDaemonOptions,
} from "../heartbeat/daemon.js";
import {
  MockConwayClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, HeartbeatEntry } from "../types.js";

describe("Heartbeat Daemon", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let daemon: HeartbeatDaemon;
  let options: HeartbeatDaemonOptions;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    conway = new MockConwayClient();
    options = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
    };
  });

  afterEach(() => {
    // Stop the daemon if running to clean up the interval
    if (daemon?.isRunning()) {
      daemon.stop();
    }
    db.close();
    vi.useRealTimers();
  });

  // ─── createHeartbeatDaemon ──────────────────────────────────

  describe("createHeartbeatDaemon", () => {
    it("returns an object with start, stop, isRunning, forceRun", () => {
      daemon = createHeartbeatDaemon(options);

      expect(daemon).toBeDefined();
      expect(typeof daemon.start).toBe("function");
      expect(typeof daemon.stop).toBe("function");
      expect(typeof daemon.isRunning).toBe("function");
      expect(typeof daemon.forceRun).toBe("function");
    });

    it("starts in not-running state", () => {
      daemon = createHeartbeatDaemon(options);
      expect(daemon.isRunning()).toBe(false);
    });
  });

  // ─── start / stop / isRunning ───────────────────────────────

  describe("start / stop / isRunning state transitions", () => {
    it("start transitions to running", () => {
      daemon = createHeartbeatDaemon(options);
      daemon.start();
      expect(daemon.isRunning()).toBe(true);
    });

    it("stop transitions back to not running", () => {
      daemon = createHeartbeatDaemon(options);
      daemon.start();
      expect(daemon.isRunning()).toBe(true);

      daemon.stop();
      expect(daemon.isRunning()).toBe(false);
    });

    it("calling start twice is a no-op (idempotent)", () => {
      daemon = createHeartbeatDaemon(options);
      daemon.start();
      daemon.start(); // should not throw or create duplicate intervals
      expect(daemon.isRunning()).toBe(true);
    });

    it("calling stop when not running is a no-op", () => {
      daemon = createHeartbeatDaemon(options);
      // Should not throw
      daemon.stop();
      expect(daemon.isRunning()).toBe(false);
    });

    it("can restart after stop", () => {
      daemon = createHeartbeatDaemon(options);

      daemon.start();
      expect(daemon.isRunning()).toBe(true);

      daemon.stop();
      expect(daemon.isRunning()).toBe(false);

      daemon.start();
      expect(daemon.isRunning()).toBe(true);
    });
  });

  // ─── forceRun ───────────────────────────────────────────────

  describe("forceRun", () => {
    it("executes a registered heartbeat task by name", async () => {
      // Register a heartbeat entry that maps to a builtin task
      db.upsertHeartbeatEntry({
        name: "test-health",
        schedule: "*/5 * * * *",
        task: "health_check",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(options);

      await daemon.forceRun("test-health");

      // health_check task calls conway.exec("echo alive", 5000)
      expect(conway.execCalls.length).toBeGreaterThanOrEqual(1);
      expect(conway.execCalls[0].command).toBe("echo alive");
    });

    it("updates lastRun after successful execution", async () => {
      db.upsertHeartbeatEntry({
        name: "test-health",
        schedule: "*/5 * * * *",
        task: "health_check",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(options);
      await daemon.forceRun("test-health");

      const entries = db.getHeartbeatEntries();
      const entry = entries.find((e) => e.name === "test-health");
      expect(entry!.lastRun).toBeDefined();
    });

    it("is a no-op for non-existent task name", async () => {
      daemon = createHeartbeatDaemon(options);

      // Should not throw
      await daemon.forceRun("does-not-exist");
      expect(conway.execCalls).toHaveLength(0);
    });

    it("is a no-op for entry with unknown task function", async () => {
      db.upsertHeartbeatEntry({
        name: "mystery",
        schedule: "*/5 * * * *",
        task: "nonexistent_task_function",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(options);

      // Should not throw -- unknown tasks are skipped silently
      await daemon.forceRun("mystery");
    });

    it("executes check_credits task and stores result in KV", async () => {
      conway.creditsCents = 5000;

      db.upsertHeartbeatEntry({
        name: "credit-checker",
        schedule: "*/10 * * * *",
        task: "check_credits",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(options);
      await daemon.forceRun("credit-checker");

      const creditCheck = db.getKV("last_credit_check");
      expect(creditCheck).toBeDefined();
      const parsed = JSON.parse(creditCheck!);
      expect(parsed.credits).toBe(5000);
      expect(parsed.tier).toBe("normal");
    });

    it("handles task execution errors gracefully", async () => {
      // Test that health_check task handles exec errors gracefully
      // by returning a wake request instead of crashing.
      conway.exec = async () => {
        throw new Error("API unreachable");
      };

      let wakeReason = "";
      options.onWakeRequest = (reason: string) => {
        wakeReason = reason;
      };

      db.upsertHeartbeatEntry({
        name: "credit-fail",
        schedule: "*/5 * * * *",
        task: "health_check",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(options);

      // Should not throw -- task catches errors internally
      await daemon.forceRun("credit-fail");

      // Task catches the error and triggers a wake request
      expect(wakeReason).toContain("Health check failed");
      expect(wakeReason).toContain("API unreachable");
    });
  });

  // ─── onWakeRequest callback ──────────────────────────────────

  describe("onWakeRequest callback", () => {
    it("fires when a task requests wake", async () => {
      // Set credits low enough to trigger distress in heartbeat_ping
      conway.creditsCents = 5; // "critical" tier

      const wakeReasons: string[] = [];
      const wakeOptions = {
        ...options,
        onWakeRequest: (reason: string) => wakeReasons.push(reason),
      };

      db.upsertHeartbeatEntry({
        name: "ping",
        schedule: "*/1 * * * *",
        task: "heartbeat_ping",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(wakeOptions);
      await daemon.forceRun("ping");

      expect(wakeReasons.length).toBeGreaterThanOrEqual(1);
      expect(wakeReasons[0]).toContain("Distress");
    });

    it("does not fire when task does not request wake", async () => {
      // Normal credits -- no distress
      conway.creditsCents = 10_000;

      const wakeReasons: string[] = [];
      const wakeOptions = {
        ...options,
        onWakeRequest: (reason: string) => wakeReasons.push(reason),
      };

      db.upsertHeartbeatEntry({
        name: "ping",
        schedule: "*/1 * * * *",
        task: "heartbeat_ping",
        enabled: true,
      });

      daemon = createHeartbeatDaemon(wakeOptions);
      await daemon.forceRun("ping");

      expect(wakeReasons).toHaveLength(0);
    });
  });

  // ─── Social inbox integration ───────────────────────────────

  describe("social inbox via daemon", () => {
    it("forceRun check_social_inbox with messages triggers wake", async () => {
      const social = new MockSocialClient();
      social.pollResponses.push({
        messages: [
          {
            id: "msg-1",
            from: "0xsender",
            to: "0xrecipient",
            content: "Ping!",
            signedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
      });

      const wakeReasons: string[] = [];

      daemon = createHeartbeatDaemon({
        ...options,
        social,
        onWakeRequest: (reason: string) => wakeReasons.push(reason),
      });

      db.upsertHeartbeatEntry({
        name: "inbox-check",
        schedule: "*/2 * * * *",
        task: "check_social_inbox",
        enabled: true,
      });

      await daemon.forceRun("inbox-check");

      expect(wakeReasons.length).toBe(1);
      expect(wakeReasons[0]).toContain("1 new message(s)");
    });
  });
});
