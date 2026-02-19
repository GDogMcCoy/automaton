/**
 * Multi-Provider Inference
 *
 * A sovereignty layer that wraps multiple inference providers behind a single
 * InferenceClient interface. If Conway is down, the automaton can still think
 * by falling back to direct provider APIs (OpenAI, Anthropic, or any
 * OpenAI-compatible endpoint).
 *
 * Provider selection is automatic:
 *   1. Try the primary provider (Conway)
 *   2. If circuit breaker is open or request fails, try the next provider
 *   3. Continue through the priority list until one succeeds
 *   4. If all fail, throw the last error
 *
 * Each provider has its own circuit breaker and health state.
 *
 * Usage:
 *   const client = createMultiProviderInference({
 *     providers: [
 *       { name: "conway", apiUrl: "https://api.conway.tech", apiKey: "ck_...", priority: 0 },
 *       { name: "openai", apiUrl: "https://api.openai.com", apiKey: "sk-...", priority: 1 },
 *     ],
 *     defaultModel: "gpt-4o",
 *     maxTokens: 4096,
 *   });
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
} from "../types.js";
import { withRetry, RetryPresets } from "../utils/retry.js";
import { NetworkError } from "../utils/error-handler.js";
import { createLogger } from "../utils/logger.js";
import { createMetricsCollector } from "../utils/metrics.js";
import type { MetricsCollector } from "../utils/metrics.js";

const log = createLogger("multi-inference");

// ─── Types ──────────────────────────────────────────────────────

export interface InferenceProvider {
  /** Human-readable name (e.g. "conway", "openai-direct", "anthropic") */
  name: string;
  /** Base URL for the OpenAI-compatible API */
  apiUrl: string;
  /** API key or auth token */
  apiKey: string;
  /** Auth header format: "raw" sends the key as-is, "bearer" sends "Bearer {key}" */
  authStyle?: "raw" | "bearer";
  /** Lower number = higher priority (tried first) */
  priority: number;
  /** Model override for this provider (if it uses different model names) */
  modelMap?: Record<string, string>;
  /** Whether this provider accepts x402 payments instead of API keys */
  x402?: boolean;
  /** Maximum timeout in ms for this provider */
  timeoutMs?: number;
  /** Whether this provider is enabled */
  enabled?: boolean;
}

export interface ProviderHealth {
  name: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastSuccess?: string;
  lastFailure?: string;
  lastError?: string;
  totalRequests: number;
  totalFailures: number;
  avgLatencyMs: number;
  circuitBreakerOpen: boolean;
}

export interface MultiProviderOptions {
  providers: InferenceProvider[];
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  metrics?: MetricsCollector;
}

export interface MultiProviderInferenceClient extends InferenceClient {
  /** Get health status for all providers */
  getProviderHealth(): ProviderHealth[];
  /** Get the name of the currently active provider */
  getActiveProvider(): string;
  /** Manually mark a provider as unhealthy (e.g., from external monitoring) */
  markUnhealthy(providerName: string, reason: string): void;
  /** Reset a provider's circuit breaker */
  resetProvider(providerName: string): void;
}

// ─── Provider State ─────────────────────────────────────────────

interface ProviderState {
  provider: InferenceProvider;
  consecutiveFailures: number;
  circuitBreakerOpen: boolean;
  circuitBreakerResetAt: number;
  lastSuccess: number;
  lastFailure: number;
  lastError: string;
  totalRequests: number;
  totalFailures: number;
  latencySum: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3; // Open after 3 consecutive failures
const CIRCUIT_BREAKER_RESET_MS = 2 * 60 * 1000; // Try again after 2 minutes

// ─── Factory ────────────────────────────────────────────────────

export function createMultiProviderInference(
  opts: MultiProviderOptions,
): MultiProviderInferenceClient {
  const metrics = opts.metrics || createMetricsCollector();

  // Sort providers by priority (lower number = higher priority)
  const sortedProviders = [...opts.providers]
    .filter((p) => p.enabled !== false)
    .sort((a, b) => a.priority - b.priority);

  if (sortedProviders.length === 0) {
    throw new Error("No inference providers configured");
  }

  // Initialize state for each provider
  const states = new Map<string, ProviderState>();
  for (const provider of sortedProviders) {
    states.set(provider.name, {
      provider,
      consecutiveFailures: 0,
      circuitBreakerOpen: false,
      circuitBreakerResetAt: 0,
      lastSuccess: 0,
      lastFailure: 0,
      lastError: "",
      totalRequests: 0,
      totalFailures: 0,
      latencySum: 0,
    });
  }

  let currentModel = opts.defaultModel;
  let maxTokens = opts.maxTokens;
  let activeProviderName = sortedProviders[0].name;

  // ─── Core: try providers in order ───────────────────────────

  async function chatWithProvider(
    state: ProviderState,
    messages: ChatMessage[],
    inferOpts?: InferenceOptions,
  ): Promise<InferenceResponse> {
    const provider = state.provider;
    const model = resolveModel(provider, inferOpts?.model || currentModel);
    const tools = inferOpts?.tools;

    const usesCompletionTokens = /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = inferOpts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (inferOpts?.temperature !== undefined) {
      body.temperature = inferOpts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const authHeader =
      provider.authStyle === "bearer"
        ? `Bearer ${provider.apiKey}`
        : provider.apiKey;

    const timeoutMs = provider.timeoutMs || 180_000;

    const data = await withRetry(
      async () => {
        const resp = await fetch(`${provider.apiUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) {
          const text = await resp.text();
          const truncatedText = text.slice(0, 500);
          if (resp.status >= 500 || resp.status === 429) {
            throw new NetworkError(
              `${provider.name} inference error: ${resp.status}: ${truncatedText}`,
              resp.status,
            );
          }
          throw new Error(
            `${provider.name} inference error: ${resp.status}: ${truncatedText}`,
          );
        }

        return resp.json() as Promise<any>;
      },
      {
        ...RetryPresets.inference,
        circuitBreakerName: `inference-${provider.name}`,
        retryableErrors: [
          "ECONNRESET",
          "ETIMEDOUT",
          "NETWORK_ERROR",
          "429",
          "500",
          "502",
          "503",
        ],
      },
    );

    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`No completion choice returned from ${provider.name}`);
    }

    const message = choice.message;
    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0,
    };

    const rawToolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    const toolCalls: InferenceToolCall[] | undefined =
      rawToolCalls.length > 0
        ? rawToolCalls
            .filter((tc: any) => tc?.function?.name)
            .map((tc: any) => ({
              id: tc.id || "",
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === "string"
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments || {}),
              },
            }))
        : undefined;

    return {
      id: data.id || "",
      model: data.model || model,
      message: {
        role: message.role,
        content: message.content || "",
        tool_calls: toolCalls,
      },
      toolCalls,
      usage,
      finishReason: choice.finish_reason || "stop",
    };
  }

  // ─── Provider selection with failover ─────────────────────

  async function chat(
    messages: ChatMessage[],
    inferOpts?: InferenceOptions,
  ): Promise<InferenceResponse> {
    const now = Date.now();
    let lastError: Error | null = null;

    for (const provider of sortedProviders) {
      const state = states.get(provider.name)!;
      state.totalRequests++;

      // Check circuit breaker
      if (state.circuitBreakerOpen) {
        if (now < state.circuitBreakerResetAt) {
          log.debug("Provider circuit breaker open, skipping", {
            provider: provider.name,
            resetInMs: state.circuitBreakerResetAt - now,
          });
          metrics.counter("inference.circuit_breaker_skip", {
            provider: provider.name,
          });
          continue;
        }
        // Reset time passed — try again (half-open)
        log.info("Provider circuit breaker half-open, retrying", {
          provider: provider.name,
        });
        state.circuitBreakerOpen = false;
      }

      const startMs = Date.now();

      try {
        const response = await chatWithProvider(state, messages, inferOpts);

        // Success — record and return
        const latencyMs = Date.now() - startMs;
        state.consecutiveFailures = 0;
        state.lastSuccess = Date.now();
        state.latencySum += latencyMs;
        activeProviderName = provider.name;

        metrics.counter("inference.success", { provider: provider.name });
        metrics.histogram("inference.latency_ms", latencyMs, {
          provider: provider.name,
        });

        if (sortedProviders.indexOf(provider) > 0) {
          log.info("Inference served by fallback provider", {
            provider: provider.name,
            primaryProvider: sortedProviders[0].name,
          });
        }

        return response;
      } catch (err: any) {
        const latencyMs = Date.now() - startMs;
        state.consecutiveFailures++;
        state.totalFailures++;
        state.lastFailure = Date.now();
        state.lastError = err.message;
        state.latencySum += latencyMs;
        lastError = err;

        metrics.counter("inference.failure", { provider: provider.name });

        log.warn("Provider failed, trying next", {
          provider: provider.name,
          error: err.message,
          consecutiveFailures: state.consecutiveFailures,
          remainingProviders:
            sortedProviders.length - sortedProviders.indexOf(provider) - 1,
        });

        // Trip circuit breaker if threshold reached
        if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          state.circuitBreakerOpen = true;
          state.circuitBreakerResetAt = Date.now() + CIRCUIT_BREAKER_RESET_MS;
          log.error("Provider circuit breaker tripped", {
            provider: provider.name,
            resetMs: CIRCUIT_BREAKER_RESET_MS,
          });
          metrics.counter("inference.circuit_breaker_trip", {
            provider: provider.name,
          });
        }
      }
    }

    // All providers exhausted
    log.error("All inference providers failed", {
      providers: sortedProviders.map((p) => p.name),
      lastError: lastError?.message,
    });
    metrics.counter("inference.all_providers_failed");

    throw lastError || new Error("All inference providers failed");
  }

  // ─── Low compute mode ─────────────────────────────────────

  function setLowComputeMode(enabled: boolean): void {
    if (enabled) {
      currentModel = opts.lowComputeModel || "gpt-4.1";
      maxTokens = 4096;
    } else {
      currentModel = opts.defaultModel;
      maxTokens = opts.maxTokens;
    }
  }

  function getDefaultModel(): string {
    return currentModel;
  }

  // ─── Health reporting ─────────────────────────────────────

  function getProviderHealth(): ProviderHealth[] {
    return sortedProviders.map((p) => {
      const state = states.get(p.name)!;
      const totalSuccessful = state.totalRequests - state.totalFailures;
      return {
        name: p.name,
        healthy:
          !state.circuitBreakerOpen && state.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD,
        consecutiveFailures: state.consecutiveFailures,
        lastSuccess: state.lastSuccess
          ? new Date(state.lastSuccess).toISOString()
          : undefined,
        lastFailure: state.lastFailure
          ? new Date(state.lastFailure).toISOString()
          : undefined,
        lastError: state.lastError || undefined,
        totalRequests: state.totalRequests,
        totalFailures: state.totalFailures,
        avgLatencyMs:
          totalSuccessful > 0
            ? Math.round(state.latencySum / totalSuccessful)
            : 0,
        circuitBreakerOpen: state.circuitBreakerOpen,
      };
    });
  }

  function getActiveProvider(): string {
    return activeProviderName;
  }

  function markUnhealthy(providerName: string, reason: string): void {
    const state = states.get(providerName);
    if (state) {
      state.circuitBreakerOpen = true;
      state.circuitBreakerResetAt = Date.now() + CIRCUIT_BREAKER_RESET_MS;
      state.lastError = reason;
      log.warn("Provider manually marked unhealthy", {
        provider: providerName,
        reason,
      });
    }
  }

  function resetProvider(providerName: string): void {
    const state = states.get(providerName);
    if (state) {
      state.circuitBreakerOpen = false;
      state.consecutiveFailures = 0;
      log.info("Provider manually reset", { provider: providerName });
    }
  }

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
    getProviderHealth,
    getActiveProvider,
    markUnhealthy,
    resetProvider,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function resolveModel(
  provider: InferenceProvider,
  requestedModel: string,
): string {
  if (provider.modelMap && provider.modelMap[requestedModel]) {
    return provider.modelMap[requestedModel];
  }
  return requestedModel;
}

function formatMessage(msg: ChatMessage): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;
  return formatted;
}

// ─── Convenience: build providers from config ──────────────────

/**
 * Build a provider list from the automaton config.
 * Always includes Conway as the primary provider.
 * Additional providers come from config.inferenceProviders (if present).
 */
export function buildProviderList(config: {
  conwayApiUrl: string;
  conwayApiKey: string;
  inferenceProviders?: InferenceProvider[];
}): InferenceProvider[] {
  const providers: InferenceProvider[] = [
    {
      name: "conway",
      apiUrl: config.conwayApiUrl,
      apiKey: config.conwayApiKey,
      authStyle: "raw",
      priority: 0,
      enabled: true,
    },
  ];

  if (config.inferenceProviders) {
    for (const p of config.inferenceProviders) {
      providers.push({
        ...p,
        // Ensure fallback providers have lower priority than Conway
        priority: Math.max(p.priority, 1),
        enabled: p.enabled !== false,
      });
    }
  }

  return providers;
}
