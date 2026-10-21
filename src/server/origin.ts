/**
 * True for a request without an Origin (non-browser clients), from this
 * server's own origin, or from a loopback host such as a local MCP inspector.
 * The Host header is deliberately not trusted: under DNS rebinding a hostile
 * page reaches a loopback server with its own name in both Origin and Host.
 * A self-hosted server reached by another name needs PUBLIC_BASE_URL.
 */
export function isLocalOrigin(origin: string | undefined, baseUrl: string): boolean {
  if (origin === undefined) return true;
  try {
    const { hostname, origin: normalized } = new URL(origin);
    return normalized === new URL(baseUrl).origin || ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}
