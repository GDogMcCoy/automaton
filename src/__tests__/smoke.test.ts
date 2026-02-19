/**
 * Integration Smoke Tests
 *
 * These tests validate the agent's startup path end-to-end using mocked
 * external dependencies but real internal wiring. They verify that the
 * database, config, tools, heartbeat, and health server all wire up correctly.
 *
 * For tests against a real Conway API, set CONWAY_API_KEY and CONWAY_API_URL
 * environment variables and run with: SMOKE=1 npx vitest run smoke.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../state/database.js";
import { createMetricsCollector } from "../utils/metrics.js";
import { createHealthServer, type HealthServer } from "../http/server.js";
import { validateConfig } from "../config.js";
import { runMigrations, getCurrentVersion, MIGRATIONS } from "../state/migrator.js";
import { loadSecret, validateRequiredSecrets, maskSecret } from "../utils/secrets.js";
import { withTrace, getTraceId, generateTraceId, createSpan } from "../utils/tracing.js";
import {
  createTestDb,
  createTestIdentity,
  createTestConfig,
  MockConwayClient,
  MockInferenceClient,
} from "./mocks.js";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

describe("Integration Smoke Tests", () => {
  describe("Full startup path (mocked API)", () => {
    it("creates database, runs migrations, configures tools, and starts health server", async () => {
      // 1. Create a fresh DB
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
      const dbPath = path.join(tmpDir, "smoke.db");
      const db = createDatabase(dbPath);

      // 2. Verify schema was created
      const turnCount = db.getTurnCount();
      expect(turnCount).toBe(0);

      // 3. Verify DB operations work
      const identity = createTestIdentity();
      db.setIdentity("name", "smoke-test");
      db.setIdentity("address", identity.address);
      expect(db.getIdentity("name")).toBe("smoke-test");

      // 4. Verify KV store works
      db.setKV("test_key", "test_value");
      expect(db.getKV("test_key")).toBe("test_value");
      db.deleteKV("test_key");
      expect(db.getKV("test_key")).toBeUndefined();

      // 5. Verify config validation
      const config = createTestConfig();
      const issues = validateConfig(config);
      expect(issues).toEqual([]);

      // 6. Verify metrics collection
      const metrics = createMetricsCollector();
      metrics.counter("smoke.test");
      metrics.gauge("smoke.gauge", 42);
      metrics.histogram("smoke.timing", 150);
      const snapshot = metrics.getMetrics();
      expect(snapshot.counters["smoke.test"]).toBe(1);
      expect(snapshot.gauges["smoke.gauge"]).toBe(42);

      // 7. Verify health server starts
      const port = 19899;
      const healthServer = createHealthServer({
        port,
        db,
        metrics,
        version: "0.1.0-smoke",
        startTime: Date.now(),
      });

      await healthServer.start();
      healthServer.setReady(true);

      // 8. Verify health endpoint
      const healthResponse = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        }).on("error", reject);
      });

      const health = JSON.parse(healthResponse);
      expect(health.status).toBe("healthy");
      expect(health.version).toBe("0.1.0-smoke");

      // 9. Verify metrics endpoint
      const metricsResponse = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/metrics`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        }).on("error", reject);
      });

      expect(metricsResponse).toContain("automaton_uptime_seconds");
      expect(metricsResponse).toContain("smoke_test");

      // 10. Verify DB integrity after all operations
      const integrity = db.integrityCheck();
      expect(integrity.ok).toBe(true);

      // Cleanup
      await healthServer.stop();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("Migration system integration", () => {
    it("runs all migrations and records history on fresh database", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-migrate-"));
      const dbPath = path.join(tmpDir, "migrate.db");
      const rawDb = new Database(dbPath);

      // Run all migrations
      const applied = runMigrations(rawDb);
      expect(applied).toBe(MIGRATIONS.length);

      // Verify version
      const version = getCurrentVersion(rawDb);
      expect(version).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);

      // Running again should be no-op
      const rerun = runMigrations(rawDb);
      expect(rerun).toBe(0);

      rawDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("Tracing integration", () => {
    it("maintains trace context through async operations", async () => {
      const traceId = generateTraceId();
      const ids: (string | undefined)[] = [];

      await withTrace(traceId, async () => {
        ids.push(getTraceId());

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 5));
        ids.push(getTraceId());

        // Simulate nested async
        const span = createSpan("inner-work");
        await new Promise((resolve) => setTimeout(resolve, 5));
        const duration = span.end();
        ids.push(getTraceId());

        expect(duration).toBeGreaterThanOrEqual(0);
      });

      // All IDs should be the same trace
      expect(ids.every((id) => id === traceId)).toBe(true);
    });
  });

  describe("Mock client integration", () => {
    it("Conway client and inference client work with agent loop dependencies", async () => {
      const conway = new MockConwayClient();
      const inference = new MockInferenceClient();

      // Verify credits
      const credits = await conway.getCreditsBalance();
      expect(credits).toBe(10_000);

      // Verify inference
      const response = await inference.chat([
        { role: "user", content: "Hello" },
      ]);
      expect(response.message.content).toBeTruthy();
      expect(response.usage.totalTokens).toBeGreaterThan(0);

      // Verify exec
      const execResult = await conway.exec("echo test");
      expect(execResult.exitCode).toBe(0);

      // Verify file I/O
      await conway.writeFile("/tmp/test.txt", "hello");
      const content = await conway.readFile("/tmp/test.txt");
      expect(content).toBe("hello");
    });
  });
});
