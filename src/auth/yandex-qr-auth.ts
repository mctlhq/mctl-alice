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

function extractCookiePairs(setCookieHeaders: string[]): string {
  const map = new Map<string, string>();
  for (const header of setCookieHeaders) {
    if (!header) continue;
    const firstPart = header.split(";")[0];
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx > 0) {
      const k = firstPart.substring(0, eqIdx).trim();
      const v = firstPart.substring(eqIdx + 1).trim();
      if (k) map.set(k, v);
    }
  }
  const pairs: string[] = [];
  for (const [k, v] of map.entries()) {
    pairs.push(`${k}=${v}`);
  }
  return pairs.join("; ");
}

export async function initQrAuth(): Promise<{ sessionId: string; link: string; qrSvg: string }> {
  cleanExpiredSessions();

  // 1. Initial request to passport to obtain CSRF and session cookies
  const r1 = await fetch("https://passport.yandex.ru/pwl-yandex", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!r1.ok) {
    throw new Error(`Failed to contact Yandex Passport: HTTP ${r1.status}`);
  }

  const text1 = await r1.text();
  const csrfMatch = text1.match(/__CSRF__\s*=\s*"([^"]+)"/);
  if (!csrfMatch || !csrfMatch[1]) {
    throw new Error("Failed to extract CSRF token from Yandex Passport page");
  }
  const csrf = csrfMatch[1];

  const setCookies1 =
    typeof (r1.headers as any).getSetCookie === "function"
      ? (r1.headers as any).getSetCookie()
      : [r1.headers.get("set-cookie")].filter(Boolean);
  const initialCookies = extractCookiePairs(setCookies1);

  // 2. Submit password/auth intent to generate track ID
  const r2 = await fetch(
    "https://passport.yandex.ru/pwl-yandex/api/passport/auth/password/submit",
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrf,
        Cookie: initialCookies,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ retpath: "https://passport.yandex.ru/" }),
    }
  );

  if (!r2.ok) {
    throw new Error(`Failed to submit auth track to Yandex: HTTP ${r2.status}`);
  }

  const data2 = (await r2.json()) as any;
  if (!data2.track_id) {
    throw new Error("Yandex did not return track_id for magic code");
  }
  const trackId: string = data2.track_id;
  const submitCsrf: string = data2.csrf_token || csrf;

  // 3. Request magic code link for QR code
  const r3 = await fetch(
    "https://passport.yandex.ru/pwl-yandex/api/passport/auth/magic/code",
    {
      method: "POST",
      headers: {
        "X-CSRF-Token": submitCsrf,
        Cookie: initialCookies,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: new URLSearchParams({
        location_id: "0",
        magic_track_id: trackId,
        track_id: "",
      }).toString(),
    }
  );

  if (!r3.ok) {
    throw new Error(`Failed to create magic code link: HTTP ${r3.status}`);
  }

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
    csrfToken: submitCsrf,
    cookies: initialCookies,
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
    // 1. Check status of magic code approval
    const rStatus = await fetch(
      "https://passport.yandex.ru/pwl-yandex/api/passport/auth/magic/code/status",
      {
        method: "POST",
        headers: {
          "X-CSRF-Token": session.csrfToken,
          Cookie: session.cookies,
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    const dataStatus = (await rStatus.json()) as any;
    if (dataStatus.state !== "otp_auth_finished") {
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
          Cookie: session.cookies,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        body: new URLSearchParams({
          track_id: finalTrackId,
        }).toString(),
      }
    );

    const setCookies =
      typeof (rSession.headers as any).getSetCookie === "function"
        ? (rSession.headers as any).getSetCookie()
        : [rSession.headers.get("set-cookie")].filter(Boolean);

    const fullCookies = extractCookiePairs([...setCookies, ...session.cookies.split("; ")]);

    if (!fullCookies.includes("Session_id=")) {
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
