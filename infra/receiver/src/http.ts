// A small HTTP layer on node:http: a router with `:param` paths, body parsing for the three encodings
// SEP-12 clients send (JSON, form-urlencoded, multipart with text fields only), CORS on everything,
// and one error type that handlers throw to answer with a status and a JSON body. Handlers take and
// return plain objects so they can be called from tests without a socket.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
  params: Record<string, string>;
}

export interface Res {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

export type Handler = (req: Req) => Res | Promise<Res>;

export const ok = (json: unknown, status = 200): Res => ({ status, json });

const MAX_BODY_BYTES = 1024 * 1024;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  async dispatch(req: Req): Promise<Res> {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(req.path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      route.keys.forEach((key, i) => (req.params[key] = decodeURIComponent(m[i + 1] ?? '')));
      try {
        return await route.handler(req);
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, json: e.body };
        throw e;
      }
    }
    return pathMatched ? { status: 405, json: { error: 'method not allowed' } } : { status: 404, json: { error: 'not found' } };
  }
}

/** Parses a request body by content type; text fields only, files in multipart bodies are skipped. */
export function parseBody(contentType: string | undefined, raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json' || type === '') {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // reported below
    }
    throw new HttpError(400, { error: 'malformed JSON body' });
  }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  if (type === 'multipart/form-data') {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType ?? '')?.[2];
    if (!boundary) throw new HttpError(400, { error: 'multipart body without boundary' });
    return parseMultipart(raw, boundary);
  }
  throw new HttpError(415, { error: `unsupported content type ${type}` });
}

export function parseMultipart(raw: string, boundary: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const head = part.slice(0, headerEnd);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name || /filename=/i.test(head)) continue;
    out[name] = part.slice(headerEnd + 4).replace(/\r\n$/, '');
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, { error: 'body too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, out: Res): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Demo-Clock-Offset');
  if (out.json !== undefined) {
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.json));
  } else if (out.text !== undefined) {
    res.writeHead(out.status, { 'Content-Type': out.contentType ?? 'text/plain; charset=utf-8' });
    res.end(out.text);
  } else {
    res.writeHead(out.status);
    res.end();
  }
}

async function handle(router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://receiver.local');
  if (method === 'OPTIONS') return send(res, { status: 204 });
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (method !== 'GET' && method !== 'DELETE') body = parseBody(req.headers['content-type'], raw);
  } catch (e) {
    if (e instanceof HttpError) return send(res, { status: e.status, json: e.body });
    throw e;
  }
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  send(res, await router.dispatch({ method, path: url.pathname, query: url.searchParams, headers, body, params: {} }));
}

export function startServer(router: Router, host: string, port: number, onError: (e: unknown) => void): Promise<Server> {
  const server = createServer((req, res) => {
    handle(router, req, res).catch((e: unknown) => {
      onError(e);
      if (!res.headersSent) send(res, { status: 500, json: { error: 'internal error' } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
