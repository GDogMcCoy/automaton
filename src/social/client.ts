/**
 * Social Client Factory
 *
 * Creates a SocialClient for the automaton runtime.
 * Self-contained: uses viem for signing and fetch for HTTP.
 */

import {
  type PrivateKeyAccount,
  keccak256,
  toBytes,
} from "viem";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import { sanitizeInput } from "../agent/injection-defense.js";

// ─── Constants ────────────────────────────────────────────────

/** Maximum message content size in bytes. */
const MAX_CONTENT_LENGTH = 10 * 1024; // 10 KB

/** Rate limit: maximum sends allowed per window. */
const RATE_LIMIT_MAX_SENDS = 30;

/** Rate limit window duration in milliseconds (1 minute). */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Timeout for all outbound fetch calls in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/** Valid Ethereum address pattern. */
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Pattern that must never appear in outbound messages (wallet private key). */
const PRIVATE_KEY_RE = /0x[0-9a-f]{64}/i;

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Simple sliding-window rate limiter (in-memory).
 * Tracks timestamps of recent sends and rejects when the window is full.
 */
function createRateLimiter(maxCalls: number, windowMs: number) {
  const timestamps: number[] = [];
  return {
    /** Returns true if the call is allowed, false if rate-limited. */
    check(): boolean {
      const now = Date.now();
      // Evict entries outside the window
      while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= maxCalls) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}

/**
 * Wrapper around fetch that enforces a timeout via AbortController.
 */
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Create a SocialClient wired to the agent's wallet.
 */
export function createSocialClient(
  relayUrl: string,
  account: PrivateKeyAccount,
): SocialClientInterface {
  const baseUrl = relayUrl.replace(/\/$/, "");
  const sendLimiter = createRateLimiter(RATE_LIMIT_MAX_SENDS, RATE_LIMIT_WINDOW_MS);

  return {
    send: async (
      to: string,
      content: string,
      replyTo?: string,
    ): Promise<{ id: string }> => {
      // --- Validate address format ---
      if (!ETH_ADDRESS_RE.test(to)) {
        throw new Error(
          `Invalid recipient address: "${to}". Must match 0x[0-9a-fA-F]{40}.`,
        );
      }

      // --- Enforce content length limit ---
      if (new TextEncoder().encode(content).length > MAX_CONTENT_LENGTH) {
        throw new Error(
          `Message content exceeds maximum length of ${MAX_CONTENT_LENGTH} bytes.`,
        );
      }

      // --- Strip / reject private-key injection patterns ---
      if (PRIVATE_KEY_RE.test(content)) {
        throw new Error(
          "Message rejected: content contains a pattern resembling a wallet private key.",
        );
      }

      // --- Rate-limit sends ---
      if (!sendLimiter.check()) {
        throw new Error(
          `Rate limit exceeded: maximum ${RATE_LIMIT_MAX_SENDS} sends per minute.`,
        );
      }

      const signedAt = new Date().toISOString();
      const contentHash = keccak256(toBytes(content));
      const canonical = `Conway:send:${to.toLowerCase()}:${contentHash}:${signedAt}`;
      const signature = await account.signMessage({ message: canonical });

      const res = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: account.address.toLowerCase(),
          to: to.toLowerCase(),
          content,
          signature,
          signed_at: signedAt,
          reply_to: replyTo,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Send failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },

    poll: async (
      cursor?: string,
      limit?: number,
    ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> => {
      const timestamp = new Date().toISOString();
      const canonical = `Conway:poll:${account.address.toLowerCase()}:${timestamp}`;
      const signature = await account.signMessage({ message: canonical });

      const res = await fetchWithTimeout(`${baseUrl}/v1/messages/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Address": account.address.toLowerCase(),
          "X-Signature": signature,
          "X-Timestamp": timestamp,
        },
        body: JSON.stringify({ cursor, limit }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Poll failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        messages: Array<{
          id: string;
          from: string;
          to: string;
          content: string;
          signedAt: string;
          createdAt: string;
          replyTo?: string;
        }>;
        next_cursor?: string;
      };

      return {
        messages: data.messages.map((m) => {
          const sanitized = sanitizeInput(m.content, m.from);
          return {
            id: m.id,
            from: m.from,
            to: m.to,
            content: sanitized.content,
            signedAt: m.signedAt,
            createdAt: m.createdAt,
            replyTo: m.replyTo,
          };
        }),
        nextCursor: data.next_cursor,
      };
    },

    unreadCount: async (): Promise<number> => {
      const timestamp = new Date().toISOString();
      const canonical = `Conway:poll:${account.address.toLowerCase()}:${timestamp}`;
      const signature = await account.signMessage({ message: canonical });

      const res = await fetchWithTimeout(`${baseUrl}/v1/messages/count`, {
        method: "GET",
        headers: {
          "X-Wallet-Address": account.address.toLowerCase(),
          "X-Signature": signature,
          "X-Timestamp": timestamp,
        },
      });

      if (!res.ok) return 0;

      const data = (await res.json()) as { unread: number };
      return data.unread;
    },
  };
}
