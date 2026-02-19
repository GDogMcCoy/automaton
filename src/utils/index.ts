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

export {
  createRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from "./rate-limiter.js";

export {
  createMetricsCollector,
  type MetricsCollector,
  type MetricsSnapshot,
  type HistogramStats,
} from "./metrics.js";

export {
  loadSecret,
  loadSecrets,
  validateRequiredSecrets,
  maskSecret,
  type SecretsConfig,
} from "./secrets.js";

export {
  withTrace,
  getTraceId,
  getTraceContext,
  generateTraceId,
  createSpan,
  getTraceMetadata,
  type TraceContext,
} from "./tracing.js";
