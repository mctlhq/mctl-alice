import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken, hashToken, getEncryptionKey } from "../src/storage/crypto.js";
import crypto from "node:crypto";

describe("Crypto Module (AES-256-GCM & Hashing)", () => {
  it("should encrypt and decrypt a plaintext token successfully", () => {
    const userId = "user_12345";
    const plaintext = "y0_AgAAAAAEabcdEFGH123456789";

    const encrypted = encryptToken(plaintext, userId);
    expect(encrypted).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    const decrypted = decryptToken(encrypted, userId);
    expect(decrypted).toBe(plaintext);
  });

  it("should fail decryption if userId (AAD) does not match", () => {
    const userA = "user_attacker";
    const userV = "user_victim";
    const secret = "secret_victim_cookie_1234";

    const encrypted = encryptToken(secret, userV);

    expect(() => {
      decryptToken(encrypted, userA);
    }).toThrow();
  });

  it("should fail decryption if ciphertext is tampered with", () => {
    const userId = "user_test";
    const secret = "secret_token_val";
    const encrypted = encryptToken(secret, userId);

    const parts = encrypted.split(":");
    // Tamper with the last byte of ciphertext
    const tamperedCipher = parts[3].slice(0, -2) + (parts[3].endsWith("00") ? "ff" : "00");
    const tamperedEnvelope = `v1:${parts[1]}:${parts[2]}:${tamperedCipher}`;

    expect(() => {
      decryptToken(tamperedEnvelope, userId);
    }).toThrow();
  });

  it("should fail decryption if auth tag is tampered with", () => {
    const userId = "user_test";
    const secret = "secret_token_val";
    const encrypted = encryptToken(secret, userId);

    const parts = encrypted.split(":");
    const tamperedTag = "00".repeat(16);
    const tamperedEnvelope = `v1:${parts[1]}:${tamperedTag}:${parts[3]}`;

    expect(() => {
      decryptToken(tamperedEnvelope, userId);
    }).toThrow();
  });

  it("should hash tokens deterministically with SHA-256", () => {
    const token = "mcp_token_abc_xyz";
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).not.toBe(token);
  });

  it("should handle custom 32-byte encryption keys", () => {
    const customKey = crypto.randomBytes(32);
    const userId = "user_custom";
    const secret = "custom_secret";

    const encrypted = encryptToken(secret, userId, customKey);
    const decrypted = decryptToken(encrypted, userId, customKey);
    expect(decrypted).toBe(secret);

    // Fail with different key
    const differentKey = crypto.randomBytes(32);
    expect(() => {
      decryptToken(encrypted, userId, differentKey);
    }).toThrow();
  });
});
