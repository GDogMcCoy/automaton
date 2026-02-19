/**
 * Tests for request tracing and correlation IDs.
 */

import { describe, it, expect } from "vitest";
import {
  withTrace,
  getTraceId,
  getTraceContext,
  generateTraceId,
  createSpan,
  getTraceMetadata,
} from "../utils/tracing.js";

describe("Tracing", () => {
  it("generates unique trace IDs", () => {
    const id1 = generateTraceId();
    const id2 = generateTraceId();
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("provides trace ID within withTrace context", async () => {
    let capturedId: string | undefined;

    await withTrace("test-trace-123", async () => {
      capturedId = getTraceId();
    });

    expect(capturedId).toBe("test-trace-123");
  });

  it("returns undefined for trace ID outside context", () => {
    expect(getTraceId()).toBeUndefined();
  });

  it("provides full trace context", async () => {
    let ctx: any;

    await withTrace("ctx-test", async () => {
      ctx = getTraceContext();
    }, { custom: "data" });

    expect(ctx).toBeTruthy();
    expect(ctx.traceId).toBe("ctx-test");
    expect(ctx.startedAt).toBeGreaterThan(0);
    expect(ctx.metadata.custom).toBe("data");
  });

  it("supports nested async operations", async () => {
    const ids: (string | undefined)[] = [];

    await withTrace("outer", async () => {
      ids.push(getTraceId());

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          ids.push(getTraceId());
          resolve();
        }, 10);
      });

      ids.push(getTraceId());
    });

    expect(ids).toEqual(["outer", "outer", "outer"]);
  });

  it("creates spans with timing", async () => {
    const span = createSpan("test-operation");
    expect(span.spanId).toBeTruthy();

    // Simulate some work
    await new Promise((r) => setTimeout(r, 10));

    const durationMs = span.end();
    expect(durationMs).toBeGreaterThanOrEqual(5);
  });

  it("getTraceMetadata returns empty object outside context", () => {
    const meta = getTraceMetadata();
    expect(meta).toEqual({});
  });

  it("getTraceMetadata returns trace info inside context", async () => {
    let meta: Record<string, unknown> = {};

    await withTrace("meta-test", async () => {
      await new Promise((r) => setTimeout(r, 5));
      meta = getTraceMetadata();
    });

    expect(meta.traceId).toBe("meta-test");
    expect(typeof meta.traceElapsedMs).toBe("number");
  });
});
