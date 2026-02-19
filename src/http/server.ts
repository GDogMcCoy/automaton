/**
 * Internal HTTP Server
 *
 * Lightweight HTTP server for health checks, metrics, and the agent card.
 * Runs on port 8080 (configurable via HEALTH_PORT env var).
 *
 * Endpoints:
 *   GET /health           - Health check (returns 200/503)
 *   GET /metrics          - Prometheus-format metrics
 *   GET /ready            - Readiness probe (200 when agent loop is active)
 *   GET /.well-known/agent-card.json - Agent card (if configured)
 */

import http from "http";
import type { AutomatonDatabase } from "../types.js";
import type { MetricsCollector } from "../utils/metrics.js";
import { createRateLimiter } from "../utils/rate-limiter.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("http");

export interface HealthServerOptions {
  port: number;
  db: AutomatonDatabase;
  metrics: MetricsCollector;
  getAgentCard?: () => string | null;
  version: string;
  startTime: number;
}

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  setReady(ready: boolean): void;
}

export function createHealthServer(opts: HealthServerOptions): HealthServer {
  let isReady = false;
  let server: http.Server | null = null;

  // Rate limit: 60 requests per minute per IP
  const limiter = createRateLimiter(60_000, 60);

  function getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0].trim();
    }
    return req.socket.remoteAddress || "unknown";
  }

  function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const dbOk = opts.db.integrityCheck().ok;
    const state = opts.db.getAgentState();
    const uptimeMs = Date.now() - opts.startTime;

    const body = JSON.stringify({
      status: dbOk ? "healthy" : "degraded",
      version: opts.version,
      uptime_seconds: Math.floor(uptimeMs / 1000),
      agent_state: state,
      timestamp: new Date().toISOString(),
    });

    const statusCode = dbOk ? 200 : 503;
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  }

  function handleReady(_req: http.IncomingMessage, res: http.ServerResponse): void {
    if (isReady) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: true }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: false }));
    }
  }

  function handleMetrics(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const snapshot = opts.metrics.getMetrics();
    const lines: string[] = [];

    // Counters
    for (const [name, value] of Object.entries(snapshot.counters)) {
      const promName = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/\{.*\}/, "");
      const labels = extractLabels(name);
      lines.push(`# TYPE ${promName} counter`);
      lines.push(`${promName}${labels} ${value}`);
    }

    // Gauges
    for (const [name, value] of Object.entries(snapshot.gauges)) {
      const promName = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/\{.*\}/, "");
      const labels = extractLabels(name);
      lines.push(`# TYPE ${promName} gauge`);
      lines.push(`${promName}${labels} ${value}`);
    }

    // Histograms (summary-style)
    for (const [name, stats] of Object.entries(snapshot.histograms)) {
      const promName = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/\{.*\}/, "");
      const labels = extractLabels(name);
      lines.push(`# TYPE ${promName} summary`);
      lines.push(`${promName}_count${labels} ${stats.count}`);
      lines.push(`${promName}_sum${labels} ${stats.sum}`);
      lines.push(`${promName}_min${labels} ${stats.min}`);
      lines.push(`${promName}_max${labels} ${stats.max}`);
      lines.push(`${promName}_avg${labels} ${stats.avg}`);
    }

    // Add uptime gauge
    lines.push("# TYPE automaton_uptime_seconds gauge");
    lines.push(`automaton_uptime_seconds ${Math.floor((Date.now() - opts.startTime) / 1000)}`);

    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(lines.join("\n") + "\n");
  }

  function handleAgentCard(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const card = opts.getAgentCard?.();
    if (card) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      });
      res.end(card);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent card not configured" }));
    }
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const ip = getClientIp(req);

    // Rate limiting (exempt health and ready for orchestrator probes)
    if (req.url !== "/health" && req.url !== "/ready") {
      if (!limiter.consume(ip)) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify({ error: "Too many requests" }));
        opts.metrics.counter("http.rate_limited", { ip });
        return;
      }
    }

    opts.metrics.counter("http.requests", { path: req.url || "/" });

    const url = req.url || "/";

    if (url === "/health") {
      handleHealth(req, res);
    } else if (url === "/ready") {
      handleReady(req, res);
    } else if (url === "/metrics") {
      handleMetrics(req, res);
    } else if (url === "/.well-known/agent-card.json" || url === "/agent-card.json") {
      handleAgentCard(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  async function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server = http.createServer(handleRequest);

      server.on("error", (err) => {
        log.error("HTTP server error", { error: err.message });
        reject(err);
      });

      // Set timeouts to prevent slowloris
      server.headersTimeout = 10_000;
      server.requestTimeout = 10_000;
      server.keepAliveTimeout = 5_000;

      server.listen(opts.port, () => {
        log.info("HTTP server started", { port: opts.port });
        resolve();
      });
    });
  }

  async function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (server) {
        server.close(() => {
          log.info("HTTP server stopped");
          resolve();
        });
        // Force-close connections after 5s
        setTimeout(() => {
          resolve();
        }, 5_000);
      } else {
        resolve();
      }
    });
  }

  function setReady(ready: boolean): void {
    isReady = ready;
  }

  return { start, stop, setReady };
}

/**
 * Extract Prometheus-style labels from a metric key like "name{key=val,key2=val2}"
 */
function extractLabels(key: string): string {
  const match = key.match(/\{(.+)\}/);
  if (!match) return "";
  // Convert key=val format to key="val" format
  const pairs = match[1].split(",").map((pair) => {
    const [k, v] = pair.split("=");
    return `${k}="${v}"`;
  });
  return `{${pairs.join(",")}}`;
}
