/**
 * Metrics Collector Tests
 *
 * Tests for the in-memory metrics system: counters, gauges, and histograms.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMetricsCollector } from "../utils/metrics.js";
import type { MetricsCollector } from "../utils/metrics.js";

describe("MetricsCollector", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = createMetricsCollector();
  });

  // ─── Counter ────────────────────────────────────────────────

  describe("counter", () => {
    it("increments correctly", () => {
      metrics.counter("requests.total");
      metrics.counter("requests.total");
      metrics.counter("requests.total");

      const snapshot = metrics.getMetrics();
      expect(snapshot.counters["requests.total"]).toBe(3);
    });

    it("starts at 1 on first increment", () => {
      metrics.counter("new.counter");

      const snapshot = metrics.getMetrics();
      expect(snapshot.counters["new.counter"]).toBe(1);
    });

    it("tracks separate counters independently", () => {
      metrics.counter("counter.a");
      metrics.counter("counter.a");
      metrics.counter("counter.b");

      const snapshot = metrics.getMetrics();
      expect(snapshot.counters["counter.a"]).toBe(2);
      expect(snapshot.counters["counter.b"]).toBe(1);
    });
  });

  // ─── Gauge ──────────────────────────────────────────────────

  describe("gauge", () => {
    it("sets value correctly", () => {
      metrics.gauge("temperature", 72.5);

      const snapshot = metrics.getMetrics();
      expect(snapshot.gauges["temperature"]).toBe(72.5);
    });

    it("overwrites previous value", () => {
      metrics.gauge("memory.used", 100);
      metrics.gauge("memory.used", 200);
      metrics.gauge("memory.used", 150);

      const snapshot = metrics.getMetrics();
      expect(snapshot.gauges["memory.used"]).toBe(150);
    });

    it("supports negative values", () => {
      metrics.gauge("offset", -10);

      const snapshot = metrics.getMetrics();
      expect(snapshot.gauges["offset"]).toBe(-10);
    });

    it("supports zero", () => {
      metrics.gauge("idle", 0);

      const snapshot = metrics.getMetrics();
      expect(snapshot.gauges["idle"]).toBe(0);
    });
  });

  // ─── Histogram ──────────────────────────────────────────────

  describe("histogram", () => {
    it("tracks count, sum, min, max, avg", () => {
      metrics.histogram("response.time", 10);
      metrics.histogram("response.time", 20);
      metrics.histogram("response.time", 30);

      const snapshot = metrics.getMetrics();
      const hist = snapshot.histograms["response.time"];

      expect(hist.count).toBe(3);
      expect(hist.sum).toBe(60);
      expect(hist.min).toBe(10);
      expect(hist.max).toBe(30);
      expect(hist.avg).toBe(20);
    });

    it("handles a single observation", () => {
      metrics.histogram("latency", 42);

      const snapshot = metrics.getMetrics();
      const hist = snapshot.histograms["latency"];

      expect(hist.count).toBe(1);
      expect(hist.sum).toBe(42);
      expect(hist.min).toBe(42);
      expect(hist.max).toBe(42);
      expect(hist.avg).toBe(42);
    });

    it("updates min and max correctly as values change", () => {
      metrics.histogram("size", 50);
      metrics.histogram("size", 10);
      metrics.histogram("size", 90);
      metrics.histogram("size", 30);

      const snapshot = metrics.getMetrics();
      const hist = snapshot.histograms["size"];

      expect(hist.min).toBe(10);
      expect(hist.max).toBe(90);
    });

    it("computes avg correctly with fractional values", () => {
      metrics.histogram("precision", 1.5);
      metrics.histogram("precision", 2.5);

      const snapshot = metrics.getMetrics();
      const hist = snapshot.histograms["precision"];

      expect(hist.avg).toBe(2.0);
    });
  });

  // ─── getMetrics ─────────────────────────────────────────────

  describe("getMetrics", () => {
    it("returns all metrics in a single snapshot", () => {
      metrics.counter("c1");
      metrics.gauge("g1", 10);
      metrics.histogram("h1", 5);

      const snapshot = metrics.getMetrics();

      expect(snapshot.counters["c1"]).toBe(1);
      expect(snapshot.gauges["g1"]).toBe(10);
      expect(snapshot.histograms["h1"]).toBeDefined();
      expect(snapshot.histograms["h1"].count).toBe(1);
    });

    it("returns empty collections when no metrics recorded", () => {
      const snapshot = metrics.getMetrics();

      expect(Object.keys(snapshot.counters)).toHaveLength(0);
      expect(Object.keys(snapshot.gauges)).toHaveLength(0);
      expect(Object.keys(snapshot.histograms)).toHaveLength(0);
    });

    it("returns a serializable snapshot (no Map, no internal state)", () => {
      metrics.counter("test");
      metrics.gauge("test", 1);
      metrics.histogram("test", 1);

      const snapshot = metrics.getMetrics();
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json);

      expect(parsed.counters["test"]).toBe(1);
      expect(parsed.gauges["test"]).toBe(1);
      expect(parsed.histograms["test"].count).toBe(1);
    });
  });

  // ─── reset() ────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all metrics", () => {
      metrics.counter("requests");
      metrics.counter("requests");
      metrics.gauge("cpu", 85);
      metrics.histogram("duration", 100);

      // Verify they exist before reset
      const before = metrics.getMetrics();
      expect(before.counters["requests"]).toBe(2);
      expect(before.gauges["cpu"]).toBe(85);
      expect(before.histograms["duration"]).toBeDefined();

      metrics.reset();

      const after = metrics.getMetrics();
      expect(Object.keys(after.counters)).toHaveLength(0);
      expect(Object.keys(after.gauges)).toHaveLength(0);
      expect(Object.keys(after.histograms)).toHaveLength(0);
    });

    it("allows new metrics after reset", () => {
      metrics.counter("old");
      metrics.reset();
      metrics.counter("new");

      const snapshot = metrics.getMetrics();
      expect(snapshot.counters["old"]).toBeUndefined();
      expect(snapshot.counters["new"]).toBe(1);
    });
  });

  // ─── Labels ─────────────────────────────────────────────────

  describe("labels", () => {
    it("create separate metric keys for counters", () => {
      metrics.counter("requests.total", { method: "GET" });
      metrics.counter("requests.total", { method: "GET" });
      metrics.counter("requests.total", { method: "POST" });

      const snapshot = metrics.getMetrics();
      expect(snapshot.counters["requests.total{method=GET}"]).toBe(2);
      expect(snapshot.counters["requests.total{method=POST}"]).toBe(1);
    });

    it("create separate metric keys for gauges", () => {
      metrics.gauge("connections", 10, { region: "us-east" });
      metrics.gauge("connections", 5, { region: "eu-west" });

      const snapshot = metrics.getMetrics();
      expect(snapshot.gauges["connections{region=us-east}"]).toBe(10);
      expect(snapshot.gauges["connections{region=eu-west}"]).toBe(5);
    });

    it("create separate metric keys for histograms", () => {
      metrics.histogram("latency", 10, { endpoint: "/api" });
      metrics.histogram("latency", 20, { endpoint: "/api" });
      metrics.histogram("latency", 100, { endpoint: "/health" });

      const snapshot = metrics.getMetrics();
      expect(snapshot.histograms["latency{endpoint=/api}"].count).toBe(2);
      expect(snapshot.histograms["latency{endpoint=/api}"].avg).toBe(15);
      expect(snapshot.histograms["latency{endpoint=/health}"].count).toBe(1);
    });

    it("sorts label keys deterministically", () => {
      metrics.counter("metric", { z: "1", a: "2", m: "3" });

      const snapshot = metrics.getMetrics();
      // Keys should be sorted alphabetically: a, m, z
      expect(snapshot.counters["metric{a=2,m=3,z=1}"]).toBe(1);
    });

    it("treat no-labels and empty-labels the same", () => {
      metrics.counter("plain");
      metrics.counter("plain", {});

      const snapshot = metrics.getMetrics();
      // Both should increment the same key
      expect(snapshot.counters["plain"]).toBe(2);
    });
  });
});
