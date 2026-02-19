/**
 * Compute Provider Factory
 *
 * Creates the appropriate compute provider based on configuration.
 */

export { createLocalComputeProvider } from "./local.js";
export { createDockerComputeProvider } from "./docker.js";
export type {
  ComputeProvider,
  ComputeProviderType,
  ComputeProviderConfig,
  LocalComputeConfig,
  DockerComputeConfig,
} from "./provider.js";

import type { ComputeProvider, ComputeProviderConfig } from "./provider.js";
import { createLocalComputeProvider } from "./local.js";
import { createDockerComputeProvider } from "./docker.js";

/**
 * Create a compute provider from config.
 * Defaults to local if no config is provided.
 */
export function createComputeProvider(
  config?: ComputeProviderConfig,
): ComputeProvider {
  if (!config || config.type === "local") {
    return createLocalComputeProvider(config?.local);
  }

  if (config.type === "docker") {
    if (!config.docker) {
      throw new Error("Docker compute config requires 'docker' options");
    }
    return createDockerComputeProvider(config.docker);
  }

  throw new Error(`Unknown compute provider type: ${(config as any).type}`);
}
