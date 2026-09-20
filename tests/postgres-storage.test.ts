import { describe, it, expect, vi, beforeEach } from "vitest";
import { PostgresStorage, PostgresTelemetryStorage } from "../src/storage/postgres-storage.js";

describe("PostgresStorage", () => {
  let mockQuery: any;
  let mockConnect: any;
  let mockPool: any;
  let storage: PostgresStorage;

  beforeEach(() => {
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    mockConnect = vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    mockPool = {
      query: mockQuery,
      connect: mockConnect,
      end: vi.fn().mockResolvedValue(undefined),
    };
    storage = new PostgresStorage({ pool: mockPool });
  });

  it("should initialize database tables via transaction on connect", async () => {
    await storage.ready();
    expect(mockConnect).toHaveBeenCalled();
  });

  it("should save and retrieve user record", async () => {
    await storage.ready();
    await storage.saveUser({
      id: "usr_1",
      yandexUid: "y_1",
      login: "test_user",
      displayName: "Test User",
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO users"),
      expect.arrayContaining(["usr_1", "y_1", "test_user"])
    );

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "usr_1",
          yandex_uid: "y_1",
          login: "test_user",
          display_name: "Test User",
          created_at: "1000",
          updated_at: "1000",
        },
      ],
    });

    const user = await storage.getUser("usr_1");
    expect(user).toEqual({
      id: "usr_1",
      yandexUid: "y_1",
      login: "test_user",
      displayName: "Test User",
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it("should encrypt and save user credentials", async () => {
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await storage.ready();
    await storage.saveUserCredentials("usr_1", {
      yandexAccessToken: "secret_token_123",
      quasarCookie: "secret_cookie_456",
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user_credentials"),
      expect.any(Array)
    );
  });

  it("should manage OAuth clients", async () => {
    await storage.ready();
    await storage.saveClient({
      clientId: "client_abc",
      clientName: "Test App",
      redirectUris: ["https://example.com/callback"],
      createdAt: 2000,
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oauth_clients"),
      expect.arrayContaining(["client_abc", null, "Test App"])
    );

    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          client_id: "client_abc",
          client_name: "Test App",
          redirect_uris: JSON.stringify(["https://example.com/callback"]),
          created_at: "2000",
        },
      ],
    });

    const client = await storage.getClient("client_abc");
    expect(client).toEqual({
      clientId: "client_abc",
      clientName: "Test App",
      clientSecret: undefined,
      redirectUris: ["https://example.com/callback"],
      createdAt: 2000,
    });
  });
});

describe("PostgresTelemetryStorage", () => {
  let mockQuery: any;
  let mockPool: any;
  let telemetryStorage: PostgresTelemetryStorage;

  beforeEach(() => {
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    mockPool = {
      query: mockQuery,
      connect: vi.fn().mockResolvedValue({
        query: mockQuery,
        release: vi.fn(),
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    telemetryStorage = new PostgresTelemetryStorage({ pool: mockPool });
  });

  it("should insert a single telemetry sample", async () => {
    await telemetryStorage.ready();
    await telemetryStorage.insertSample({
      deviceId: "dev_1",
      deviceName: "Living Room Speaker",
      metric: "power",
      value: 12.5,
      timestamp: 1700000000000,
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO telemetry_samples"),
      expect.arrayContaining(["dev_1", "Living Room Speaker", null, "power", 12.5, null, 1700000000000])
    );
  });

  it("should query history with bucketed aggregation", async () => {
    await telemetryStorage.ready();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          device_id: "dev_1",
          device_name: "Speaker",
          metric: "power",
          unit: "unit.watt",
          value: 10,
          min_value: 5,
          max_value: 15,
          sample_count: 3,
          timestamp: "1700000000000",
        },
      ],
    });

    const res = await telemetryStorage.queryHistory({
      deviceId: "dev_1",
      metric: "power",
      from: 1699990000000,
      to: 1700010000000,
      resolution: "5m",
    });

    expect(res.deviceId).toBe("dev_1");
    expect(res.count).toBe(1);
    expect(res.points[0].value).toBe(10);
  });

  it("should prune old samples", async () => {
    await telemetryStorage.ready();
    mockQuery.mockResolvedValueOnce({ rowCount: 42 });
    const deleted = await telemetryStorage.pruneOld(30);
    expect(deleted).toBe(42);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM telemetry_samples WHERE timestamp < $1"),
      expect.any(Array)
    );
  });
});
