/**
 * Inference Client Tests
 *
 * Tests for tool call validation, argument stringification,
 * and default handling of missing fields in the inference response.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createInferenceClient } from "../conway/inference.js";
import type { InferenceClient } from "../types.js";

/**
 * Helper to set up a fake fetch that returns a controlled response.
 * Returns a function to restore the original fetch.
 */
function mockFetch(responseBody: any, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  }) as any;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Build a standard OpenAI-compatible completion response with
 * customizable tool_calls in the message.
 */
function completionResponse(
  toolCalls?: any[],
  content = "",
): any {
  return {
    id: "chatcmpl-test",
    model: "gpt-4.1-nano",
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls,
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

describe("Inference Client", () => {
  let client: InferenceClient;
  let restoreFetch: () => void;

  beforeEach(() => {
    client = createInferenceClient({
      apiUrl: "https://api.test.conway.tech",
      apiKey: "test-key",
      defaultModel: "gpt-4.1-nano",
      maxTokens: 2048,
    });
    // Default: restore is a no-op until mockFetch is called
    restoreFetch = () => {};
  });

  afterEach(() => {
    restoreFetch();
  });

  // ─── Tool call validation: filters malformed entries ──────────

  describe("tool call validation", () => {
    it("filters out tool calls without a function name", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          { id: "call_1", type: "function", function: { name: "valid_tool", arguments: "{}" } },
          { id: "call_2", type: "function", function: { arguments: "{}" } }, // missing name
          { id: "call_3", type: "function", function: { name: "", arguments: "{}" } }, // empty name is falsy
          null, // completely null entry
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);

      // Only the first call should survive (name: "valid_tool").
      // The third entry has name: "" which is falsy, so it gets filtered.
      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBe(1);
      expect(response.toolCalls![0].function.name).toBe("valid_tool");
    });

    it("filters out tool calls where function is undefined", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          { id: "call_1", type: "function", function: { name: "good", arguments: "{}" } },
          { id: "call_2", type: "function" }, // no function property at all
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBe(1);
      expect(response.toolCalls![0].function.name).toBe("good");
    });

    it("returns undefined toolCalls when response has no tool_calls", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "Hello!"));

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.toolCalls).toBeUndefined();
      expect(response.message.content).toBe("Hello!");
    });
  });

  // ─── Tool call arguments stringification ──────────────────────

  describe("tool call argument stringification", () => {
    it("keeps string arguments as-is", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            id: "call_1",
            type: "function",
            function: {
              name: "my_tool",
              arguments: '{"key": "value"}',
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.toolCalls![0].function.arguments).toBe('{"key": "value"}');
    });

    it("stringifies object arguments", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            id: "call_1",
            type: "function",
            function: {
              name: "my_tool",
              arguments: { key: "value", nested: { a: 1 } }, // object, not string
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      const args = response.toolCalls![0].function.arguments;
      expect(typeof args).toBe("string");
      const parsed = JSON.parse(args);
      expect(parsed.key).toBe("value");
      expect(parsed.nested.a).toBe(1);
    });

    it("stringifies empty object arguments when arguments is undefined", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            id: "call_1",
            type: "function",
            function: {
              name: "my_tool",
              arguments: undefined,
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      const args = response.toolCalls![0].function.arguments;
      expect(typeof args).toBe("string");
      expect(JSON.parse(args)).toEqual({});
    });

    it("stringifies null arguments to empty object", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            id: "call_1",
            type: "function",
            function: {
              name: "my_tool",
              arguments: null,
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      const args = response.toolCalls![0].function.arguments;
      expect(typeof args).toBe("string");
      expect(JSON.parse(args)).toEqual({});
    });
  });

  // ─── Missing tool call IDs default to empty string ────────────

  describe("missing tool call IDs", () => {
    it("defaults missing id to empty string", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            // no id field
            type: "function",
            function: {
              name: "tool_without_id",
              arguments: "{}",
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.toolCalls![0].id).toBe("");
    });

    it("preserves existing id when present", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            id: "call_abc123",
            type: "function",
            function: {
              name: "tool_with_id",
              arguments: "{}",
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.toolCalls![0].id).toBe("call_abc123");
    });

    it("defaults null id to empty string", async () => {
      restoreFetch = mockFetch(
        completionResponse([
          {
            id: null,
            type: "function",
            function: {
              name: "tool_null_id",
              arguments: "{}",
            },
          },
        ]),
      );

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.toolCalls![0].id).toBe("");
    });
  });

  // ─── Response structure ───────────────────────────────────────

  describe("response structure", () => {
    it("maps usage tokens correctly", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "Hello"));

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.usage.promptTokens).toBe(10);
      expect(response.usage.completionTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
    });

    it("defaults usage to 0 when missing", async () => {
      restoreFetch = mockFetch({
        id: "test",
        model: "gpt-4.1-nano",
        choices: [
          {
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        // no usage field
      });

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.usage.promptTokens).toBe(0);
      expect(response.usage.completionTokens).toBe(0);
      expect(response.usage.totalTokens).toBe(0);
    });

    it("defaults content to empty string when null", async () => {
      restoreFetch = mockFetch({
        id: "test",
        model: "gpt-4.1-nano",
        choices: [
          {
            message: { role: "assistant", content: null },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const response = await client.chat([{ role: "user", content: "test" }]);
      expect(response.message.content).toBe("");
    });

    it("throws when no choices returned", async () => {
      restoreFetch = mockFetch({
        id: "test",
        model: "gpt-4.1-nano",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      await expect(
        client.chat([{ role: "user", content: "test" }]),
      ).rejects.toThrow("No completion choice returned");
    });
  });

  // ─── Model selection ──────────────────────────────────────────

  describe("model selection", () => {
    it("uses default model", () => {
      expect(client.getDefaultModel()).toBe("gpt-4.1-nano");
    });

    it("switches to low compute model", () => {
      client.setLowComputeMode(true);
      // Without lowComputeModel option, it falls back to "gpt-4.1"
      expect(client.getDefaultModel()).toBe("gpt-4.1");
    });

    it("restores default model when exiting low compute mode", () => {
      client.setLowComputeMode(true);
      client.setLowComputeMode(false);
      expect(client.getDefaultModel()).toBe("gpt-4.1-nano");
    });

    it("uses custom lowComputeModel when specified", () => {
      const customClient = createInferenceClient({
        apiUrl: "https://api.test.conway.tech",
        apiKey: "test-key",
        defaultModel: "gpt-5",
        maxTokens: 8192,
        lowComputeModel: "gpt-4.1-mini",
      });
      customClient.setLowComputeMode(true);
      expect(customClient.getDefaultModel()).toBe("gpt-4.1-mini");
    });
  });

  // ─── Request formatting ───────────────────────────────────────

  describe("request formatting", () => {
    it("uses max_completion_tokens for o-series models", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "done"));

      await client.chat(
        [{ role: "user", content: "test" }],
        { model: "o1-preview" },
      );

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.max_completion_tokens).toBeDefined();
      expect(body.max_tokens).toBeUndefined();
    });

    it("uses max_tokens for standard models", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "done"));

      await client.chat(
        [{ role: "user", content: "test" }],
        { model: "gpt-3.5-turbo" },
      );

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.max_tokens).toBeDefined();
      expect(body.max_completion_tokens).toBeUndefined();
    });

    it("uses max_completion_tokens for gpt-4.1 models", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "done"));

      await client.chat(
        [{ role: "user", content: "test" }],
        { model: "gpt-4.1" },
      );

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.max_completion_tokens).toBeDefined();
      expect(body.max_tokens).toBeUndefined();
    });

    it("includes tools in request body when provided", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "done"));

      const tools = [
        {
          type: "function" as const,
          function: {
            name: "test_tool",
            description: "A test tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ];

      await client.chat(
        [{ role: "user", content: "test" }],
        { tools },
      );

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.tools).toBeDefined();
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toBe("auto");
    });

    it("does not include tools when array is empty", async () => {
      restoreFetch = mockFetch(completionResponse(undefined, "done"));

      await client.chat(
        [{ role: "user", content: "test" }],
        { tools: [] },
      );

      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });
  });
});
