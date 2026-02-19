/**
 * Tests for the local compute provider.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createLocalComputeProvider } from "../compute/local.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

function tmpDir(): string {
  return join(tmpdir(), `automaton-test-${randomBytes(6).toString("hex")}`);
}

describe("Local Compute Provider", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanupDirs.length = 0;
  });

  it("executes shell commands", async () => {
    const provider = createLocalComputeProvider();
    const result = await provider.exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("captures stderr", async () => {
    const provider = createLocalComputeProvider();
    const result = await provider.exec("echo error >&2");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("error");
  });

  it("returns non-zero exit code on failure", async () => {
    const provider = createLocalComputeProvider();
    const result = await provider.exec("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("respects timeout", async () => {
    const provider = createLocalComputeProvider({ defaultTimeoutMs: 500 });
    const result = await provider.exec("sleep 10", 500);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("writes and reads files", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });

    const provider = createLocalComputeProvider({ workDir: dir });
    const filePath = join(dir, "test.txt");

    await provider.writeFile(filePath, "hello world");
    const content = await provider.readFile(filePath);
    expect(content).toBe("hello world");
  });

  it("creates parent directories for writeFile", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);

    const provider = createLocalComputeProvider({ workDir: dir });
    const filePath = join(dir, "nested", "deep", "file.txt");

    await provider.writeFile(filePath, "nested content");
    const content = await provider.readFile(filePath);
    expect(content).toBe("nested content");
  });

  it("rejects files exceeding size limit", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });

    const provider = createLocalComputeProvider({
      workDir: dir,
      maxFileSizeBytes: 100,
    });

    await expect(
      provider.writeFile(join(dir, "big.txt"), "x".repeat(200)),
    ).rejects.toThrow("exceeds limit");
  });

  it("enforces path jailing", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });

    const provider = createLocalComputeProvider({
      workDir: dir,
      allowedPaths: [dir],
    });

    // Writing inside allowed path should work
    const goodPath = join(dir, "allowed.txt");
    await provider.writeFile(goodPath, "ok");
    expect(await provider.readFile(goodPath)).toBe("ok");

    // Writing outside allowed path should throw
    await expect(
      provider.writeFile("/tmp/evil.txt", "nope"),
    ).rejects.toThrow("outside allowed directories");
  });

  it("rejects paths with null bytes", async () => {
    const provider = createLocalComputeProvider();
    await expect(
      provider.readFile("/etc/passwd\0.txt"),
    ).rejects.toThrow("null bytes");
  });

  it("health check passes", async () => {
    const provider = createLocalComputeProvider();
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(true);
  });

  it("uses custom working directory", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    await fs.mkdir(dir, { recursive: true });

    const provider = createLocalComputeProvider({ workDir: dir });
    const result = await provider.exec("pwd");
    expect(result.stdout.trim()).toBe(dir);
  });

  it("injects environment variables", async () => {
    const provider = createLocalComputeProvider({
      env: { MY_VAR: "test_value" },
    });
    const result = await provider.exec("echo $MY_VAR");
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("runs multi-command pipelines", async () => {
    const provider = createLocalComputeProvider();
    const result = await provider.exec("echo one two three | wc -w");
    expect(result.stdout.trim()).toBe("3");
  });
});
