import QRCode from "qrcode";

export interface QrAuthSession {
  sessionId: string;
  trackId: string;
  csrfToken: string;
  cookies: string;
  link: string;
  createdAt: number;
}

// In-memory store for pending QR sessions, expires after 5 minutes
const sessions = new Map<string, QrAuthSession>();
const SESSION_TTL_MS = 5 * 60 * 1000;

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

class CookieJar {
  private cookies = new Map<string, string>();

  constructor(initialStr?: string) {
    if (initialStr) {
      this.parse(initialStr);
    }
  }

  parse(cookieStr: string): void {
    const parts = cookieStr.split(";");
    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx > 0) {
        const k = part.substring(0, idx).trim();
        const v = part.substring(idx + 1).trim();
        if (k) this.cookies.set(k, v);
      }
    }
  }

  addFromResponse(res: Response): void {
    if (!res || !res.headers) return;
    const headers: string[] =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);

    for (const h of headers) {
      if (!h) continue;
      const firstPart = h.split(";")[0];
      const idx = firstPart.indexOf("=");
      if (idx > 0) {
        const k = firstPart.substring(0, idx).trim();
        const v = firstPart.substring(idx + 1).trim();
        if (k) this.cookies.set(k, v);
      }
    }
  }

  toString(): string {
    const pairs: string[] = [];
    for (const [k, v] of this.cookies.entries()) {
      pairs.push(`${k}=${v}`);
    }
    return pairs.join("; ");
  }

  has(key: string): boolean {
    return this.cookies.has(key);
  }
}

const PASSPORT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function initQrAuth(): Promise<{ sessionId: string; link: string; qrSvg: string }> {
  cleanExpiredSessions();
  const jar = new CookieJar();

  // 1. Initial request to passport to obtain page CSRF and initial session cookies
  const r1 = await fetch("https://passport.yandex.ru/pwl-yandex", {
    headers: {
      "User-Agent": PASSPORT_USER_AGENT,
    },
  });

  if (!r1.ok) {
    throw new Error(`Failed to contact Yandex Passport: HTTP ${r1.status}`);
  }

  jar.addFromResponse(r1);

  const text1 = await r1.text();
  const csrfMatch = text1.match(/__CSRF__\s*=\s*"([^"]+)"/);
  if (!csrfMatch || !csrfMatch[1]) {
    throw new Error("Failed to extract CSRF token from Yandex Passport page");
  }
  const pageCsrf = csrfMatch[1];

  // 2. Submit password/auth intent to generate track ID
  const r2 = await fetch(
    "https://passport.yandex.ru/pwl-yandex/api/passport/auth/password/submit",
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": pageCsrf,
        Cookie: jar.toString(),
        Origin: "https://passport.yandex.ru",
        Referer: "https://passport.yandex.ru/pwl-yandex",
        "Content-Type": "application/json",
        "User-Agent": PASSPORT_USER_AGENT,
      },
      body: JSON.stringify({ retpath: "https://passport.yandex.ru/" }),
    }
  );

  if (!r2.ok) {
    throw new Error(`Failed to submit auth track to Yandex: HTTP ${r2.status}`);
  }

  jar.addFromResponse(r2);
  const data2 = (await r2.json()) as any;
  if (!data2.track_id) {
    throw new Error("Yandex did not return track_id for magic code");
  }
  const trackId: string = data2.track_id;

  // 3. Request magic code link for QR code using the same page CSRF and accumulated cookies
  const r3 = await fetch(
    "https://passport.yandex.ru/pwl-yandex/api/passport/auth/magic/code",
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": pageCsrf,
        Cookie: jar.toString(),
        Origin: "https://passport.yandex.ru",
        Referer: "https://passport.yandex.ru/pwl-yandex",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": PASSPORT_USER_AGENT,
      },
      body: new URLSearchParams({
        location_id: "0",
        magic_track_id: trackId,
        track_id: "",
      }).toString(),
    }
  );

  if (!r3.ok) {
    const errBody = await r3.text();
    throw new Error(`Failed to create magic code link (HTTP ${r3.status}): ${errBody}`);
  }

  jar.addFromResponse(r3);
  const data3 = (await r3.json()) as any;
  if (!data3.link) {
    throw new Error("Yandex did not return QR authentication link");
  }
  const link: string = data3.link;

  // Generate SVG QR code
  const qrSvg = await QRCode.toString(link, {
    type: "svg",
    margin: 2,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });

  const sessionId = trackId;
  sessions.set(sessionId, {
    sessionId,
    trackId,
    csrfToken: pageCsrf,
    cookies: jar.toString(),
    link,
    createdAt: Date.now(),
  });

  return { sessionId, link, qrSvg };
}

export async function checkQrAuthStatus(sessionId: string): Promise<{
  status: "waiting" | "ok" | "expired" | "error";
  cookie?: string;
  message?: string;
}> {
  cleanExpiredSessions();

  const session = sessions.get(sessionId);
  if (!session) {
    return {
      status: "expired",
      message: "QR session expired or not found. Please refresh the QR code.",
    };
  }

  try {
    const jar = new CookieJar(session.cookies);

    // 1. Check status of magic code approval
    const rStatus = await fetch(
      "https://passport.yandex.ru/pwl-yandex/api/passport/auth/magic/code/status",
      {
        method: "POST",
        headers: {
          "X-CSRF-Token": session.csrfToken,
          Cookie: jar.toString(),
          Origin: "https://passport.yandex.ru",
          Referer: "https://passport.yandex.ru/pwl-yandex",
          "Content-Type": "application/json",
          "User-Agent": PASSPORT_USER_AGENT,
        },
        body: JSON.stringify({
          track_id: session.trackId,
          magic_track_id: session.trackId,
          csrf_token: session.csrfToken,
        }),
      }
    );

    if (!rStatus.ok) {
      return { status: "waiting" };
    }

    jar.addFromResponse(rStatus);
    const dataStatus = (await rStatus.json()) as any;
    if (dataStatus.state !== "otp_auth_finished") {
      // Update accumulated cookies in session
      session.cookies = jar.toString();
      return { status: "waiting" };
    }

    const finalTrackId = dataStatus.trackId || session.trackId;

    // 2. Obtain authenticated session cookies
    const rSession = await fetch(
      "https://passport.yandex.ru/pwl-yandex/api/passport/sessions/get_session",
      {
        method: "POST",
        headers: {
          "X-CSRF-Token": session.csrfToken,
          Cookie: jar.toString(),
          Origin: "https://passport.yandex.ru",
          Referer: "https://passport.yandex.ru/pwl-yandex",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": PASSPORT_USER_AGENT,
        },
        body: new URLSearchParams({
          track_id: finalTrackId,
        }).toString(),
      }
    );

    jar.addFromResponse(rSession);
    const fullCookies = jar.toString();

    if (!jar.has("Session_id")) {
      return {
        status: "error",
        message: "Authorization finished but Session_id cookie was not returned by Yandex.",
      };
    }

    // Done, delete session
    sessions.delete(sessionId);
    return {
      status: "ok",
      cookie: fullCookies,
    };
  } catch (err: any) {
    return {
      status: "error",
      message: err.message,
    };
  }
}
