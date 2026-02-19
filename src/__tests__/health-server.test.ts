/**
 * Tests for the HTTP health/metrics/readiness server.
 */

import { describe, it, expect } from "vitest";
import http from "http";
import { createHealthServer, type HealthServer } from "../http/server.js";
import { createMetricsCollector } from "../utils/metrics.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

let portCounter = 19870;

function nextPort(): number {
  return portCounter++;
}

function fetchFrom(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

async function withServer(
  opts: Partial<{
    getAgentCard: () => string | null;
  }>,
  fn: (port: number, server: HealthServer, db: AutomatonDatabase) => Promise<void>,
): Promise<void> {
  const port = nextPort();
  const db = createTestDb();
  const metrics = createMetricsCollector();
  metrics.counter("test.counter");
  metrics.gauge("test.gauge", 42);
  metrics.histogram("test.histogram", 100);

  const server = createHealthServer({
    port,
    db,
    metrics,
    version: "0.1.0-test",
    startTime: Date.now() - 5000,
    getAgentCard: opts.getAgentCard,
  });

  await server.start();
  try {
    await fn(port, server, db);
  } finally {
    await server.stop();
    try { db.close(); } catch {}
  }
}

describe("Health Server", () => {
  it("responds to /health with JSON status", async () => {
    await withServer({}, async (port) => {
      const { status, body } = await fetchFrom(port, "/health");
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.status).toBe("healthy");
      expect(json.version).toBe("0.1.0-test");
      expect(json.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(json.timestamp).toBeTruthy();
    });
  });

  it("responds to /ready with 503 when not ready", async () => {
    await withServer({}, async (port, server) => {
      server.setReady(false);
      const { status, body } = await fetchFrom(port, "/ready");
      expect(status).toBe(503);
      const json = JSON.parse(body);
      expect(json.ready).toBe(false);
    });
  });

  it("responds to /ready with 200 when ready", async () => {
    await withServer({}, async (port, server) => {
      server.setReady(true);
      const { status, body } = await fetchFrom(port, "/ready");
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.ready).toBe(true);
    });
  });

  it("serves Prometheus-format metrics at /metrics", async () => {
    await withServer({}, async (port) => {
      const { status, body, headers } = await fetchFrom(port, "/metrics");
      expect(status).toBe(200);
      expect(headers["content-type"]).toContain("text/plain");
      expect(body).toContain("automaton_uptime_seconds");
      expect(body).toContain("test_counter");
      expect(body).toContain("test_gauge");
      expect(body).toContain("test_histogram");
    });
  });

  it("returns 404 for unknown routes", async () => {
    await withServer({}, async (port) => {
      const { status } = await fetchFrom(port, "/nonexistent");
      expect(status).toBe(404);
    });
  });

  it("serves agent card when configured", async () => {
    const card = JSON.stringify({ name: "test-agent", type: "test" });
    await withServer({ getAgentCard: () => card }, async (port) => {
      const { status, body } = await fetchFrom(port, "/.well-known/agent-card.json");
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.name).toBe("test-agent");
    });
  });

  it("returns 404 for agent card when not configured", async () => {
    await withServer({}, async (port) => {
      const { status } = await fetchFrom(port, "/.well-known/agent-card.json");
      expect(status).toBe(404);
    });
  });
});
