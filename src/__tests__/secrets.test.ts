/**
 * Tests for the secrets management module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadSecret,
  loadSecrets,
  validateRequiredSecrets,
  maskSecret,
} from "../utils/secrets.js";

describe("Secrets Management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadSecret", () => {
    it("loads from environment variables (highest priority)", () => {
      const originalVal = process.env.TEST_SECRET_ABC;
      process.env.TEST_SECRET_ABC = "from-env";
      try {
        const result = loadSecret("TEST_SECRET_ABC");
        expect(result).toBe("from-env");
      } finally {
        if (originalVal === undefined) {
          delete process.env.TEST_SECRET_ABC;
        } else {
          process.env.TEST_SECRET_ABC = originalVal;
        }
      }
    });

    it("loads from file-based secrets", () => {
      const secretsDir = path.join(tmpDir, "secrets");
      fs.mkdirSync(secretsDir);
      fs.writeFileSync(path.join(secretsDir, "my_secret"), "file-secret-value\n");

      const result = loadSecret("MY_SECRET", { secretsDir });
      expect(result).toBe("file-secret-value");
    });

    it("loads from JSON secrets file", () => {
      const jsonPath = path.join(tmpDir, "secrets.json");
      fs.writeFileSync(jsonPath, JSON.stringify({ MY_JSON_SECRET: "json-value" }), { mode: 0o600 });

      const result = loadSecret("MY_JSON_SECRET", {
        secretsDir: "/nonexistent",
        jsonSecretsPath: jsonPath,
      });
      expect(result).toBe("json-value");
    });

    it("returns undefined for missing secrets", () => {
      const result = loadSecret("TOTALLY_NONEXISTENT_SECRET_XYZ", {
        secretsDir: "/nonexistent",
        jsonSecretsPath: "/nonexistent.json",
      });
      expect(result).toBeUndefined();
    });

    it("environment variable takes priority over file", () => {
      const secretsDir = path.join(tmpDir, "secrets");
      fs.mkdirSync(secretsDir);
      fs.writeFileSync(path.join(secretsDir, "priority_test"), "from-file");

      const originalVal = process.env.PRIORITY_TEST;
      process.env.PRIORITY_TEST = "from-env";
      try {
        const result = loadSecret("PRIORITY_TEST", { secretsDir });
        expect(result).toBe("from-env");
      } finally {
        if (originalVal === undefined) {
          delete process.env.PRIORITY_TEST;
        } else {
          process.env.PRIORITY_TEST = originalVal;
        }
      }
    });
  });

  describe("loadSecrets", () => {
    it("loads multiple secrets at once", () => {
      const original1 = process.env.MULTI_SEC_1;
      const original2 = process.env.MULTI_SEC_2;
      process.env.MULTI_SEC_1 = "val1";
      process.env.MULTI_SEC_2 = "val2";
      try {
        const result = loadSecrets(["MULTI_SEC_1", "MULTI_SEC_2", "NONEXISTENT_MULTI"]);
        expect(result).toHaveProperty("MULTI_SEC_1", "val1");
        expect(result).toHaveProperty("MULTI_SEC_2", "val2");
        expect(result).not.toHaveProperty("NONEXISTENT_MULTI");
      } finally {
        if (original1 === undefined) delete process.env.MULTI_SEC_1;
        else process.env.MULTI_SEC_1 = original1;
        if (original2 === undefined) delete process.env.MULTI_SEC_2;
        else process.env.MULTI_SEC_2 = original2;
      }
    });
  });

  describe("validateRequiredSecrets", () => {
    it("returns empty array when all secrets present", () => {
      const original = process.env.VALIDATE_TEST;
      process.env.VALIDATE_TEST = "present";
      try {
        const missing = validateRequiredSecrets(["VALIDATE_TEST"]);
        expect(missing).toEqual([]);
      } finally {
        if (original === undefined) delete process.env.VALIDATE_TEST;
        else process.env.VALIDATE_TEST = original;
      }
    });

    it("returns missing secret names", () => {
      const missing = validateRequiredSecrets(
        ["TOTALLY_MISSING_SECRET_XYZ_123"],
        { secretsDir: "/nonexistent", jsonSecretsPath: "/nonexistent.json" },
      );
      expect(missing).toContain("TOTALLY_MISSING_SECRET_XYZ_123");
    });
  });

  describe("maskSecret", () => {
    it("masks long secrets showing first 4 and last 4 chars", () => {
      expect(maskSecret("abcdefghijklmnop")).toBe("abcd...mnop");
    });

    it("fully masks short secrets", () => {
      expect(maskSecret("short")).toBe("****");
      expect(maskSecret("12345678")).toBe("****");
    });
  });
});
