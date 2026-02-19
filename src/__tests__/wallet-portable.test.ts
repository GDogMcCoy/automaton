/**
 * Wallet Portability Tests
 *
 * Tests for encrypting, exporting, and importing wallets
 * between machines via the git repo. Uses real filesystem
 * operations in a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  encryptWallet,
  decryptWallet,
  isEncryptedWallet,
  exportWalletToRepo,
  importWalletFromRepo,
  repoWalletExists,
  getRepoWalletAddress,
  migrateWalletToEncrypted,
} from "../identity/wallet.js";

const TEST_WALLET = {
  privateKey:
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`,
  createdAt: "2025-01-01T00:00:00Z",
};

// Known address for the test private key (Hardhat account #0)
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const TEST_PASSPHRASE = "test-passphrase-for-wallet-encryption";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-wallet-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Wallet Encryption", () => {
  it("encryptWallet returns a string starting with ENC:", () => {
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    expect(encrypted.startsWith("ENC:")).toBe(true);
  });

  it("isEncryptedWallet detects encrypted content", () => {
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    expect(isEncryptedWallet(encrypted)).toBe(true);
    expect(isEncryptedWallet('{"privateKey":"0x..."}')).toBe(false);
  });

  it("decryptWallet recovers original data", () => {
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    const decrypted = decryptWallet(encrypted, TEST_PASSPHRASE) as typeof TEST_WALLET;
    expect(decrypted.privateKey).toBe(TEST_WALLET.privateKey);
    expect(decrypted.createdAt).toBe(TEST_WALLET.createdAt);
  });

  it("decryptWallet fails with wrong passphrase", () => {
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    expect(() => decryptWallet(encrypted, "wrong-passphrase")).toThrow(
      "Failed to decrypt",
    );
  });

  it("decryptWallet handles input with or without ENC: prefix", () => {
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    const withoutPrefix = encrypted.slice("ENC:".length);

    const d1 = decryptWallet(encrypted, TEST_PASSPHRASE) as typeof TEST_WALLET;
    const d2 = decryptWallet(withoutPrefix, TEST_PASSPHRASE) as typeof TEST_WALLET;

    expect(d1.privateKey).toBe(TEST_WALLET.privateKey);
    expect(d2.privateKey).toBe(TEST_WALLET.privateKey);
  });

  it("decryptWallet rejects truncated data", () => {
    expect(() => decryptWallet("ENC:AAAA", TEST_PASSPHRASE)).toThrow("too short");
  });

  it("each encryption produces different ciphertext (random salt/IV)", () => {
    const e1 = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    const e2 = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    expect(e1).not.toBe(e2);

    // Both decrypt to the same data
    const d1 = decryptWallet(e1, TEST_PASSPHRASE) as typeof TEST_WALLET;
    const d2 = decryptWallet(e2, TEST_PASSPHRASE) as typeof TEST_WALLET;
    expect(d1.privateKey).toBe(d2.privateKey);
  });
});

describe("Wallet Export to Repo", () => {
  it("exports wallet to specified path", () => {
    // Create a fake wallet file in the home dir
    const homeWallet = path.join(tmpDir, "home-wallet.json");
    fs.writeFileSync(homeWallet, JSON.stringify(TEST_WALLET), { mode: 0o600 });

    // We can't easily call exportWalletToRepo because it reads from the actual
    // WALLET_FILE constant. Instead test the underlying encrypt+write flow:
    const repoPath = path.join(tmpDir, "wallet.enc");
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(repoPath, encrypted, { mode: 0o644 });

    expect(fs.existsSync(repoPath)).toBe(true);
    const content = fs.readFileSync(repoPath, "utf-8");
    expect(isEncryptedWallet(content)).toBe(true);
  });

  it("encrypted file can be decrypted to recover wallet", () => {
    const repoPath = path.join(tmpDir, "wallet.enc");
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(repoPath, encrypted, { mode: 0o644 });

    const content = fs.readFileSync(repoPath, "utf-8");
    const decrypted = decryptWallet(content, TEST_PASSPHRASE) as typeof TEST_WALLET;
    expect(decrypted.privateKey).toBe(TEST_WALLET.privateKey);
  });
});

describe("Wallet Import from Repo", () => {
  it("rejects plaintext wallet files", () => {
    const repoPath = path.join(tmpDir, "wallet.enc");
    fs.writeFileSync(repoPath, JSON.stringify(TEST_WALLET));

    // importWalletFromRepo checks the path vs REPO_WALLET_ENC constant,
    // so test the validation logic directly:
    const content = fs.readFileSync(repoPath, "utf-8");
    expect(isEncryptedWallet(content)).toBe(false);
  });

  it("decrypts and writes wallet to local path", () => {
    // Simulate the import flow
    const repoPath = path.join(tmpDir, "wallet.enc");
    const localPath = path.join(tmpDir, "wallet.json");

    // Export (encrypt)
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(repoPath, encrypted, { mode: 0o644 });

    // Import (decrypt)
    const content = fs.readFileSync(repoPath, "utf-8");
    expect(isEncryptedWallet(content)).toBe(true);
    const decrypted = decryptWallet(content, TEST_PASSPHRASE) as typeof TEST_WALLET;
    fs.writeFileSync(localPath, JSON.stringify(decrypted, null, 2), { mode: 0o600 });

    // Verify
    const imported = JSON.parse(fs.readFileSync(localPath, "utf-8"));
    expect(imported.privateKey).toBe(TEST_WALLET.privateKey);
    expect(imported.createdAt).toBe(TEST_WALLET.createdAt);
  });
});

describe("repoWalletExists", () => {
  it("returns false when no repo wallet exists", () => {
    expect(repoWalletExists(path.join(tmpDir, "nonexistent.enc"))).toBe(false);
  });

  it("returns true when repo wallet exists", () => {
    const repoPath = path.join(tmpDir, "wallet.enc");
    fs.writeFileSync(repoPath, "ENC:dummy");
    expect(repoWalletExists(repoPath)).toBe(true);
  });
});

describe("getRepoWalletAddress", () => {
  it("returns the wallet address from encrypted repo wallet", () => {
    const repoPath = path.join(tmpDir, "wallet.enc");
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(repoPath, encrypted);

    const address = getRepoWalletAddress(TEST_PASSPHRASE, repoPath);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("throws with wrong passphrase", () => {
    const repoPath = path.join(tmpDir, "wallet.enc");
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(repoPath, encrypted);

    expect(() => getRepoWalletAddress("wrong", repoPath)).toThrow();
  });

  it("throws when file does not exist", () => {
    expect(() =>
      getRepoWalletAddress(TEST_PASSPHRASE, path.join(tmpDir, "nope.enc")),
    ).toThrow("No encrypted wallet found");
  });
});

describe("migrateWalletToEncrypted", () => {
  it("encrypts a plaintext wallet in place", () => {
    const walletPath = path.join(tmpDir, "wallet.json");
    fs.writeFileSync(walletPath, JSON.stringify(TEST_WALLET), { mode: 0o600 });

    migrateWalletToEncrypted(walletPath, TEST_PASSPHRASE);

    const content = fs.readFileSync(walletPath, "utf-8");
    expect(isEncryptedWallet(content)).toBe(true);

    // Verify we can decrypt it back
    const decrypted = decryptWallet(content, TEST_PASSPHRASE) as typeof TEST_WALLET;
    expect(decrypted.privateKey).toBe(TEST_WALLET.privateKey);
  });

  it("is a no-op for already-encrypted wallets", () => {
    const walletPath = path.join(tmpDir, "wallet.json");
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(walletPath, encrypted, { mode: 0o600 });

    // Should not throw, just warn
    migrateWalletToEncrypted(walletPath, TEST_PASSPHRASE);

    // Content should be unchanged
    const content = fs.readFileSync(walletPath, "utf-8");
    expect(content).toBe(encrypted);
  });

  it("throws for missing wallet file", () => {
    expect(() =>
      migrateWalletToEncrypted(path.join(tmpDir, "nope.json"), TEST_PASSPHRASE),
    ).toThrow("not found");
  });

  it("throws for invalid wallet data", () => {
    const walletPath = path.join(tmpDir, "wallet.json");
    fs.writeFileSync(walletPath, JSON.stringify({ foo: "bar" }), { mode: 0o600 });

    expect(() => migrateWalletToEncrypted(walletPath, TEST_PASSPHRASE)).toThrow(
      "valid privateKey",
    );
  });
});

describe("Full Portability Round-Trip", () => {
  it("encrypt -> write to repo -> read from repo -> decrypt -> same wallet", () => {
    const repoPath = path.join(tmpDir, "repo", ".automaton", "wallet.enc");
    const localPath = path.join(tmpDir, "local", ".automaton", "wallet.json");

    // Step 1: Encrypt and write to "repo"
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    const encrypted = encryptWallet(TEST_WALLET, TEST_PASSPHRASE);
    fs.writeFileSync(repoPath, encrypted, { mode: 0o644 });

    // Step 2: Read from "repo" (simulating git clone on new machine)
    const repoContent = fs.readFileSync(repoPath, "utf-8");
    expect(isEncryptedWallet(repoContent)).toBe(true);

    // Step 3: Decrypt and write to local home
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const walletData = decryptWallet(repoContent, TEST_PASSPHRASE) as typeof TEST_WALLET;
    fs.writeFileSync(localPath, JSON.stringify(walletData, null, 2), { mode: 0o600 });

    // Step 4: Verify the local wallet matches the original
    const restored = JSON.parse(fs.readFileSync(localPath, "utf-8"));
    expect(restored.privateKey).toBe(TEST_WALLET.privateKey);
    expect(restored.createdAt).toBe(TEST_WALLET.createdAt);

    // Step 5: Verify file permissions
    const stat = fs.statSync(localPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
