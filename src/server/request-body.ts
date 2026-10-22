import type http from "node:http";

/** Cap for OAuth, account and sign-in form/JSON bodies. */
export const FORM_BODY_LIMIT = 64 * 1024;

const DEFAULT_MCP_BODY_LIMIT = 1024 * 1024;
const configuredMcpLimit = Number(process.env.MAX_MCP_BODY_BYTES);
/** Cap for MCP JSON-RPC and REST tool bodies (env MAX_MCP_BODY_BYTES). */
export const MCP_BODY_LIMIT =
  Number.isFinite(configuredMcpLimit) && configuredMcpLimit > 0 ? Math.floor(configuredMcpLimit) : DEFAULT_MCP_BODY_LIMIT;

export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(message = "Payload too large") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Buffers a body stream, failing as soon as it exceeds `limit` bytes. It stops
 * consuming on overflow without destroying the stream, so the caller can still
 * answer on the same connection.
 */
export function readBodyCapped(stream: NodeJS.ReadableStream, limit: number, message?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.byteLength;
      if (size > limit) {
        cleanup();
        stream.pause();
        chunks.length = 0;
        reject(new PayloadTooLargeError(message));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

/** Reads a request body as UTF-8, rejecting a declared oversize length without reading. */
export async function readRequestBody(req: http.IncomingMessage, { limit }: { limit: number }): Promise<string> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > limit) throw new PayloadTooLargeError();
  return (await readBodyCapped(req, limit)).toString("utf8");
}

/** Reads and parses a JSON or form-urlencoded body. */
export async function parseRequestBody(req: http.IncomingMessage, { limit = FORM_BODY_LIMIT }: { limit?: number } = {}): Promise<any> {
  const body = await readRequestBody(req, { limit });
  if (!body.trim()) return {};
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      return Object.fromEntries(new URLSearchParams(body).entries());
    } catch {
      throw new Error("Invalid form-urlencoded body");
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    try {
      const params = new URLSearchParams(body);
      if (Array.from(params.keys()).length > 0) return Object.fromEntries(params.entries());
    } catch {
      // ignore
    }
    throw new Error("Invalid JSON body");
  }
}

/** Answers 413 and closes the connection so the client cannot keep streaming. */
export function sendPayloadTooLarge(res: http.ServerResponse): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
  res.end(JSON.stringify({ error: "payload_too_large" }));
}
