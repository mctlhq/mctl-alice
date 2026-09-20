import { describe, it, expect, vi, beforeEach } from "vitest";
import { MinioStorage } from "../src/storage/minio-storage.js";

describe("MinioStorage (S3 REST Backend)", () => {
  let storage: MinioStorage;
  const mockBucket = new Map<string, string>();

  beforeEach(() => {
    mockBucket.clear();

    // Mock global fetch to simulate MinIO S3 REST responses
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any) => {
        const u = new URL(url);
        const path = decodeURIComponent(u.pathname);

        // Verify SigV4 Authorization header
        const auth = opts?.headers?.Authorization;
        expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=/);

        if (opts?.method === "PUT") {
          mockBucket.set(path, opts.body);
          return {
            ok: true,
            status: 200,
            text: async () => "",
          };
        }

        if (opts?.method === "GET") {
          if (!mockBucket.has(path)) {
            return {
              ok: false,
              status: 404,
              text: async () => "NoSuchKey",
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => JSON.parse(mockBucket.get(path)!),
            text: async () => mockBucket.get(path)!,
          };
        }

        if (opts?.method === "DELETE") {
          mockBucket.delete(path);
          return {
            ok: true,
            status: 204,
            text: async () => "",
          };
        }

        return { ok: false, status: 405 };
      })
    );

    storage = new MinioStorage({
      endpoint: "http://minio.test.local:9000",
      bucket: "test-bucket",
      prefix: "mctl-alice",
      accessKey: "test_minio_access_key",
      secretKey: "test_minio_secret_key_1234567890",
    });
  });

  it("should save and retrieve user profile by ID and Yandex UID", async () => {
    const user = {
      id: "usr_alice_99",
      yandexUid: "99887766",
      login: "alice_tester",
      displayName: "Alice Tester",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storage.saveUser(user);

    const byId = await storage.getUser("usr_alice_99");
    expect(byId).toEqual(user);

    const byUid = await storage.getUserByYandexUid("99887766");
    expect(byUid).toEqual(user);
  });

  it("should encrypt user credentials at rest in MinIO and decrypt on get", async () => {
    const userId = "usr_alice_99";
    await storage.saveUserCredentials(userId, {
      yandexAccessToken: "secret_yandex_oauth_token",
      yandexRefreshToken: "secret_yandex_refresh_token",
      quasarCookie: "Session_id=secret_session_id",
    });

    // Verify stored object in mock bucket is encrypted
    const storedRaw = mockBucket.get("/test-bucket/mctl-alice/credentials/usr_alice_99.json");
    expect(storedRaw).toBeDefined();
    expect(storedRaw).not.toContain("secret_yandex_oauth_token");
    expect(storedRaw).not.toContain("secret_session_id");
    expect(storedRaw).toContain("v1:");

    // Retrieval decrypts cleanly
    const creds = await storage.getUserCredentials(userId);
    expect(creds?.yandexAccessToken).toBe("secret_yandex_oauth_token");
    expect(creds?.yandexRefreshToken).toBe("secret_yandex_refresh_token");
    expect(creds?.quasarCookie).toBe("Session_id=secret_session_id");
  });

  it("should manage web sessions in MinIO", async () => {
    const sessionId = "session_browser_123";
    const userId = "usr_alice_99";
    const expiresAt = Date.now() + 3600000;

    await storage.saveWebSession(sessionId, userId, expiresAt);

    const session = await storage.getWebSession(sessionId);
    expect(session).toEqual({ userId });

    await storage.deleteWebSession(sessionId);
    expect(await storage.getWebSession(sessionId)).toBeNull();
  });

  it("should save, retrieve, and revoke OAuth tokens in MinIO", async () => {
    const accessToken = "mctl_at_minio_test_token";
    const refreshToken = "mctl_rt_minio_test_token";

    await storage.saveToken({
      accessToken,
      refreshToken,
      clientId: "client_codex",
      userId: "usr_alice_99",
      yandexAccessToken: "yandex_token_123",
      scope: "iot:view iot:control",
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    });

    const token = await storage.getToken(accessToken);
    expect(token).toBeDefined();
    expect(token?.accessToken).toBe(accessToken);
    expect(token?.userId).toBe("usr_alice_99");
    expect(token?.yandexAccessToken).toBe("yandex_token_123");

    const byRefresh = await storage.getTokenByRefreshToken(refreshToken);
    expect(byRefresh).toBeDefined();
    expect(byRefresh?.accessToken).toBe(accessToken);

    await storage.revokeToken(accessToken);
    expect(await storage.getToken(accessToken)).toBeNull();
  });

  it("should manage Quasar proxy scenarios in MinIO", async () => {
    const userId = "usr_alice_99";
    await storage.saveQuasarScenario(userId, "speaker_1", "sc_quasar_1", "mctl-usr_alic-speaker_1");

    const scenarioId = await storage.getQuasarScenario(userId, "speaker_1");
    expect(scenarioId).toBe("sc_quasar_1");

    const list = await storage.listQuasarScenarios(userId);
    expect(list).toHaveLength(1);
    expect(list[0].deviceId).toBe("speaker_1");

    await storage.deleteQuasarScenarios(userId);
    expect(await storage.getQuasarScenario(userId, "speaker_1")).toBeNull();
  });
});
