import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MockEngine } from "./engine.js";

export interface HttpOptions {
  host: string;
  port: number;
  token?: string;
  /** Builds a fresh MCP server per request (stateless streamable HTTP); all share the engine's state. */
  mcp: () => McpServer;
}

const MAX_BODY = 5 * 1024 * 1024;

export function startHttp(engine: MockEngine, options: HttpOptions): Promise<Server> {
  const server = createServer((req, res) => {
    route(engine, options, req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${options.port} is in use; pass --port`) : e));
    server.listen(options.port, options.host, () => resolve(server));
  });
}

async function route(engine: MockEngine, options: HttpOptions, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Browser apps call the mock from another origin during development.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Location, Mcp-Session-Id");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  if (url.pathname === "/__specmock/health") return send(res, 200, { ok: true, resources: engine.counts() });

  const body = await readBody(req);
  if (url.pathname === "/mcp") {
    if (options.token && !authorized(req, url, options.token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return send(res, 401, { error: "Missing or wrong token" });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = options.mcp();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  const response = await engine.handle({
    method: req.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body,
    source: "http",
  });
  for (const [key, value] of Object.entries(response.headers ?? {})) res.setHeader(key, value);
  send(res, response.status, response.body);
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  const given = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON bodies are passed on as text; schema validation will reject them where JSON is expected.
    return text;
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined || status === 204) return void res.writeHead(status).end();
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
