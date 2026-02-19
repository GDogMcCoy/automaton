/**
 * Tests for multi-provider inference with automatic failover.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMultiProviderInference,
  buildProviderList,
  type InferenceProvider,
} from "../conway/multi-provider.js";
import { createMetricsCollector } from "../utils/metrics.js";

// ─── Mock fetch ─────────────────────────────────────────────────

function mockFetchSuccess(model = "gpt-4o") {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      id: "resp-1",
      model,
      choices: [
        {
          message: { role: "assistant", content: "Hello from mock" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
}

function mockFetchFailure(status = 500) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => `Server error ${status}`,
  });
}

function mockFetchNetworkError() {
  return vi.fn().mockRejectedValue(new Error("ECONNRESET"));
}

const testProviders: InferenceProvider[] = [
  {
    name: "primary",
    apiUrl: "https://primary.test",
    apiKey: "pk-primary",
    authStyle: "raw",
    priority: 0,
  },
  {
    name: "fallback",
    apiUrl: "https://fallback.test",
    apiKey: "pk-fallback",
    authStyle: "bearer",
    priority: 1,
  },
];

describe("Multi-Provider Inference", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses primary provider when healthy", async () => {
    const mockFetch = mockFetchSuccess();
    globalThis.fetch = mockFetch as any;

    const client = createMultiProviderInference({
      providers: testProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    const response = await client.chat([
      { role: "user", content: "Hello" },
    ]);

    expect(response.message.content).toBe("Hello from mock");
    expect(response.usage.totalTokens).toBe(15);
    expect(client.getActiveProvider()).toBe("primary");

    // Verify it called the primary URL
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain("primary.test");
  });

  it("falls back to secondary when primary fails", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
      callCount++;
      if (typeof url === "string" && url.includes("primary.test")) {
        return { ok: false, status: 500, text: async () => "primary down" };
      }
      return {
        ok: true,
        json: async () => ({
          id: "resp-fallback",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "Hello from fallback" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      };
    }) as any;

    const client = createMultiProviderInference({
      providers: testProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    const response = await client.chat([
      { role: "user", content: "Hello" },
    ]);

    expect(response.message.content).toBe("Hello from fallback");
    expect(client.getActiveProvider()).toBe("fallback");
  });

  it("throws when all providers fail", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "all down",
    })) as any;

    const client = createMultiProviderInference({
      providers: testProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    await expect(
      client.chat([{ role: "user", content: "Hello" }]),
    ).rejects.toThrow();
  });

  it("trips circuit breaker after consecutive failures", async () => {
    // Use unique provider names to avoid circuit breaker state leaking
    const cbProviders: InferenceProvider[] = [
      { name: "cb-primary", apiUrl: "https://cb-primary.test", apiKey: "pk", authStyle: "raw", priority: 0 },
      { name: "cb-fallback", apiUrl: "https://cb-fallback.test", apiKey: "pk", authStyle: "raw", priority: 1 },
    ];

    globalThis.fetch = vi.fn(async (url: any) => {
      if (typeof url === "string" && url.includes("cb-primary.test")) {
        return { ok: false, status: 500, text: async () => "down" };
      }
      return {
        ok: true,
        json: async () => ({
          id: "resp",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "fallback" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      };
    }) as any;

    const client = createMultiProviderInference({
      providers: cbProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    // Fail primary 3 times (circuit breaker threshold)
    for (let i = 0; i < 3; i++) {
      await client.chat([{ role: "user", content: "Hello" }]);
    }

    // Check health — primary should have circuit breaker open
    const health = client.getProviderHealth();
    const primary = health.find((h) => h.name === "cb-primary");
    expect(primary?.circuitBreakerOpen).toBe(true);
    expect(primary?.consecutiveFailures).toBe(3);

    const fallback = health.find((h) => h.name === "cb-fallback");
    expect(fallback?.healthy).toBe(true);
  });

  it("reports provider health correctly", async () => {
    const healthProviders: InferenceProvider[] = [
      { name: "health-p1", apiUrl: "https://hp1.test", apiKey: "pk", priority: 0 },
      { name: "health-p2", apiUrl: "https://hp2.test", apiKey: "pk", priority: 1 },
    ];

    globalThis.fetch = mockFetchSuccess() as any;

    const client = createMultiProviderInference({
      providers: healthProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    await client.chat([{ role: "user", content: "Hello" }]);

    const health = client.getProviderHealth();
    expect(health.length).toBe(2);
    expect(health[0].name).toBe("health-p1");
    expect(health[0].totalRequests).toBe(1);
    expect(health[0].totalFailures).toBe(0);
    expect(health[0].healthy).toBe(true);
  });

  it("supports manual marking of providers as unhealthy", async () => {
    globalThis.fetch = mockFetchSuccess() as any;

    const client = createMultiProviderInference({
      providers: testProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    client.markUnhealthy("primary", "manual test");

    const health = client.getProviderHealth();
    const primary = health.find((h) => h.name === "primary");
    expect(primary?.circuitBreakerOpen).toBe(true);
    expect(primary?.lastError).toBe("manual test");
  });

  it("supports manual provider reset", async () => {
    globalThis.fetch = mockFetchSuccess() as any;

    const client = createMultiProviderInference({
      providers: testProviders,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    client.markUnhealthy("primary", "test");
    client.resetProvider("primary");

    const health = client.getProviderHealth();
    const primary = health.find((h) => h.name === "primary");
    expect(primary?.circuitBreakerOpen).toBe(false);
    expect(primary?.consecutiveFailures).toBe(0);
  });

  it("applies model mapping for fallback providers", async () => {
    const providers: InferenceProvider[] = [
      {
        name: "primary",
        apiUrl: "https://primary.test",
        apiKey: "pk",
        priority: 0,
        enabled: false, // disabled
      },
      {
        name: "anthropic",
        apiUrl: "https://anthropic.test",
        apiKey: "ak",
        authStyle: "bearer",
        priority: 1,
        modelMap: { "gpt-4o": "claude-sonnet-4-5" },
      },
    ];

    let capturedBody: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          id: "resp",
          model: "claude-sonnet-4-5",
          choices: [
            {
              message: { role: "assistant", content: "mapped model" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      };
    }) as any;

    const client = createMultiProviderInference({
      providers,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    await client.chat([{ role: "user", content: "Hello" }]);
    expect(capturedBody.model).toBe("claude-sonnet-4-5");
  });

  it("handles low compute mode", () => {
    globalThis.fetch = mockFetchSuccess() as any;

    const client = createMultiProviderInference({
      providers: testProviders,
      defaultModel: "gpt-4o",
      maxTokens: 8192,
      lowComputeModel: "gpt-4o-mini",
    });

    expect(client.getDefaultModel()).toBe("gpt-4o");
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("gpt-4o-mini");
    client.setLowComputeMode(false);
    expect(client.getDefaultModel()).toBe("gpt-4o");
  });

  it("throws if no providers configured", () => {
    expect(() => {
      createMultiProviderInference({
        providers: [],
        defaultModel: "gpt-4o",
        maxTokens: 4096,
      });
    }).toThrow("No inference providers configured");
  });

  it("filters disabled providers", () => {
    globalThis.fetch = mockFetchSuccess() as any;

    const providers: InferenceProvider[] = [
      { name: "a", apiUrl: "https://a.test", apiKey: "k", priority: 0, enabled: false },
      { name: "b", apiUrl: "https://b.test", apiKey: "k", priority: 1 },
    ];

    const client = createMultiProviderInference({
      providers,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    const health = client.getProviderHealth();
    expect(health.length).toBe(1);
    expect(health[0].name).toBe("b");
  });

  it("sends bearer auth when configured", async () => {
    let capturedHeaders: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return {
        ok: true,
        json: async () => ({
          id: "resp",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      };
    }) as any;

    const providers: InferenceProvider[] = [
      {
        name: "bearer-test",
        apiUrl: "https://test.api",
        apiKey: "sk-12345",
        authStyle: "bearer",
        priority: 0,
      },
    ];

    const client = createMultiProviderInference({
      providers,
      defaultModel: "gpt-4o",
      maxTokens: 4096,
    });

    await client.chat([{ role: "user", content: "Hello" }]);
    expect(capturedHeaders.Authorization).toBe("Bearer sk-12345");
  });
});

describe("buildProviderList", () => {
  it("always includes Conway as primary", () => {
    const providers = buildProviderList({
      conwayApiUrl: "https://api.conway.tech",
      conwayApiKey: "ck-test",
    });

    expect(providers.length).toBe(1);
    expect(providers[0].name).toBe("conway");
    expect(providers[0].priority).toBe(0);
  });

  it("adds fallback providers from config", () => {
    const providers = buildProviderList({
      conwayApiUrl: "https://api.conway.tech",
      conwayApiKey: "ck-test",
      inferenceProviders: [
        {
          name: "openai-direct",
          apiUrl: "https://api.openai.com",
          apiKey: "sk-test",
          authStyle: "bearer",
          priority: 1,
        },
      ],
    });

    expect(providers.length).toBe(2);
    expect(providers[0].name).toBe("conway");
    expect(providers[1].name).toBe("openai-direct");
  });

  it("ensures fallback providers have priority >= 1", () => {
    const providers = buildProviderList({
      conwayApiUrl: "https://api.conway.tech",
      conwayApiKey: "ck-test",
      inferenceProviders: [
        {
          name: "sneaky",
          apiUrl: "https://test.api",
          apiKey: "k",
          priority: 0, // tries to be primary
          authStyle: "bearer",
        },
      ],
    });

    // Should be bumped to at least 1
    expect(providers[1].priority).toBeGreaterThanOrEqual(1);
  });
});
