import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { MockEngine } from "../src/engine.js";
import { createMcpServer } from "../src/mcp.js";
import { loadSpec, type ApiSpec } from "../src/spec.js";

const spec: ApiSpec = await loadSpec(new URL("../examples/ledger.yaml", import.meta.url).pathname);
let engine: MockEngine;

beforeEach(() => {
  engine = new MockEngine(spec, { seed: 7, count: 4 });
});

describe("spec inference", () => {
  it("finds collections, nested collections and CRUD roles", () => {
    expect([...spec.resources.keys()]).toEqual(["accounts", "transactions", "payments"]);
    const tx = spec.resources.get("transactions")!;
    expect(tx.parent).toEqual({ resource: "accounts", param: "accountId", field: "accountId" });
    expect(spec.resources.get("accounts")!.listWrapper?.arrayProp).toBe("items");
    const roles = Object.fromEntries(spec.operations.map((o) => [o.operationId, o.role]));
    expect(roles).toMatchObject({
      listAccounts: "list", openAccount: "create", getAccount: "read", updateAccount: "update",
      closeAccount: "delete", listTransactions: "list", createPayment: "create",
    });
  });
});

describe("seed data", () => {
  it("is deterministic per seed", () => {
    expect(new MockEngine(spec, { seed: 7, count: 4 }).snapshot()).toEqual(engine.snapshot());
    expect(new MockEngine(spec, { seed: 8, count: 4 }).snapshot()).not.toEqual(engine.snapshot());
  });

  it("links nested records to parents and *Id fields to existing records", () => {
    const accountIds = engine.list("accounts").map((a) => a.id);
    expect(engine.list("transactions").every((t) => accountIds.includes(t.accountId))).toBe(true);
    expect(engine.list("payments").every((p) => accountIds.includes(p.fromAccountId) && accountIds.includes(p.toAccountId))).toBe(true);
  });
});

describe("HTTP semantics", () => {
  it("creates, reads, updates and deletes", async () => {
    const created = await engine.handle({ method: "POST", path: "/accounts", body: { owner: "Mila Novak", currency: "EUR" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ owner: "Mila Novak", currency: "EUR" });
    const id = created.body.id;
    expect(created.headers?.Location).toBe(`/accounts/${id}`);

    expect((await engine.handle({ method: "GET", path: `/accounts/${id}` })).body.owner).toBe("Mila Novak");
    const patched = await engine.handle({ method: "PATCH", path: `/accounts/${id}`, body: { status: "FROZEN" } });
    expect(patched.body).toMatchObject({ id, status: "FROZEN", owner: "Mila Novak" });
    expect((await engine.handle({ method: "DELETE", path: `/accounts/${id}` })).status).toBe(204);
    expect((await engine.handle({ method: "GET", path: `/accounts/${id}` })).status).toBe(404);
  });

  it("filters lists by query fields and fills the wrapper total", async () => {
    engine.upsert("accounts", [{ owner: "Iva Petrov", currency: "USD", status: "CLOSED" }]);
    const res = await engine.handle({ method: "GET", path: "/accounts", query: { status: "CLOSED", currency: "USD" } });
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((a: any) => a.status === "CLOSED" && a.currency === "USD")).toBe(true);
    expect(res.body.total).toBe(res.body.items.length);
  });

  it("scopes nested lists to the parent and 404s on an unknown parent", async () => {
    const account = engine.list("accounts")[0];
    const res = await engine.handle({ method: "GET", path: `/accounts/${account.id}/transactions` });
    expect(res.body.every((t: any) => t.accountId === account.id)).toBe(true);
    expect((await engine.handle({ method: "GET", path: "/accounts/nope/transactions" })).status).toBe(404);
  });

  it("rejects bodies that break the schema with the validation errors", async () => {
    const res = await engine.handle({ method: "POST", path: "/payments", body: { fromAccountId: "a", toAccountId: "b", amount: 0, currency: "GBP" } });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: any) => d.path)).toEqual(expect.arrayContaining(["/amount", "/currency"]));
    expect((await engine.handle({ method: "POST", path: "/accounts" })).status).toBe(400);
  });

  it("answers 404 for unknown paths and 405 for unknown methods", async () => {
    expect((await engine.handle({ method: "GET", path: "/nothing" })).status).toBe(404);
    expect((await engine.handle({ method: "DELETE", path: "/payments" })).status).toBe(405);
  });
});

describe("faults and log", () => {
  it("fails the next N matching calls, then recovers", async () => {
    engine.addFault({ method: "POST", path: "/payments", status: 503, times: 2, body: { error: "down" } });
    const body = { fromAccountId: "a", toAccountId: "b", amount: 5, currency: "EUR" };
    expect((await engine.handle({ method: "POST", path: "/payments", body })).status).toBe(503);
    expect((await engine.handle({ method: "POST", path: "/payments", body })).status).toBe(503);
    expect((await engine.handle({ method: "POST", path: "/payments", body })).status).toBe(201);
    expect(engine.listFaults()[0]).toMatchObject({ hits: 2, times: 0 });
  });

  it("matches faults by spec path template and by glob", async () => {
    const id = engine.list("accounts")[0].id;
    engine.addFault({ method: "GET", path: "/accounts/{accountId}", status: 500 });
    expect((await engine.handle({ method: "GET", path: `/accounts/${id}` })).status).toBe(500);
    engine.clearFaults();
    engine.addFault({ method: "*", path: "/accounts/*/transactions", status: 502 });
    expect((await engine.handle({ method: "GET", path: `/accounts/${id}/transactions` })).status).toBe(502);
    expect((await engine.handle({ method: "GET", path: `/accounts/${id}` })).status).toBe(200);
  });

  it("logs requests with errors and the fault that hit", async () => {
    engine.addFault({ method: "GET", path: "/payments", status: 504, times: 1 });
    await engine.handle({ method: "GET", path: "/payments", source: "http" });
    await engine.handle({ method: "GET", path: "/payments", source: "mcp" });
    const log = engine.requests(10);
    expect(log.map((e) => [e.status, e.source, e.fault])).toEqual([[504, "http", "f1"], [200, "mcp", undefined]]);
    expect(engine.requests(10, true)).toHaveLength(1);
  });
});

describe("state tools", () => {
  it("validates upserts against the resource schema", () => {
    expect(() => engine.upsert("accounts", [{ currency: "GBP" }])).toThrow(/Invalid accounts record/);
    const [stored] = engine.upsert("accounts", [{ owner: "Tim Keller", currency: "CHF", balance: 0, status: "FROZEN" }]);
    expect(engine.list("accounts", { id: stored.id })[0]).toMatchObject({ balance: 0, status: "FROZEN" });
  });

  it("restores an exported snapshot", () => {
    const snapshot = engine.snapshot();
    engine.reset(99, 1);
    engine.restore(snapshot);
    expect(engine.snapshot()).toEqual(snapshot);
  });
});

describe("MCP server", () => {
  it("exposes the tools and shares state with HTTP clients", async () => {
    const server = createMcpServer(engine, "http://127.0.0.1:4010", "test");
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["describe_api", "call_api", "upsert_records", "add_fault", "request_log"]));

    const id = engine.list("accounts")[0].id;
    await client.callTool({ name: "upsert_records", arguments: { resource: "accounts", records: [{ id, status: "FROZEN" }] } });
    expect((await engine.handle({ method: "GET", path: `/accounts/${id}` })).body.status).toBe("FROZEN");

    const bad = await client.callTool({ name: "list_records", arguments: { resource: "nope" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

describe("OpenAPI 3.0 specs", () => {
  it("handles integer ids, nullable fields and unwrapped lists", async () => {
    const { buildSpec } = await import("../src/spec.js");
    const petSpec = await buildSpec({
      openapi: "3.0.3",
      info: { title: "Pets", version: "1" },
      paths: {
        "/pets": {
          get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } } } } },
          post: {
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewPet" } } } },
            responses: { "201": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
          },
        },
        "/pets/{petId}": {
          get: { parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }],
            responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } } },
        },
      },
      components: {
        schemas: {
          NewPet: { type: "object", required: ["name"], properties: { name: { type: "string" }, tag: { type: "string", nullable: true } } },
          Pet: { type: "object", required: ["id", "name"], properties: { id: { type: "integer", format: "int64" }, name: { type: "string" }, tag: { type: "string", nullable: true } } },
        },
      },
    });
    const pets = new MockEngine(petSpec, { count: 3 });
    expect(pets.list("pets").map((p) => p.id)).toEqual([1, 2, 3]);
    const created = await pets.handle({ method: "POST", path: "/pets", body: { name: "Rex", tag: null } });
    expect(created).toMatchObject({ status: 201, body: { id: 4, name: "Rex", tag: null } });
    expect((await pets.handle({ method: "GET", path: "/pets/4" })).body.name).toBe("Rex");
  });
});
