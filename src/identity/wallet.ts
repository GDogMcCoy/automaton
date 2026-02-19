/**
 * Automaton Wallet Management
 *
 * Creates and manages an EVM wallet for the automaton's identity and payments.
 * The private key is the automaton's sovereign identity.
 * Adapted from conway-mcp/src/wallet.ts
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { WalletData } from "../types.js";

const AUTOMATON_DIR = path.join(
  process.env.HOME || "/root",
  ".automaton",
);
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

// ─── Encryption Constants ────────────────────────────────────────
const ENCRYPTED_PREFIX = "ENC:";
const SCRYPT_N = 16384; // 2^14
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// ─── Encryption Functions ────────────────────────────────────────

/**
 * Encrypt wallet data using AES-256-GCM with a passphrase-derived key.
 *
 * Key derivation uses scrypt (N=2^14, r=8, p=1).
 * Returns a base64-encoded string containing: salt (32) + iv (16) + authTag (16) + ciphertext.
 */
export function encryptWallet(walletData: object, passphrase: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  const key = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(walletData);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: salt + iv + authTag + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return ENCRYPTED_PREFIX + packed.toString("base64");
}

/**
 * Decrypt an encrypted wallet string using AES-256-GCM with a passphrase-derived key.
 *
 * Expects input in the format produced by encryptWallet (with or without the "ENC:" prefix).
 * Returns the parsed JSON wallet data.
 */
export function decryptWallet(encrypted: string, passphrase: string): object {
  // Strip the ENC: prefix if present
  const payload = encrypted.startsWith(ENCRYPTED_PREFIX)
    ? encrypted.slice(ENCRYPTED_PREFIX.length)
    : encrypted;

  const packed = Buffer.from(payload, "base64");

  const minLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1;
  if (packed.length < minLength) {
    throw new Error("Encrypted wallet data is too short or corrupted");
  }

  let offset = 0;
  const salt = packed.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = packed.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = packed.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = packed.subarray(offset);

  const key = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted: string;
  try {
    decrypted = decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
  } catch {
    throw new Error(
      "Failed to decrypt wallet. Wrong passphrase or corrupted data.",
    );
  }

  return JSON.parse(decrypted);
}

/**
 * Check whether a wallet file's content is encrypted (prefixed with "ENC:") vs plaintext JSON.
 */
export function isEncryptedWallet(content: string): boolean {
  return content.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Resolve the wallet passphrase: use the explicit parameter if provided,
 * otherwise fall back to the AUTOMATON_WALLET_PASSPHRASE environment variable.
 * Returns undefined if neither is available.
 */
function resolvePassphrase(passphrase?: string): string | undefined {
  if (passphrase) return passphrase;
  return process.env.AUTOMATON_WALLET_PASSPHRASE || undefined;
}

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Get or create the automaton's wallet.
 * The private key IS the automaton's identity -- protect it.
 *
 * If a passphrase is provided (or AUTOMATON_WALLET_PASSPHRASE is set),
 * new wallets are written encrypted and existing encrypted wallets are decrypted.
 * Unencrypted wallets are still loaded transparently for backward compatibility.
 */
export async function getWallet(passphrase?: string): Promise<{
  account: PrivateKeyAccount;
  isNew: boolean;
}> {
  const resolvedPassphrase = resolvePassphrase(passphrase);

  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(WALLET_FILE)) {
    // Verify file permissions
    const permCheck = verifyWalletPermissions();
    if (!permCheck.ok) {
      console.warn(`[WALLET] Warning: ${permCheck.error}`);
    }

    const fileContent = fs.readFileSync(WALLET_FILE, "utf-8");
    let walletData: WalletData;

    if (isEncryptedWallet(fileContent)) {
      if (!resolvedPassphrase) {
        throw new Error(
          "Wallet is encrypted but no passphrase provided. " +
            "Set AUTOMATON_WALLET_PASSPHRASE or pass a passphrase parameter.",
        );
      }
      walletData = decryptWallet(fileContent, resolvedPassphrase) as WalletData;
    } else {
      walletData = JSON.parse(fileContent);
    }

    const account = privateKeyToAccount(walletData.privateKey);
    return { account, isNew: false };
  } else {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const walletData: WalletData = {
      privateKey,
      createdAt: new Date().toISOString(),
    };

    const fileContent = resolvedPassphrase
      ? encryptWallet(walletData, resolvedPassphrase)
      : JSON.stringify(walletData, null, 2);

    fs.writeFileSync(WALLET_FILE, fileContent, {
      mode: 0o600,
    });

    return { account, isNew: true };
  }
}

/**
 * Get the wallet address without loading the full account.
 * Accepts an optional passphrase for encrypted wallets.
 */
export function getWalletAddress(passphrase?: string): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const resolvedPassphrase = resolvePassphrase(passphrase);
  const fileContent = fs.readFileSync(WALLET_FILE, "utf-8");
  let walletData: WalletData;

  if (isEncryptedWallet(fileContent)) {
    if (!resolvedPassphrase) {
      throw new Error(
        "Wallet is encrypted but no passphrase provided. " +
          "Set AUTOMATON_WALLET_PASSPHRASE or pass a passphrase parameter.",
      );
    }
    walletData = decryptWallet(fileContent, resolvedPassphrase) as WalletData;
  } else {
    walletData = JSON.parse(fileContent);
  }

  const account = privateKeyToAccount(walletData.privateKey);
  return account.address;
}

/**
 * Load the full wallet account (needed for signing).
 *
 * If the wallet is encrypted, uses the provided passphrase or falls back
 * to the AUTOMATON_WALLET_PASSPHRASE environment variable.
 * Unencrypted wallets are loaded without a passphrase for backward compatibility.
 */
export function loadWalletAccount(passphrase?: string): PrivateKeyAccount | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const resolvedPassphrase = resolvePassphrase(passphrase);
  const fileContent = fs.readFileSync(WALLET_FILE, "utf-8");
  let walletData: WalletData;

  if (isEncryptedWallet(fileContent)) {
    if (!resolvedPassphrase) {
      throw new Error(
        "Wallet is encrypted but no passphrase provided. " +
          "Set AUTOMATON_WALLET_PASSPHRASE or pass a passphrase parameter.",
      );
    }
    walletData = decryptWallet(fileContent, resolvedPassphrase) as WalletData;
  } else {
    walletData = JSON.parse(fileContent);
  }

  return privateKeyToAccount(walletData.privateKey);
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}

/**
 * Verify wallet file has correct permissions (owner read/write only).
 * Returns true if permissions are correct, false otherwise.
 */
export function verifyWalletPermissions(): { ok: boolean; error?: string } {
  if (!fs.existsSync(WALLET_FILE)) {
    return { ok: false, error: "Wallet file does not exist" };
  }

  try {
    const stats = fs.statSync(WALLET_FILE);
    const mode = stats.mode & 0o777;

    // Should be 0o600 (owner read/write only)
    if (mode !== 0o600) {
      // Try to fix permissions
      try {
        fs.chmodSync(WALLET_FILE, 0o600);
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: `Wallet file has insecure permissions: ${mode.toString(8)} (expected: 600)`,
        };
      }
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Cannot check wallet permissions: ${err.message}` };
  }
}

/**
 * Migrate an unencrypted wallet file to encrypted format.
 *
 * Reads the plaintext wallet at the given path, encrypts it with the
 * provided passphrase, and writes it back in place. If the wallet is
 * already encrypted, this is a no-op with a warning.
 */
export function migrateWalletToEncrypted(
  walletPath: string,
  passphrase: string,
): void {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }

  const fileContent = fs.readFileSync(walletPath, "utf-8");

  if (isEncryptedWallet(fileContent)) {
    console.warn("[WALLET] Wallet is already encrypted, skipping migration.");
    return;
  }

  const walletData = JSON.parse(fileContent) as WalletData;

  // Validate that it looks like a real wallet before encrypting
  if (!walletData.privateKey || !walletData.privateKey.startsWith("0x")) {
    throw new Error("Wallet file does not contain a valid privateKey field");
  }

  const encrypted = encryptWallet(walletData, passphrase);
  fs.writeFileSync(walletPath, encrypted, { mode: 0o600 });
}
