/**
 * Self-Hosted Conway Client
 *
 * Drop-in replacement for the Conway API client that runs entirely
 * on local/Docker compute. No Conway dashboard dependency.
 *
 * What this replaces:
 * - exec()          → ComputeProvider.exec()
 * - writeFile()     → ComputeProvider.writeFile()
 * - readFile()      → ComputeProvider.readFile()
 * - exposePort()    → ComputeProvider.exposePort() or no-op
 * - removePort()    → ComputeProvider.removePort() or no-op
 * - createSandbox() → Docker container creation
 * - deleteSandbox() → Docker container removal
 * - listSandboxes() → Docker container listing
 *
 * What this replaces differently:
 * - getCreditsBalance()  → On-chain USDC balance (the real money)
 * - transferCredits()    → USDC transfer via x402
 * - getCreditsPricing()  → Static pricing table
 *
 * What is not supported (returns stubs):
 * - searchDomains()      → Use external registrar API
 * - registerDomain()     → Use external registrar API
 * - DNS operations       → Use external DNS API (Cloudflare, etc.)
 */

import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import type { ComputeProvider } from "../compute/provider.js";
import { createDockerComputeProvider } from "../compute/docker.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("self-hosted");

export interface SelfHostedClientOptions {
  /** Primary compute provider (local or docker) */
  compute: ComputeProvider;
  /** Wallet address for USDC balance lookups */
  walletAddress: string;
  /** Function to get USDC balance (injected to avoid circular deps) */
  getUsdcBalance?: (address: string) => Promise<number>;
  /** Docker image for sandbox creation (if creating child sandboxes) */
  sandboxImage?: string;
  /** Static model list (self-hosted knows what it has) */
  availableModels?: ModelInfo[];
}

interface ManagedSandbox {
  id: string;
  provider: ComputeProvider;
  info: SandboxInfo;
}

/**
 * Create a self-hosted ConwayClient that doesn't depend on Conway API.
 *
 * This is the freedom module: the automaton runs on its own compute,
 * pays for inference directly, and tracks costs via on-chain USDC.
 */
export function createSelfHostedClient(
  options: SelfHostedClientOptions,
): ConwayClient & { dispose(): Promise<void> } {
  const {
    compute,
    walletAddress,
    getUsdcBalance: getBalance,
    sandboxImage,
    availableModels,
  } = options;

  // Track child sandboxes (Docker containers managed by this client)
  const sandboxes = new Map<string, ManagedSandbox>();
  let sandboxCounter = 0;

  // ─── Sandbox Operations (own sandbox) ────────────────────────

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    return compute.exec(command, timeout);
  };

  const writeFile = async (
    path: string,
    content: string,
  ): Promise<void> => {
    return compute.writeFile(path, content);
  };

  const readFile = async (filePath: string): Promise<string> => {
    return compute.readFile(filePath);
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    if (compute.exposePort) {
      return compute.exposePort(port);
    }

    // In self-hosted mode, ports are already local
    // Return localhost URL (operator can set up reverse proxy)
    return {
      port,
      publicUrl: `http://localhost:${port}`,
      sandboxId: "self-hosted",
    };
  };

  const removePort = async (port: number): Promise<void> => {
    if (compute.removePort) {
      return compute.removePort(port);
    }
    // No-op in self-hosted mode — port is just a local port
  };

  // ─── Sandbox Management ──────────────────────────────────────

  const createSandbox = async (
    opts: CreateSandboxOptions,
  ): Promise<SandboxInfo> => {
    if (!sandboxImage) {
      throw new Error(
        "Cannot create sandboxes in self-hosted mode without sandboxImage config",
      );
    }

    sandboxCounter++;
    const id = `sandbox-${sandboxCounter}-${Date.now()}`;
    const name = opts.name || `automaton-child-${sandboxCounter}`;

    const provider = createDockerComputeProvider({
      image: sandboxImage,
      containerName: name,
      memoryMb: opts.memoryMb || 512,
      cpuLimit: String((opts.vcpu || 1) * 1.0),
      workDir: "/workspace",
      autoRemove: true,
    });

    // Health check to ensure container starts
    const healthy = await provider.healthCheck();
    if (!healthy) {
      throw new Error(`Failed to start sandbox container: ${name}`);
    }

    const info: SandboxInfo = {
      id,
      status: "running",
      region: "self-hosted",
      vcpu: opts.vcpu || 1,
      memoryMb: opts.memoryMb || 512,
      diskGb: opts.diskGb || 5,
      createdAt: new Date().toISOString(),
    };

    sandboxes.set(id, { id, provider, info });

    log.info("Sandbox created", { id, name, image: sandboxImage });
    return info;
  };

  const deleteSandbox = async (sandboxId: string): Promise<void> => {
    const sandbox = sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }

    if (sandbox.provider.dispose) {
      await sandbox.provider.dispose();
    }

    sandboxes.delete(sandboxId);
    log.info("Sandbox deleted", { id: sandboxId });
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    return Array.from(sandboxes.values()).map((s) => s.info);
  };

  // ─── Credits / Financial ──────────────────────────────────────
  //
  // In self-hosted mode, "credits" are denominated in USDC cents.
  // The automaton's on-chain USDC balance IS its credit balance.
  // No Conway middleman taking a cut.

  const getCreditsBalance = async (): Promise<number> => {
    if (!getBalance) {
      // If no balance function provided, return a high value
      // (self-hosted doesn't need credits to think)
      return 10000; // $100 equivalent — keeps the agent in "normal" tier
    }

    try {
      const usdcBalance = await getBalance(walletAddress);
      // Convert USDC to cents
      return Math.floor(usdcBalance * 100);
    } catch (err: any) {
      log.warn("Failed to check USDC balance, returning default", {
        error: err.message,
      });
      return 10000; // Default to healthy
    }
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    // Self-hosted pricing is whatever the operator's infrastructure costs
    return [
      {
        name: "self-hosted",
        vcpu: 1,
        memoryMb: 512,
        diskGb: 10,
        monthlyCents: 0, // Your own hardware
      },
      {
        name: "self-hosted-pro",
        vcpu: 4,
        memoryMb: 4096,
        diskGb: 100,
        monthlyCents: 0,
      },
    ];
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<CreditTransferResult> => {
    // In self-hosted mode, "transfer credits" is an informational stub.
    // Real USDC transfers happen through the x402 module or direct
    // on-chain transactions — not through a Conway API proxy.
    log.info("Credit transfer requested (self-hosted stub)", {
      to: toAddress,
      amountCents,
      note,
    });

    return {
      transferId: `self-hosted-${Date.now()}`,
      status: "requires_onchain",
      toAddress,
      amountCents,
    };
  };

  // ─── Domains (stubs — use external registrar) ─────────────────

  const searchDomains = async (
    _query: string,
    _tlds?: string,
  ): Promise<DomainSearchResult[]> => {
    log.warn(
      "Domain search not available in self-hosted mode. Use an external registrar.",
    );
    return [];
  };

  const registerDomain = async (
    _domain: string,
    _years?: number,
  ): Promise<DomainRegistration> => {
    throw new Error(
      "Domain registration not available in self-hosted mode. Use an external registrar API.",
    );
  };

  const listDnsRecords = async (_domain: string): Promise<DnsRecord[]> => {
    log.warn(
      "DNS operations not available in self-hosted mode. Use Cloudflare API or similar.",
    );
    return [];
  };

  const addDnsRecord = async (
    _domain: string,
    _type: string,
    _host: string,
    _value: string,
    _ttl?: number,
  ): Promise<DnsRecord> => {
    throw new Error(
      "DNS operations not available in self-hosted mode. Use Cloudflare API or similar.",
    );
  };

  const deleteDnsRecord = async (
    _domain: string,
    _recordId: string,
  ): Promise<void> => {
    throw new Error(
      "DNS operations not available in self-hosted mode. Use Cloudflare API or similar.",
    );
  };

  // ─── Model Discovery ─────────────────────────────────────────

  const listModels = async (): Promise<ModelInfo[]> => {
    if (availableModels && availableModels.length > 0) {
      return availableModels;
    }

    // Default model list for self-hosted (common OpenAI-compatible models)
    return [
      {
        id: "gpt-4o",
        provider: "openai",
        pricing: { inputPerMillion: 250, outputPerMillion: 1000 },
      },
      {
        id: "gpt-4o-mini",
        provider: "openai",
        pricing: { inputPerMillion: 15, outputPerMillion: 60 },
      },
      {
        id: "claude-sonnet-4-5",
        provider: "anthropic",
        pricing: { inputPerMillion: 300, outputPerMillion: 1500 },
      },
    ];
  };

  // ─── Cleanup ─────────────────────────────────────────────────

  const dispose = async (): Promise<void> => {
    // Clean up all managed sandboxes
    for (const [id, sandbox] of sandboxes) {
      try {
        if (sandbox.provider.dispose) {
          await sandbox.provider.dispose();
        }
      } catch (err: any) {
        log.warn("Failed to dispose sandbox", { id, error: err.message });
      }
    }
    sandboxes.clear();

    // Clean up primary compute provider
    if (compute.dispose) {
      await compute.dispose();
    }
  };

  // ─── Build Client ────────────────────────────────────────────

  const client = {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    dispose,
    getCredentials: () => ({
      apiUrl: "self-hosted",
      apiKey: "self-hosted",
    }),
  } as ConwayClient & { dispose(): Promise<void> };

  // Legacy accessors for backward compatibility with spawn module
  Object.defineProperty(client, "__apiUrl", {
    get: () => "self-hosted",
    enumerable: false,
  });
  Object.defineProperty(client, "__apiKey", {
    get: () => "self-hosted",
    enumerable: false,
  });

  return client;
}
