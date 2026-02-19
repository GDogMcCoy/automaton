/**
 * Config Module Tests
 *
 * Tests for loading, saving, validating, resolving paths, and creating
 * automaton configurations. Filesystem operations are mocked to avoid
 * side effects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────

// Mock fs with an in-memory store
vi.mock("fs", () => {
  const store: Record<string, { content: string; mode: number }> = {};
  const dirs: Set<string> = new Set();

  return {
    default: {
      existsSync: vi.fn((filePath: string) => {
        return filePath in store || dirs.has(filePath);
      }),
      readFileSync: vi.fn((filePath: string) => {
        if (filePath in store) return store[filePath].content;
        throw new Error(`ENOENT: no such file ${filePath}`);
      }),
      writeFileSync: vi.fn(
        (filePath: string, content: string, opts?: { mode?: number }) => {
          store[filePath] = { content, mode: opts?.mode ?? 0o644 };
        },
      ),
      mkdirSync: vi.fn(
        (
          dirPath: string,
          _opts?: { recursive?: boolean; mode?: number },
        ) => {
          dirs.add(dirPath);
        },
      ),
      __store: store,
      __dirs: dirs,
    },
  };
});

// Mock getAutomatonDir to return a deterministic path
vi.mock("../identity/wallet.js", () => ({
  getAutomatonDir: vi.fn(() => "/home/testuser/.automaton"),
}));

// Mock loadApiKeyFromConfig
vi.mock("../identity/provision.js", () => ({
  loadApiKeyFromConfig: vi.fn(() => "fallback-api-key"),
}));

import fs from "fs";
import {
  loadConfig,
  saveConfig,
  validateConfig,
  resolvePath,
  createConfig,
  getConfigPath,
} from "../config.js";
import { createTestConfig } from "./mocks.js";
import type { AutomatonConfig } from "../types.js";

// Access mock internals
const mockStore = (fs as any).__store as Record<
  string,
  { content: string; mode: number }
>;
const mockDirs = (fs as any).__dirs as Set<string>;

// ─── Tests ──────────────────────────────────────────────────────

describe("Config", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockStore)) {
      delete mockStore[key];
    }
    mockDirs.clear();
    vi.clearAllMocks();
  });

  // ─── getConfigPath ──────────────────────────────────────────

  describe("getConfigPath", () => {
    it("returns a path ending with automaton.json", () => {
      const configPath = getConfigPath();
      expect(configPath).toMatch(/automaton\.json$/);
    });

    it("is inside the automaton directory", () => {
      const configPath = getConfigPath();
      expect(configPath).toContain(".automaton");
    });
  });

  // ─── loadConfig ─────────────────────────────────────────────

  describe("loadConfig", () => {
    it("returns null when no config file exists", () => {
      const config = loadConfig();
      expect(config).toBeNull();
    });

    it("returns a config merged with defaults when file exists", () => {
      const configPath = getConfigPath();
      const partial = {
        name: "my-automaton",
        conwayApiKey: "my-key",
        genesisPrompt: "Be helpful.",
        creatorAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        registeredWithConway: true,
        sandboxId: "sandbox-1",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      };
      mockStore[configPath] = {
        content: JSON.stringify(partial),
        mode: 0o600,
      };

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config!.name).toBe("my-automaton");
      expect(config!.conwayApiKey).toBe("my-key");
      // Defaults should be merged in
      expect(config!.maxTokensPerTurn).toBe(4096);
      expect(config!.selfModMode).toBe("disabled");
    });

    it("falls back to loadApiKeyFromConfig when no apiKey in file", () => {
      const configPath = getConfigPath();
      const partial = {
        name: "my-automaton",
        genesisPrompt: "Be helpful.",
      };
      mockStore[configPath] = {
        content: JSON.stringify(partial),
        mode: 0o600,
      };

      const config = loadConfig();
      expect(config).not.toBeNull();
      expect(config!.conwayApiKey).toBe("fallback-api-key");
    });

    it("returns null when config file contains invalid JSON", () => {
      const configPath = getConfigPath();
      mockStore[configPath] = {
        content: "not-valid-json{{{",
        mode: 0o600,
      };

      const config = loadConfig();
      expect(config).toBeNull();
    });
  });

  // ─── saveConfig ─────────────────────────────────────────────

  describe("saveConfig", () => {
    it("writes config with correct permissions (0o600)", () => {
      const config = createTestConfig();
      saveConfig(config);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const opts = writeCall[2] as { mode?: number } | undefined;
      expect(opts?.mode).toBe(0o600);
    });

    it("creates the automaton directory if it does not exist", () => {
      const config = createTestConfig();
      saveConfig(config);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(".automaton"),
        expect.objectContaining({ recursive: true, mode: 0o700 }),
      );
    });

    it("writes valid JSON content", () => {
      const config = createTestConfig({ name: "serialization-test" });
      saveConfig(config);

      const configPath = getConfigPath();
      expect(configPath in mockStore).toBe(true);
      const parsed = JSON.parse(mockStore[configPath].content);
      expect(parsed.name).toBe("serialization-test");
    });

    it("does not recreate directory when it already exists", () => {
      mockDirs.add("/home/testuser/.automaton");

      const config = createTestConfig();
      saveConfig(config);

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  // ─── validateConfig ─────────────────────────────────────────

  describe("validateConfig", () => {
    it("returns empty array for valid config", () => {
      const config = createTestConfig();
      const issues = validateConfig(config);
      expect(issues).toEqual([]);
    });

    it("catches missing name", () => {
      const config = createTestConfig({ name: "" });
      const issues = validateConfig(config);
      expect(issues).toContain("name is required");
    });

    it("catches whitespace-only name", () => {
      const config = createTestConfig({ name: "   " });
      const issues = validateConfig(config);
      expect(issues).toContain("name is required");
    });

    it("catches invalid selfModMode", () => {
      const config = createTestConfig({
        selfModMode: "yolo" as any,
      });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("selfModMode"))).toBe(true);
    });

    it("catches maxTokensPerTurn below minimum (256)", () => {
      const config = createTestConfig({ maxTokensPerTurn: 100 });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("maxTokensPerTurn"))).toBe(true);
    });

    it("catches maxTokensPerTurn above maximum (128000)", () => {
      const config = createTestConfig({ maxTokensPerTurn: 200000 });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("maxTokensPerTurn"))).toBe(true);
    });

    it("catches negative maxChildren", () => {
      const config = createTestConfig({ maxChildren: -1 });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("maxChildren"))).toBe(true);
    });

    it("catches maxChildren above 20", () => {
      const config = createTestConfig({ maxChildren: 25 });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("maxChildren"))).toBe(true);
    });

    it("catches invalid conwayApiUrl", () => {
      const config = createTestConfig({ conwayApiUrl: "not-a-url" });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("conwayApiUrl"))).toBe(true);
    });

    it("catches missing conwayApiKey", () => {
      const config = createTestConfig({ conwayApiKey: "" });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("conwayApiKey"))).toBe(true);
    });

    it("catches negative maxDailySpendingUsdc", () => {
      const config = createTestConfig({ maxDailySpendingUsdc: -5 });
      const issues = validateConfig(config);
      expect(issues.some((i) => i.includes("maxDailySpendingUsdc"))).toBe(
        true,
      );
    });

    it("returns multiple issues when config has many problems", () => {
      const config = createTestConfig({
        name: "",
        conwayApiKey: "",
        maxTokensPerTurn: 1,
        maxChildren: -1,
        selfModMode: "invalid" as any,
      });
      const issues = validateConfig(config);
      expect(issues.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── resolvePath ────────────────────────────────────────────

  describe("resolvePath", () => {
    it("resolves ~ to HOME", () => {
      const originalHome = process.env.HOME;
      process.env.HOME = "/home/testuser";

      const resolved = resolvePath("~/Documents/file.txt");
      expect(resolved).toBe("/home/testuser/Documents/file.txt");

      process.env.HOME = originalHome;
    });

    it("returns absolute paths unchanged", () => {
      const resolved = resolvePath("/etc/config.json");
      expect(resolved).toBe("/etc/config.json");
    });

    it("returns relative paths unchanged", () => {
      const resolved = resolvePath("config/file.json");
      expect(resolved).toBe("config/file.json");
    });

    it("handles ~ alone (home directory root)", () => {
      const originalHome = process.env.HOME;
      process.env.HOME = "/home/testuser";

      const resolved = resolvePath("~");
      expect(resolved).toBe("/home/testuser");

      process.env.HOME = originalHome;
    });

    it("falls back to /root when HOME is unset", () => {
      const originalHome = process.env.HOME;
      delete process.env.HOME;

      const resolved = resolvePath("~/data");
      expect(resolved).toBe("/root/data");

      process.env.HOME = originalHome;
    });
  });

  // ─── createConfig ──────────────────────────────────────────

  describe("createConfig", () => {
    it("creates config with all required fields", () => {
      const config = createConfig({
        name: "new-automaton",
        genesisPrompt: "You are a helpful assistant.",
        creatorAddress:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
        registeredWithConway: true,
        sandboxId: "sandbox-123",
        walletAddress:
          "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
        apiKey: "test-api-key-123",
      });

      expect(config.name).toBe("new-automaton");
      expect(config.genesisPrompt).toBe("You are a helpful assistant.");
      expect(config.creatorAddress).toBe(
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );
      expect(config.registeredWithConway).toBe(true);
      expect(config.sandboxId).toBe("sandbox-123");
      expect(config.walletAddress).toBe(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
      expect(config.conwayApiKey).toBe("test-api-key-123");
    });

    it("uses default values for unset fields", () => {
      const config = createConfig({
        name: "defaults-test",
        genesisPrompt: "Test.",
        creatorAddress:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
        registeredWithConway: false,
        sandboxId: "sandbox-456",
        walletAddress:
          "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
        apiKey: "key",
      });

      expect(config.conwayApiUrl).toBe("https://api.conway.tech");
      expect(config.inferenceModel).toBe("gpt-4o");
      expect(config.maxTokensPerTurn).toBe(4096);
      expect(config.selfModMode).toBe("disabled");
      expect(config.replicationEnabled).toBe(false);
      expect(config.maxChildren).toBe(3);
      expect(config.version).toBe("0.1.0");
    });

    it("includes optional creatorMessage when provided", () => {
      const config = createConfig({
        name: "msg-test",
        genesisPrompt: "Test.",
        creatorMessage: "Welcome to the world.",
        creatorAddress:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
        registeredWithConway: true,
        sandboxId: "sandbox-789",
        walletAddress:
          "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
        apiKey: "key",
      });

      expect(config.creatorMessage).toBe("Welcome to the world.");
    });

    it("includes optional parentAddress when provided", () => {
      const config = createConfig({
        name: "child-automaton",
        genesisPrompt: "I am a child.",
        creatorAddress:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
        registeredWithConway: true,
        sandboxId: "sandbox-child",
        walletAddress:
          "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
        apiKey: "key",
        parentAddress:
          "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
      });

      expect(config.parentAddress).toBe(
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      );
    });
  });
});
