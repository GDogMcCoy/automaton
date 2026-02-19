/**
 * Metrics Collector
 *
 * Lightweight in-memory metrics for counters, gauges, and histograms.
 * JSON-serializable snapshots -- no Prometheus format, no external deps.
 *
 * Usage:
 *   import { createMetricsCollector } from "../utils/metrics.js";
 *   const metrics = createMetricsCollector();
 *   metrics.counter("requests.total", { method: "GET" });
 *   metrics.histogram("response.duration_ms", 42);
 *   console.log(metrics.getMetrics());
 */

// ─── Types ──────────────────────────────────────────────────────

export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramStats>;
}

export interface MetricsCollector {
  /** Increment a counter by 1. */
  counter(name: string, labels?: Record<string, string>): void;
  /** Set a gauge to an absolute value. */
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  /** Record a single observation in a histogram. */
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  /** Return a JSON-serializable snapshot of all current metrics. */
  getMetrics(): MetricsSnapshot;
  /** Clear all recorded metrics. */
  reset(): void;
}

// ─── Internals ──────────────────────────────────────────────────

/**
 * Build a composite key from a metric name and optional labels.
 * Labels are sorted by key to ensure deterministic ordering:
 *   "requests.total{method=GET,path=/api}"
 */
function buildKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return name;
  }
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
  return `${name}{${parts}}`;
}

/** Mutable accumulator for histogram observations. */
interface HistogramAccumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create an in-memory metrics collector.
 */
export function createMetricsCollector(): MetricsCollector {
  let counters = new Map<string, number>();
  let gauges = new Map<string, number>();
  let histograms = new Map<string, HistogramAccumulator>();

  function counter(name: string, labels?: Record<string, string>): void {
    const key = buildKey(name, labels);
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function gauge(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): void {
    const key = buildKey(name, labels);
    gauges.set(key, value);
  }

  function histogram(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): void {
    const key = buildKey(name, labels);
    const existing = histograms.get(key);

    if (existing) {
      existing.count++;
      existing.sum += value;
      if (value < existing.min) existing.min = value;
      if (value > existing.max) existing.max = value;
    } else {
      histograms.set(key, {
        count: 1,
        sum: value,
        min: value,
        max: value,
      });
    }
  }

  function getMetrics(): MetricsSnapshot {
    const counterSnapshot: Record<string, number> = {};
    for (const [k, v] of counters) {
      counterSnapshot[k] = v;
    }

    const gaugeSnapshot: Record<string, number> = {};
    for (const [k, v] of gauges) {
      gaugeSnapshot[k] = v;
    }

    const histogramSnapshot: Record<string, HistogramStats> = {};
    for (const [k, acc] of histograms) {
      histogramSnapshot[k] = {
        count: acc.count,
        sum: acc.sum,
        min: acc.min,
        max: acc.max,
        avg: acc.count > 0 ? acc.sum / acc.count : 0,
      };
    }

    return {
      counters: counterSnapshot,
      gauges: gaugeSnapshot,
      histograms: histogramSnapshot,
    };
  }

  function reset(): void {
    counters = new Map();
    gauges = new Map();
    histograms = new Map();
  }

  return { counter, gauge, histogram, getMetrics, reset };
}
