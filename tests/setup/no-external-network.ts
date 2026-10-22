// Tests talk only to servers they start on loopback. Any other fetch (a real
// Yandex API, for example account deletion cleaning up Quasar scenarios with a
// stored cookie) fails at once instead of depending on the network and a 5 s
// test timeout. A test that needs an upstream stubs fetch itself.
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK.has(url.hostname)) {
    return Promise.reject(new TypeError(`fetch failed: tests may not reach ${url.hostname}`));
  }
  return realFetch(input, init);
};
