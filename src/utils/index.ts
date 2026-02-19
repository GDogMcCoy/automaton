/**
 * Utils barrel export
 *
 * Re-exports all utility modules for convenient importing.
 * Individual modules can still be imported directly if preferred:
 *   import { createLogger } from "../utils/logger.js";
 */

export {
  AutomatonError,
  NetworkError,
  DatabaseError,
  CircuitBreakerError,
  checkCircuitBreaker,
  recordSuccess,
  recordFailure,
  safeJsonParse,
  safeJsonStringify,
  calculateBackoff,
  sleep,
  setupGlobalErrorHandlers,
} from "./error-handler.js";

export {
  withRetry,
  fetchWithRetry,
  RetryPresets,
  type RetryOptions,
} from "./retry.js";

export {
  createLogger,
  type Logger,
  type LogLevel,
  type LogEntry,
} from "./logger.js";
