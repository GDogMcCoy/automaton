/**
 * Tests for compute provider factory.
 */

import { describe, it, expect } from "vitest";
import { createComputeProvider } from "../compute/index.js";

describe("Compute Provider Factory", () => {
  it("creates local provider by default", () => {
    const provider = createComputeProvider();
    expect(provider.name).toBe("local");
  });

  it("creates local provider explicitly", () => {
    const provider = createComputeProvider({ type: "local" });
    expect(provider.name).toBe("local");
  });

  it("creates local provider with config", () => {
    const provider = createComputeProvider({
      type: "local",
      local: { workDir: "/tmp" },
    });
    expect(provider.name).toBe("local");
  });

  it("throws for docker without config", () => {
    expect(() => {
      createComputeProvider({ type: "docker" });
    }).toThrow("docker");
  });

  it("creates docker provider with config", () => {
    const provider = createComputeProvider({
      type: "docker",
      docker: { image: "node:20" },
    });
    expect(provider.name).toBe("docker");
  });

  it("throws for unknown provider type", () => {
    expect(() => {
      createComputeProvider({ type: "unknown" as any });
    }).toThrow("Unknown compute provider");
  });
});
