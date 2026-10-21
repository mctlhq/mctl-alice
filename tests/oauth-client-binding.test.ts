import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import dns from "node:dns";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { OAuthController, isNonPublicAddress, redirectUriMatches, validateRedirectUris } from "../src/auth/oauth-controller.js";

const baseUrl = "https://alice.mctl.ai";
const challenge = "a".repeat(43);
const metadataUrl = "https://client.example/oauth/client.json";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("hosted OAuth client binding", () => {
  let storage: OAuthStorage;
  let controller: OAuthController;
  const authorize = (clientId: string, redirectUri: string, extra: Record<string, string> = {}) =>
    controller.handleAuthorize({ client_id: clientId, redirect_uri: redirectUri, userId: "alice", scope: "iot:view", code_challenge: challenge, code_challenge_method: "S256", ...extra });

  beforeEach(async () => {
    storage = new OAuthStorage(":memory:");
    controller = new OAuthController({ baseUrl, yandexClientId: "app", storage, authRequired: true });
    storage.saveUser({ id: "alice", yandexUid: "alice", createdAt: Date.now(), updatedAt: Date.now() });
    storage.saveClient({ clientId: "web", clientSecret: "", clientName: "Web", redirectUris: ["https://app.example/cb"], createdAt: Date.now() });
    storage.saveClient({ clientId: "native", clientSecret: "", clientName: "Native", redirectUris: ["http://127.0.0.1/callback", "http://localhost:8787/callback"], createdAt: Date.now() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    storage.close();
  });

  describe("redirect URI", () => {
    it("accepts only a URI registered for the presented client", async () => {
      expect(await authorize("web", "https://app.example/cb")).toMatchObject({ type: "consent" });
      expect(await authorize("unknown", "https://app.example/cb")).toMatchObject({ error: "invalid_request" });
      expect(await authorize("native", "https://app.example/cb")).toMatchObject({ error: "invalid_request" });
      for (const uri of ["https://app.example/cb/", "https://app.example/cb?x=1", "https://app.example:444/cb", "https://app.example/cb#f", "http://app.example/cb"]) {
        expect(await authorize("web", uri), uri).toMatchObject({ error: "invalid_request" });
      }
    });

    it("no longer trusts vendor hostnames or the client_id origin in hosted mode", async () => {
      for (const uri of ["https://chatgpt.com/aip/g-attacker/oauth/callback", "https://claude.ai/api/mcp/auth_callback", "http://localhost:3000/callback"]) {
        expect(await controller.isAllowedRedirectUri(uri, "web"), uri).toBe(false);
      }
      expect(await controller.isAllowedRedirectUri("https://client.example/cb", metadataUrl)).toBe(false);
    });

    it("lets loopback redirects vary only in port (RFC 8252)", async () => {
      expect(await authorize("native", "http://127.0.0.1:53111/callback")).toMatchObject({ type: "consent" });
      expect(await authorize("native", "http://localhost:9000/callback")).toMatchObject({ type: "consent" });
      for (const uri of ["http://127.0.0.1:53111/other", "http://localhost:9000/callback?x=1", "http://[::1]:53111/callback", "https://127.0.0.1:53111/callback"]) {
        expect(await authorize("native", uri), uri).toMatchObject({ error: "invalid_request" });
      }
      expect(redirectUriMatches("https://app.example:443/cb", "https://app.example:8443/cb")).toBe(false);
    });

    it("keeps the permissive vendor allowlist in local mode", async () => {
      const local = new OAuthController({ baseUrl, yandexClientId: "app", storage });
      expect(await local.isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", "unknown")).toBe(true);
    });
  });

  describe("dynamic client registration", () => {
    it("issues its own client_id, keeps valid URIs and sanitizes the name", async () => {
      const reg = await controller.registerClient({ client_id: "web", client_name: " Cla‮ude\u0000 ", redirect_uris: ["https://app.example/other", "cursor://callback"] });
      expect(reg.client_id).not.toBe("web");
      expect(reg.client_name).toBe("Claude");
      expect((await storage.getClient("web"))!.redirectUris).toEqual(["https://app.example/cb"]);
      expect((await storage.getClient(reg.client_id))!.redirectUris).toEqual(["https://app.example/other", "cursor://callback"]);
      expect((await controller.registerClient({ client_name: "x".repeat(500), redirect_uris: ["https://a.example/cb"] })).client_name).toHaveLength(100);
    });

    it("rejects missing, malformed or dangerous redirect URIs", async () => {
      for (const redirect_uris of [undefined, [], ["/relative"], ["javascript:alert(1)"], ["data:text/html,x"], ["https://a.example/cb#frag"], ["https://user:pw@a.example/cb"], Array(11).fill("https://a.example/cb"), [42]]) {
        await expect(controller.registerClient({ redirect_uris: redirect_uris as string[] }), JSON.stringify(redirect_uris)).rejects.toThrow();
      }
      expect(() => validateRedirectUris(["https://a.example/" + "x".repeat(2048)])).toThrow();
    });
  });

  describe("resource indicator (RFC 8707)", () => {
    it("accepts this server and rejects any other audience", async () => {
      expect(await authorize("web", "https://app.example/cb", { resource: `${baseUrl}/mcp` })).toMatchObject({ type: "consent" });
      expect(await authorize("web", "https://app.example/cb", { resource: `${baseUrl}/` })).toMatchObject({ type: "consent" });
      expect(await authorize("web", "https://app.example/cb", { resource: "https://other.example/mcp" })).toMatchObject({ error: "invalid_target" });
      await expect(controller.handleToken({ grant_type: "refresh_token", refresh_token: "x", resource: "https://other.example/mcp" })).rejects.toThrow("resource");
    });
  });

  describe("client metadata documents", () => {
    const publicDns = () => vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.215.14", family: 4 }] as never);
    const validDocument = { client_id: metadataUrl, client_name: "Example", redirect_uris: ["https://client.example/cb"] };

    it("stores a self-identifying document and binds its redirect URIs", async () => {
      publicDns();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(validDocument));
      expect(await authorize(metadataUrl, "https://client.example/cb")).toMatchObject({ type: "consent", clientName: "Example" });
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
      expect(await authorize(metadataUrl, "https://client.example/elsewhere")).toMatchObject({ error: "invalid_request" });
    });

    it("rejects documents that redirect, lie about identity, are oversized or are not JSON", async () => {
      publicDns();
      const fetchMock = vi.spyOn(globalThis, "fetch");
      for (const response of [
        new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
        jsonResponse({ ...validDocument, client_id: "https://other.example/client.json" }),
        jsonResponse({ ...validDocument, redirect_uris: ["javascript:alert(1)"] }),
        jsonResponse({ ...validDocument, client_name: "x".repeat(20000) }),
        jsonResponse(validDocument, { headers: { "content-type": "text/html" } }),
        jsonResponse("not json"),
      ]) {
        fetchMock.mockResolvedValueOnce(response);
        expect(await controller.resolveClientMetadata(metadataUrl)).toBe(false);
        expect(await storage.getClient(metadataUrl)).toBeNull();
      }
    });

    it("never fetches non-public addresses, including via DNS", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      for (const url of ["https://127.0.0.1/c.json", "https://[::1]/c.json", "https://169.254.169.254/c.json", "https://100.64.0.1/c.json", "https://[::ffff:10.0.0.1]/c.json", "https://0.0.0.0/c.json", "https://client.example:8443/c.json"]) {
        expect(await controller.resolveClientMetadata(url), url).toBe(false);
      }
      vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }] as never);
      expect(await controller.resolveClientMetadata(metadataUrl)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("classifies addresses", () => {
      for (const ip of ["10.1.2.3", "127.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.86.17.126", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1", "not-an-ip"]) {
        expect(isNonPublicAddress(ip), ip).toBe(true);
      }
      for (const ip of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
        expect(isNonPublicAddress(ip), ip).toBe(false);
      }
    });
  });
});
