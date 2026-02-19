/**
 * End-to-End Sovereign Mode Test
 *
 * Tests the full sovereignty pipeline with real on-chain USDC:
 * 1. Wallet initialization and address derivation
 * 2. USDC balance check on Base mainnet via RPC
 * 3. Self-hosted compute provider (local)
 * 4. Self-hosted ConwayClient (no Conway API)
 * 5. Sovereign survival tier with real USDC balance
 * 6. Credit balance derived from on-chain USDC
 *
 * This test hits the real Base mainnet RPC to read USDC balance.
 * It does NOT spend any funds — read-only chain queries.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import fs from "node:fs";
import path from "node:path";

// Modules under test
import { getUsdcBalance, getUsdcBalanceDetailed } from "../conway/x402.js";
import { getSovereignSurvivalTier } from "../conway/credits.js";
import { createLocalComputeProvider } from "../compute/local.js";
import { createSelfHostedClient } from "../conway/self-hosted.js";

// ─── Wallet Loading ──────────────────────────────────────────────

const WALLET_PATH = path.join(
  process.env.HOME || "/root",
  ".automaton",
  "wallet.json",
);

let walletAddress: `0x${string}`;

beforeAll(() => {
  if (!fs.existsSync(WALLET_PATH)) {
    console.warn("No wallet found at", WALLET_PATH, "— skipping E2E tests");
    return;
  }
  const data = JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"));
  const account = privateKeyToAccount(data.privateKey as `0x${string}`);
  walletAddress = account.address;
  console.log("E2E wallet address:", walletAddress);
});

// ─── Tests ───────────────────────────────────────────────────────

describe("E2E: Sovereign Mode", () => {
  describe("Wallet", () => {
    it("wallet file exists and has correct permissions", () => {
      expect(fs.existsSync(WALLET_PATH)).toBe(true);
      const stat = fs.statSync(WALLET_PATH);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("wallet address is a valid checksummed Ethereum address", () => {
      expect(walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe("On-Chain USDC Balance (Base Mainnet)", () => {
    it("getUsdcBalanceDetailed returns structured result", async () => {
      const result = await getUsdcBalanceDetailed(walletAddress);
      console.log("USDC balance result:", JSON.stringify(result));

      expect(result).toHaveProperty("balance");
      expect(result).toHaveProperty("network", "eip155:8453");
      expect(result).toHaveProperty("ok");

      if (result.ok) {
        expect(typeof result.balance).toBe("number");
        expect(result.balance).toBeGreaterThanOrEqual(0);
      } else {
        // RPC might be unreachable in some environments
        console.warn("USDC balance check failed:", result.error);
      }
    }, 30_000);

    it("getUsdcBalance returns a number", async () => {
      const balance = await getUsdcBalance(walletAddress);
      console.log("USDC balance:", balance);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    }, 30_000);

    it("reports correct balance on Base mainnet", async () => {
      // Direct viem call to verify our wrapper matches
      const client = createPublicClient({
        chain: base,
        transport: http(),
      });

      const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

      let rawBalance: bigint;
      try {
        rawBalance = await client.readContract({
          address: USDC_ADDRESS as `0x${string}`,
          abi: [
            {
              inputs: [{ name: "account", type: "address" }],
              name: "balanceOf",
              outputs: [{ name: "", type: "uint256" }],
              stateMutability: "view",
              type: "function",
            },
          ] as const,
          functionName: "balanceOf",
          args: [walletAddress],
        });
      } catch (err: any) {
        // RPC may be unreachable in sandboxed environments
        if (err.message?.includes("fetch failed") || err.message?.includes("EAI_AGAIN")) {
          console.warn("Base RPC unreachable — skipping direct comparison");
          return;
        }
        throw err;
      }

      const expectedBalance = Number(rawBalance) / 1_000_000;
      const ourBalance = await getUsdcBalance(walletAddress);

      console.log("Direct RPC balance:", expectedBalance, "USDC");
      console.log("Our wrapper balance:", ourBalance, "USDC");

      expect(ourBalance).toBe(expectedBalance);
    }, 30_000);
  });

  describe("Sovereign Survival Tier", () => {
    it("computes tier from real USDC balance", async () => {
      const usdcBalance = await getUsdcBalance(walletAddress);
      console.log("USDC for tier check:", usdcBalance);

      // With 0 Conway credits but real USDC
      const tier = getSovereignSurvivalTier(0, usdcBalance);
      console.log("Sovereign tier (0 credits +", usdcBalance, "USDC):", tier);

      if (usdcBalance > 0.625) {
        // With USDC > ~$0.63, after 20% haircut, effective > 50 cents = normal
        expect(tier).toBe("normal");
      } else if (usdcBalance > 0.125) {
        expect(["normal", "low_compute"]).toContain(tier);
      } else if (usdcBalance > 0) {
        expect(["normal", "low_compute", "critical"]).toContain(tier);
      } else {
        expect(tier).toBe("dead");
      }
    }, 30_000);
  });

  describe("Self-Hosted Client with Real USDC", () => {
    it("local compute provider passes health check", async () => {
      const compute = createLocalComputeProvider();
      const healthy = await compute.healthCheck();
      expect(healthy).toBe(true);
    });

    it("self-hosted client reads USDC balance as credits", async () => {
      const compute = createLocalComputeProvider();
      const client = createSelfHostedClient({
        compute,
        walletAddress,
        getUsdcBalance: (addr: string) =>
          getUsdcBalance(addr as `0x${string}`),
      });

      const credits = await client.getCreditsBalance();
      const usdcBalance = await getUsdcBalance(walletAddress);

      console.log("Self-hosted credits:", credits, "cents");
      console.log("Expected (USDC * 100):", Math.floor(usdcBalance * 100));

      // Credits should equal USDC balance in cents
      expect(credits).toBe(Math.floor(usdcBalance * 100));
    }, 30_000);

    it("self-hosted client can exec commands locally", async () => {
      const compute = createLocalComputeProvider();
      const client = createSelfHostedClient({
        compute,
        walletAddress,
      });

      const result = await client.exec("echo sovereign");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("sovereign");
    });

    it("self-hosted client can read and write files", async () => {
      const compute = createLocalComputeProvider();
      const client = createSelfHostedClient({
        compute,
        walletAddress,
      });

      const testPath = "/tmp/automaton-e2e-test.txt";
      await client.writeFile(testPath, "sovereignty test");
      const content = await client.readFile(testPath);
      expect(content).toBe("sovereignty test");

      // Cleanup
      await client.exec(`rm -f ${testPath}`);
    });

    it("full sovereignty pipeline: USDC -> credits -> tier -> alive", async () => {
      const compute = createLocalComputeProvider();
      const client = createSelfHostedClient({
        compute,
        walletAddress,
        getUsdcBalance: (addr: string) =>
          getUsdcBalance(addr as `0x${string}`),
      });

      // Step 1: Check credits (derived from USDC)
      const credits = await client.getCreditsBalance();
      console.log("Step 1 - Credits from USDC:", credits, "cents");

      // Step 2: Compute survival tier
      const usdcBalance = await getUsdcBalance(walletAddress);
      const tier = getSovereignSurvivalTier(0, usdcBalance);
      console.log("Step 2 - Survival tier:", tier);

      // Step 3: Verify the automaton would be alive
      // (if funded with $50 USDC, tier should be "normal")
      if (usdcBalance >= 1.0) {
        expect(tier).toBe("normal");
        expect(credits).toBeGreaterThan(50);
        console.log(
          "Step 3 - SOVEREIGN AND ALIVE:",
          `${usdcBalance} USDC on-chain,`,
          `${credits} cents credit equivalent,`,
          `tier: ${tier}`,
        );
      } else {
        console.log(
          "Step 3 - Balance:",
          `${usdcBalance} USDC (waiting for funding)`,
        );
      }

      // Step 4: Verify compute works independently
      const execResult = await client.exec("node --version");
      expect(execResult.exitCode).toBe(0);
      console.log("Step 4 - Local compute:", execResult.stdout.trim());

      // Step 5: List models (self-hosted returns static list)
      const models = await client.listModels();
      expect(models.length).toBeGreaterThan(0);
      console.log(
        "Step 5 - Available models:",
        models.map((m) => m.id).join(", "),
      );

      console.log("\n=== SOVEREIGNTY PIPELINE COMPLETE ===");
      console.log("No Conway API needed. No Conway credits needed.");
      console.log(
        `Agent has ${usdcBalance} USDC on Base, compute is local, inference via direct API keys.`,
      );
    }, 30_000);
  });
});
