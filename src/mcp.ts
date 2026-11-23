import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MockEngine } from "./engine.js";

const INSTRUCTIONS = `specmock serves a stateful mock of the API described by an OpenAPI spec. The same in-memory
state answers real HTTP clients (the app under development) and these tools, so you can set up a scenario,
let the app run against it, and inspect what the app sent.
Typical flow: describe_api -> list_records / upsert_records to set up data -> add_fault for error paths ->
request_log to see what the app actually called and which requests failed validation.
Writes are validated against the spec's schemas; a rejected write returns the schema errors.`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function createMcpServer(engine: MockEngine, baseUrl: string, version: string): McpServer {
  const server = new McpServer({ name: "specmock", version }, { instructions: INSTRUCTIONS });
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const safely = <A>(fn: (args: A) => unknown | Promise<unknown>) => async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      // Tool errors go back to the model as results so it can correct the call.
      return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };

  server.registerTool("describe_api", {
    title: "Describe the mocked API",
    description: "Operations of the spec (method, path, summary, CRUD role), the resources specmock keeps state for "
      + "with their record counts, and the base URL real clients should call.",
    inputSchema: {},
    annotations: readOnly,
  }, safely(() => ({
    title: engine.spec.title,
    version: engine.spec.version,
    baseUrl,
    resources: Object.entries(engine.counts()).map(([name, count]) => {
      const r = engine.resource(name);
      return { name, path: r.collectionPath, idField: r.idField, parent: r.parent?.resource, records: count,
        fields: Object.keys(r.itemSchema.properties ?? {}) };
    }),
    operations: engine.spec.operations.map((o) => ({
      method: o.method, path: o.path, operationId: o.operationId, summary: o.summary, role: o.role, resource: o.resource?.name,
    })),
  })));

  server.registerTool("call_api", {
    title: "Call the mock API",
    description: "Send a request to the mock exactly as a client would, through validation, faults and state. "
      + "Logged with source 'mcp'.",
    inputSchema: {
      method: z.string().describe("GET, POST, PUT, PATCH or DELETE"),
      path: z.string().describe("Concrete path, e.g. /accounts/3f2a.../transactions"),
      query: z.record(z.string(), z.string()).optional(),
      body: z.any().optional().describe("JSON request body"),
    },
    annotations: writes,
  }, safely(async ({ method, path, query, body }) => engine.handle({ method, path, query, body, source: "mcp" })));

  server.registerTool("list_records", {
    title: "List records",
    description: "Records the mock currently holds for a resource, optionally filtered by exact field values.",
    inputSchema: {
      resource: z.string().describe("Resource name from describe_api, e.g. 'accounts'"),
      where: z.record(z.string(), z.any()).optional().describe("Exact-match filters, e.g. {\"status\": \"FROZEN\"}"),
      limit: z.number().int().positive().max(500).optional(),
    },
    annotations: readOnly,
  }, safely(({ resource, where, limit }) => engine.list(resource, where ?? {}, limit ?? 50)));

  server.registerTool("upsert_records", {
    title: "Create or update records",
    description: "Create records (missing fields are generated) or update existing ones (matched by id field). "
      + "Each result is validated against the resource schema. Use this to set up scenarios: a frozen account, "
      + "a zero balance, a payment stuck in PENDING.",
    inputSchema: {
      resource: z.string(),
      records: z.array(z.record(z.string(), z.any())).min(1).max(200),
    },
    annotations: writes,
  }, safely(({ resource, records }) => engine.upsert(resource, records)));

  server.registerTool("delete_records", {
    title: "Delete records",
    description: "Remove records by id.",
    inputSchema: { resource: z.string(), ids: z.array(z.string()).min(1) },
    annotations: { ...writes, destructiveHint: true },
  }, safely(({ resource, ids }) => ({ deleted: engine.remove(resource, ids) })));

  server.registerTool("reset", {
    title: "Reset to generated seed data",
    description: "Discard all state and regenerate deterministic seed data. Same seed, same data.",
    inputSchema: { seed: z.number().int().optional(), count: z.number().int().min(0).max(100).optional() },
    annotations: { ...writes, destructiveHint: true },
  }, safely(({ seed, count }) => ({ records: engine.reset(seed, count) })));

  server.registerTool("add_fault", {
    title: "Inject a fault",
    description: "Make matching requests fail or slow down: e.g. POST /payments returns 503 for the next 2 calls, "
      + "or every GET /accounts/* takes 3 s. Path may be a spec path (/accounts/{accountId}), a concrete path or a "
      + "glob with *.",
    inputSchema: {
      method: z.string().default("*"),
      path: z.string(),
      status: z.number().int().min(100).max(599).optional().describe("Response status; omit for delay only"),
      body: z.any().optional().describe("Response body for the fault"),
      delay_ms: z.number().int().min(0).max(60000).optional(),
      times: z.number().int().positive().optional().describe("Number of hits; omit for until cleared"),
      probability: z.number().min(0).max(1).optional(),
    },
    annotations: writes,
  }, safely(({ method, path, status, body, delay_ms, times, probability }) =>
    engine.addFault({ method, path, status, body, delayMs: delay_ms, times, probability })));

  server.registerTool("list_faults", {
    title: "List faults",
    description: "Active faults with their hit counts and remaining hits.",
    inputSchema: {},
    annotations: readOnly,
  }, safely(() => engine.listFaults()));

  server.registerTool("clear_faults", {
    title: "Clear faults",
    description: "Remove one fault by id, or all faults.",
    inputSchema: { id: z.string().optional() },
    annotations: writes,
  }, safely(({ id }) => ({ cleared: engine.clearFaults(id) })));

  server.registerTool("request_log", {
    title: "Request log",
    description: "The latest requests the mock received, from real clients and from call_api: method, path, body, "
      + "status, validation errors, injected fault. Use it to debug what an app actually sends.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional(),
      only_errors: z.boolean().optional(),
    },
    annotations: readOnly,
  }, safely(({ limit, only_errors }) => engine.requests(limit ?? 20, only_errors ?? false)));

  server.registerTool("export_state", {
    title: "Export state",
    description: "All records as JSON. Save it and start specmock with --state <file> to replay the scenario.",
    inputSchema: {},
    annotations: readOnly,
  }, safely(() => engine.snapshot()));

  return server;
}
