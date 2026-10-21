import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import dns from "node:dns";
import { OAuthStorage } from "../src/storage/oauth-storage.js";
import { Readable } from "node:stream";
import { OAuthController, fetchMetadataDocument, isNonPublicAddress, publicOnlyLookup, readCapped, redirectUriMatches, validateRedirectUris } from "../src/auth/oauth-controller.js";

const baseUrl = "https://alice.mctl.ai";
const challenge = "a".repeat(43);
const metadataUrl = "https://client.example/oauth/client.json";

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
      await expect(controller.registerClient({ redirect_uris: ["javascript:x"] })).rejects.toMatchObject({ code: "invalid_redirect_uri" });
    });
  });

  describe("resource indicator (RFC 8707)", () => {
    it("accepts this server and rejects any other audience", async () => {
      expect(await authorize("web", "https://app.example/cb", { resource: `${baseUrl}/mcp` })).toMatchObject({ type: "consent" });
      expect(await authorize("web", "https://app.example/cb", { resource: `${baseUrl}/` })).toMatchObject({ type: "consent" });
      for (const path of ["/sse", "/mcp/sse", "/messages", "/mcp/messages"]) {
        expect(await authorize("web", "https://app.example/cb", { resource: `${baseUrl}${path}` }), path).toMatchObject({ type: "consent" });
      }
      for (const resource of ["https://other.example/mcp", `${baseUrl}/admin`, `${baseUrl}.evil.example/mcp`]) {
        expect(await authorize("web", "https://app.example/cb", { resource }), resource).toMatchObject({ error: "invalid_target" });
      }
      await expect(controller.handleToken({ grant_type: "refresh_token", refresh_token: "x", resource: "https://other.example/mcp" })).rejects.toMatchObject({ code: "invalid_target" });
    });
  });

  describe("client metadata documents", () => {
    const validDocument = { client_id: metadataUrl, client_name: "Example", redirect_uris: ["https://client.example/cb"] };
    const doc = (body: unknown, status = 200, contentType = "application/json") => ({ status, contentType, body: typeof body === "string" ? body : JSON.stringify(body) });
    // A controller whose metadata fetcher serves the queued responses and fails on anything extra.
    function withDocuments(...responses: ReturnType<typeof doc>[]) {
      const fetcher = vi.fn(async () => { const next = responses.shift(); if (!next) throw new Error("unexpected metadata fetch"); return next; });
      return { fetcher, hosted: new OAuthController({ baseUrl, yandexClientId: "app", storage, authRequired: true, fetchMetadataDocument: fetcher }) };
    }

    it("stores a self-identifying document and binds its redirect URIs", async () => {
      const { hosted, fetcher } = withDocuments(doc(validDocument));
      const consent = await hosted.handleAuthorize({ client_id: metadataUrl, redirect_uri: "https://client.example/cb", userId: "alice", scope: "iot:view", code_challenge: challenge, code_challenge_method: "S256" });
      expect(consent).toMatchObject({ type: "consent", clientName: "Example" });
      expect(await hosted.isAllowedRedirectUri("https://client.example/elsewhere", metadataUrl)).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("rejects documents that redirect, lie about identity, are invalid or are not JSON", async () => {
      const cases = [
        doc("", 302),
        doc({ ...validDocument, client_id: "https://other.example/client.json" }),
        doc({ ...validDocument, redirect_uris: ["javascript:alert(1)"] }),
        doc(validDocument, 200, "text/html"),
        doc("not json"),
      ];
      const { hosted, fetcher } = withDocuments(...cases);
      for (let i = 0; i < 5; i++) {
        expect(await hosted.resolveClientMetadata(metadataUrl)).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(i + 1);
        expect(await storage.getClient(metadataUrl)).toBeNull();
      }
    });

    it("never fetches local names or non-public literals", async () => {
      const { hosted, fetcher } = withDocuments();
      for (const url of ["https://127.0.0.1/c.json", "https://[::1]/c.json", "https://169.254.169.254/c.json", "https://100.64.0.1/c.json", "https://[::ffff:10.0.0.1]/c.json", "https://[2002:a00:1::1]/c.json", "https://0.0.0.0/c.json", "https://localhost/c.json", "https://client.example:8443/c.json", "http://client.example/c.json"]) {
        expect(await hosted.resolveClientMetadata(url), url).toBe(false);
      }
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("vets resolved addresses at connect time, so a rebinding answer is refused", async () => {
      const lookup = vi.spyOn(dns.promises, "lookup")
        .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }] as never)
        .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as never);
      for (let i = 0; i < 2; i++) {
        await expect(fetchMetadataDocument(metadataUrl)).rejects.toThrow("non-public");
      }
      expect(lookup).toHaveBeenCalledTimes(2);
      const resolved = await new Promise<unknown>((resolve) => {
        lookup.mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }] as never);
        publicOnlyLookup("client.example", {}, (err, address) => resolve(err ?? address));
      });
      expect(resolved).toBe("93.184.215.14");
    });

    it("caps the document size while reading", async () => {
      await expect(readCapped(Readable.from([Buffer.alloc(10000), Buffer.alloc(10000)]), 16384)).rejects.toThrow("too large");
      expect(await readCapped(Readable.from([Buffer.from('{"a":'), Buffer.from("1}")]), 16384)).toBe('{"a":1}');
    });

    it("classifies addresses", () => {
      for (const ip of ["10.1.2.3", "127.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.86.17.126", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1", "::ffff:0:a00:1", "2002:a00:1::1", "2001:0:4136:e378::1", "::a00:1", "not-an-ip"]) {
        expect(isNonPublicAddress(ip), ip).toBe(true);
      }
      for (const ip of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "2001:4860:4860::8888"]) {
        expect(isNonPublicAddress(ip), ip).toBe(false);
      }
    });
  });
});
