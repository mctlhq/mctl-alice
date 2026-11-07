/** Process-wide socket defaults for outbound calls to Yandex. */
import net from "node:net";

/**
 * How long one address of a multi-address host (api.iot.yandex.net has an A and an AAAA record)
 * may take to connect before happy-eyeballs moves on to the next one.
 *
 * Node 24 defaults to 250 ms. The pod has no IPv6 route, so once the IPv4 attempt is cut off the
 * IPv6 one fails at once and the whole call dies with ETIMEDOUT in about 0.26 s: a single lost
 * SYN (first retransmit after 1 s) was enough to fail a Yandex call or a sign-in. 5 s covers the
 * Linux SYN retransmits at 1 s and 3 s and stays under undici's 10 s connect timeout.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

/** Applied once at startup; global fetch (undici) inherits these net defaults. */
export function applyNetDefaults(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
