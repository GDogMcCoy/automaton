/**
 * Retry Utility
 *
 * Provides retry logic with exponential backoff, timeout handling,
 * and circuit breaker integration.
 */

import {
  checkCircuitBreaker,
  recordSuccess,
  recordFailure,
  calculateBackoff,
  sleep,
  NetworkError,
} from "./error-handler.js";

export interface RetryOptions {
  maxAttempts: number;
  timeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  circuitBreakerName?: string;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  retryableErrors?: string[];
}

export const RetryPresets = {
  network: {
    maxAttempts: 3,
    timeoutMs: 30000,
    backoffBaseMs: 1000,
    backoffMaxMs: 10000,
  },
  database: {
    maxAttempts: 3,
    timeoutMs: 10000,
    backoffBaseMs: 500,
    backoffMaxMs: 5000,
  },
  inference: {
    maxAttempts: 2,
    timeoutMs: 120000,
    backoffBaseMs: 2000,
    backoffMaxMs: 30000,
  },
  critical: {
    maxAttempts: 5,
    timeoutMs: 60000,
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
  },
  bestEffort: {
    maxAttempts: 2,
    timeoutMs: 10000,
    backoffBaseMs: 500,
    backoffMaxMs: 5000,
  },
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...RetryPresets.network, ...options };

  if (opts.circuitBreakerName) {
    checkCircuitBreaker(opts.circuitBreakerName);
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(
              new NetworkError(
                `Operation timed out after ${opts.timeoutMs}ms`,
              ),
            );
          });
        }),
      ]);

      clearTimeout(timeoutId);

      if (opts.circuitBreakerName) {
        recordSuccess(opts.circuitBreakerName);
      }

      return result;
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(String(error));

      const isRetryable =
        !opts.retryableErrors ||
        opts.retryableErrors.some((e) => lastError!.message.includes(e));

      if (!isRetryable || attempt === opts.maxAttempts) {
        if (opts.circuitBreakerName) {
          recordFailure(opts.circuitBreakerName);
        }
        throw lastError;
      }

      const delayMs = calculateBackoff(
        attempt,
        opts.backoffBaseMs,
        opts.backoffMaxMs,
      );

      if (opts.onRetry) {
        opts.onRetry(attempt, lastError, delayMs);
      }

      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Retry failed");
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = init?.timeoutMs || RetryPresets.network.timeoutMs;

  return withRetry(
    async () => {
      const response = await fetch(url, init);
      if (!response.ok && response.status >= 500) {
        throw new NetworkError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }
      return response;
    },
    {
      ...RetryPresets.network,
      timeoutMs,
      retryableErrors: [
        "ECONNRESET",
        "ETIMEDOUT",
        "NETWORK_ERROR",
        "timed out",
      ],
    },
  );
}
