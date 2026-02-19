/**
 * Wallet Module Tests
 *
 * Tests for wallet creation, loading, and permission verification.
 * Filesystem operations are mocked to avoid side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

// Mock fs before importing the wallet module
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
      statSync: vi.fn((filePath: string) => {
        if (filePath in store) {
          return { mode: store[filePath].mode | 0o100000 }; // S_IFREG
        }
        throw new Error(`ENOENT: no such file ${filePath}`);
      }),
      chmodSync: vi.fn((filePath: string, mode: number) => {
        if (filePath in store) {
          store[filePath].mode = mode;
        }
      }),
      // Expose store for test manipulation
      __store: store,
      __dirs: dirs,
    },
  };
});

// Mock viem/accounts
vi.mock("viem/accounts", () => ({
  generatePrivateKey: vi.fn(
    () =>
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`,
  ),
  privateKeyToAccount: vi.fn((privateKey: `0x${string}`) => ({
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`,
    publicKey: "0xmockpubkey",
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    signTypedData: vi.fn(),
    source: "privateKey",
    type: "local",
  })),
}));

import fs from "fs";
import {
  getWalletPath,
  getAutomatonDir,
  getWallet,
  loadWalletAccount,
  walletExists,
  verifyWalletPermissions,
} from "../identity/wallet.js";

// Access mock internals
const mockStore = (fs as any).__store as Record<
  string,
  { content: string; mode: number }
>;
const mockDirs = (fs as any).__dirs as Set<string>;

describe("Wallet", () => {
  beforeEach(() => {
    // Clear mock store
    for (const key of Object.keys(mockStore)) {
      delete mockStore[key];
    }
    mockDirs.clear();
    vi.clearAllMocks();
  });

  // ─── getWalletPath / getAutomatonDir ──────────────────────

  describe("getWalletPath", () => {
    it("returns a path ending with wallet.json", () => {
      const walletPath = getWalletPath();
      expect(walletPath).toMatch(/wallet\.json$/);
    });

    it("is inside the automaton directory", () => {
      const walletPath = getWalletPath();
      const automatonDir = getAutomatonDir();
      expect(walletPath.startsWith(automatonDir)).toBe(true);
    });
  });

  describe("getAutomatonDir", () => {
    it("returns a path under HOME/.automaton", () => {
      const dir = getAutomatonDir();
      expect(dir).toContain(".automaton");
    });
  });

  // ─── generateWallet (via getWallet) ────────────────────────

  describe("getWallet (generate new)", () => {
    it("creates a new wallet when none exists", async () => {
      const { account, isNew } = await getWallet();

      expect(isNew).toBe(true);
      expect(account).toBeDefined();
      expect(account.address).toMatch(/^0x/);
    });

    it("writes wallet file with secure permissions (0o600)", async () => {
      await getWallet();

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const opts = writeCall[2] as { mode?: number } | undefined;
      expect(opts?.mode).toBe(0o600);
    });

    it("creates the automaton directory if it does not exist", async () => {
      await getWallet();

      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it("wallet data contains a privateKey and createdAt", async () => {
      await getWallet();

      const walletPath = getWalletPath();
      expect(walletPath in mockStore).toBe(true);
      const data = JSON.parse(mockStore[walletPath].content);
      expect(data.privateKey).toMatch(/^0x/);
      expect(data.createdAt).toBeDefined();
    });
  });

  describe("getWallet (load existing)", () => {
    it("loads an existing wallet without creating a new one", async () => {
      const walletPath = getWalletPath();
      const automatonDir = getAutomatonDir();
      mockDirs.add(automatonDir);
      mockStore[walletPath] = {
        content: JSON.stringify({
          privateKey:
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          createdAt: "2025-01-01T00:00:00Z",
        }),
        mode: 0o600,
      };

      const { account, isNew } = await getWallet();

      expect(isNew).toBe(false);
      expect(account).toBeDefined();
      expect(account.address).toMatch(/^0x/);
    });
  });

  // ─── loadWalletAccount ─────────────────────────────────────

  describe("loadWalletAccount", () => {
    it("returns null when no wallet file exists", () => {
      const account = loadWalletAccount();
      expect(account).toBeNull();
    });

    it("returns an account when wallet file exists", () => {
      const walletPath = getWalletPath();
      mockStore[walletPath] = {
        content: JSON.stringify({
          privateKey:
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          createdAt: "2025-01-01T00:00:00Z",
        }),
        mode: 0o600,
      };

      const account = loadWalletAccount();
      expect(account).not.toBeNull();
      expect(account!.address).toMatch(/^0x/);
    });
  });

  // ─── walletExists ──────────────────────────────────────────

  describe("walletExists", () => {
    it("returns false when wallet file does not exist", () => {
      expect(walletExists()).toBe(false);
    });

    it("returns true when wallet file exists", () => {
      const walletPath = getWalletPath();
      mockStore[walletPath] = {
        content: "{}",
        mode: 0o600,
      };
      expect(walletExists()).toBe(true);
    });
  });

  // ─── verifyWalletPermissions ───────────────────────────────

  describe("verifyWalletPermissions", () => {
    it("returns error when wallet file does not exist", () => {
      const result = verifyWalletPermissions();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("returns ok when permissions are 0o600", () => {
      const walletPath = getWalletPath();
      mockStore[walletPath] = {
        content: "{}",
        mode: 0o600,
      };

      const result = verifyWalletPermissions();
      expect(result.ok).toBe(true);
    });

    it("attempts to fix insecure permissions", () => {
      const walletPath = getWalletPath();
      // Simulate insecure permissions (0o644 -- world readable)
      mockStore[walletPath] = {
        content: "{}",
        mode: 0o644,
      };

      const result = verifyWalletPermissions();
      // chmodSync should be called to fix permissions
      expect(fs.chmodSync).toHaveBeenCalledWith(walletPath, 0o600);
      expect(result.ok).toBe(true);
    });

    it("returns error when chmod fails", () => {
      const walletPath = getWalletPath();
      mockStore[walletPath] = {
        content: "{}",
        mode: 0o644,
      };

      // Make chmodSync throw
      vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
        throw new Error("Permission denied");
      });

      const result = verifyWalletPermissions();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("insecure permissions");
    });
  });
});
