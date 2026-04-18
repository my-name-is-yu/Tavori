import type * as http from "node:http";

const MAX_BODY_SIZE = 1_048_576;

export function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function writeJsonError(
  res: http.ServerResponse,
  status: number,
  error: string,
  details?: unknown
): void {
  writeJson(res, status, details === undefined ? { error } : { error, details: String(details) });
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_SIZE) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return readBody(req).then((body) => JSON.parse(body) as T);
}
