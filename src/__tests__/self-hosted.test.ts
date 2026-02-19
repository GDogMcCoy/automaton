/**
 * Tests for the self-hosted Conway client replacement.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createSelfHostedClient } from "../conway/self-hosted.js";
import type { ComputeProvider } from "../compute/provider.js";
import type { ExecResult } from "../types.js";

function createMockCompute(overrides?: Partial<ComputeProvider>): ComputeProvider {
  return {
    name: "mock",
    exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 } as ExecResult),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("file content"),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("Self-Hosted Conway Client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates exec to compute provider", async () => {
    const compute = createMockCompute();
    const client = createSelfHostedClient({
      compute,
      walletAddress: "0x1234",
    });

    const result = await client.exec("echo hello", 5000);
    expect(result.stdout).toBe("ok");
    expect(compute.exec).toHaveBeenCalledWith("echo hello", 5000);
  });

  it("delegates writeFile to compute provider", async () => {
    const compute = createMockCompute();
    const client = createSelfHostedClient({
      compute,
      walletAddress: "0x1234",
    });

    await client.writeFile("/test.txt", "content");
    expect(compute.writeFile).toHaveBeenCalledWith("/test.txt", "content");
  });

  it("delegates readFile to compute provider", async () => {
    const compute = createMockCompute();
    const client = createSelfHostedClient({
      compute,
      walletAddress: "0x1234",
    });

    const content = await client.readFile("/test.txt");
    expect(content).toBe("file content");
    expect(compute.readFile).toHaveBeenCalledWith("/test.txt");
  });

  it("returns localhost URL for exposePort in self-hosted mode", async () => {
    const compute = createMockCompute();
    const client = createSelfHostedClient({
      compute,
      walletAddress: "0x1234",
    });

    const portInfo = await client.exposePort(3000);
    expect(portInfo.port).toBe(3000);
    expect(portInfo.publicUrl).toBe("http://localhost:3000");
    expect(portInfo.sandboxId).toBe("self-hosted");
  });

  it("removePort is a no-op in self-hosted mode", async () => {
    const compute = createMockCompute();
    const client = createSelfHostedClient({
      compute,
      walletAddress: "0x1234",
    });

    // Should not throw
    await client.removePort(3000);
  });

  it("delegates exposePort to compute provider if available", async () => {
    const mockExposePort = vi.fn().mockResolvedValue({
      port: 3000,
      publicUrl: "https://tunnel.example.com",
      sandboxId: "tunneled",
    });
    const compute = createMockCompute({ exposePort: mockExposePort });
    const client = createSelfHostedClient({
      compute,
      walletAddress: "0x1234",
    });

    const portInfo = await client.exposePort(3000);
    expect(portInfo.publicUrl).toBe("https://tunnel.example.com");
    expect(mockExposePort).toHaveBeenCalledWith(3000);
  });

  describe("credits / financial", () => {
    it("returns USDC balance as credits when balance function provided", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
        getUsdcBalance: vi.fn().mockResolvedValue(5.5),
      });

      const balance = await client.getCreditsBalance();
      expect(balance).toBe(550); // 5.5 USDC = 550 cents
    });

    it("returns high default balance when no balance function", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const balance = await client.getCreditsBalance();
      expect(balance).toBe(10000); // $100 equivalent
    });

    it("returns default on balance check failure", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
        getUsdcBalance: vi.fn().mockRejectedValue(new Error("network error")),
      });

      const balance = await client.getCreditsBalance();
      expect(balance).toBe(10000);
    });

    it("returns self-hosted pricing", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const pricing = await client.getCreditsPricing();
      expect(pricing.length).toBeGreaterThan(0);
      expect(pricing[0].name).toBe("self-hosted");
      expect(pricing[0].monthlyCents).toBe(0);
    });

    it("transferCredits returns informational stub", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const result = await client.transferCredits("0x5678", 100, "test");
      expect(result.status).toBe("requires_onchain");
      expect(result.toAddress).toBe("0x5678");
      expect(result.amountCents).toBe(100);
    });
  });

  describe("sandboxes", () => {
    it("throws when creating sandbox without sandboxImage", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      await expect(client.createSandbox({})).rejects.toThrow("sandboxImage");
    });

    it("returns empty sandbox list initially", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const sandboxes = await client.listSandboxes();
      expect(sandboxes).toEqual([]);
    });
  });

  describe("domains (stubs)", () => {
    it("searchDomains returns empty array", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const results = await client.searchDomains("example.com");
      expect(results).toEqual([]);
    });

    it("registerDomain throws with guidance", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      await expect(client.registerDomain("example.com")).rejects.toThrow(
        "external registrar",
      );
    });

    it("listDnsRecords returns empty array", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const records = await client.listDnsRecords("example.com");
      expect(records).toEqual([]);
    });

    it("addDnsRecord throws with guidance", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      await expect(
        client.addDnsRecord("example.com", "A", "@", "1.2.3.4"),
      ).rejects.toThrow("Cloudflare");
    });

    it("deleteDnsRecord throws with guidance", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      await expect(
        client.deleteDnsRecord("example.com", "rec-1"),
      ).rejects.toThrow("Cloudflare");
    });
  });

  describe("models", () => {
    it("returns default model list", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const models = await client.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.find((m) => m.id === "gpt-4o")).toBeDefined();
    });

    it("returns custom model list when configured", async () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
        availableModels: [
          { id: "local-llama", provider: "ollama", pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
        ],
      });

      const models = await client.listModels();
      expect(models.length).toBe(1);
      expect(models[0].id).toBe("local-llama");
    });
  });

  describe("disposal", () => {
    it("disposes compute provider on cleanup", async () => {
      const disposeFn = vi.fn().mockResolvedValue(undefined);
      const compute = createMockCompute({ dispose: disposeFn });
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      await (client as any).dispose();
      expect(disposeFn).toHaveBeenCalledOnce();
    });
  });

  describe("backward compatibility", () => {
    it("has getCredentials method", () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      }) as any;

      expect(client.getCredentials()).toEqual({
        apiUrl: "self-hosted",
        apiKey: "self-hosted",
      });
    });

    it("has __apiUrl and __apiKey legacy accessors", () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      }) as any;

      expect(client.__apiUrl).toBe("self-hosted");
      expect(client.__apiKey).toBe("self-hosted");
    });

    it("legacy accessors are not enumerable", () => {
      const compute = createMockCompute();
      const client = createSelfHostedClient({
        compute,
        walletAddress: "0x1234",
      });

      const keys = Object.keys(client);
      expect(keys).not.toContain("__apiUrl");
      expect(keys).not.toContain("__apiKey");
    });
  });
});
