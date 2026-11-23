import $RefParser from "@apidevtools/json-schema-ref-parser";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export type JsonSchema = Record<string, any>;

export interface Operation {
  method: string; // upper case
  path: string; // as in the spec: /accounts/{accountId}
  operationId?: string;
  summary?: string;
  requestSchema?: JsonSchema;
  /** Lowest 2xx response with a JSON schema, if any. */
  successStatus: number;
  responseSchema?: JsonSchema;
  /** Which CRUD role this operation plays for a resource, or "action" when none fits. */
  role: "list" | "create" | "read" | "update" | "replace" | "delete" | "action";
  resource?: Resource;
  pattern: RegExp;
  paramNames: string[];
}

/**
 * A collection inferred from the paths: `/accounts` + `/accounts/{accountId}`, or a nested one such as
 * `/accounts/{accountId}/transactions`, whose records belong to a parent record.
 */
export interface Resource {
  name: string; // "accounts", "transactions"
  collectionPath: string; // "/accounts/{accountId}/transactions"
  itemParam?: string; // "accountId" in /accounts/{accountId}
  idField: string; // record property holding the id
  itemSchema: JsonSchema;
  parent?: { resource: string; param: string; field: string };
  /** For list responses wrapped in an object: the array property, e.g. "items". */
  listWrapper?: { arrayProp: string; schema: JsonSchema };
}

export interface ApiSpec {
  title: string;
  version: string;
  operations: Operation[];
  resources: Map<string, Resource>;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

export async function loadSpec(file: string): Promise<ApiSpec> {
  const text = await readFile(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return buildSpec(raw);
}

export async function buildSpec(raw: any): Promise<ApiSpec> {
  if (!raw?.openapi && !raw?.swagger) {
    throw new Error("Not an OpenAPI document (missing 'openapi' field)");
  }
  const doc: any = await $RefParser.dereference(structuredClone(raw), { dereference: { circular: "ignore" } });
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const success = pickSuccess(op.responses ?? {});
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary ?? op.description,
        requestSchema: jsonSchemaOf(op.requestBody?.content),
        successStatus: success.status,
        responseSchema: success.schema,
        role: "action",
        pattern: pathPattern(path),
        paramNames: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
      });
    }
  }
  const resources = inferResources(operations);
  return { title: doc.info?.title ?? "API", version: doc.info?.version ?? "", operations, resources };
}

function jsonSchemaOf(content: any): JsonSchema | undefined {
  if (!content) return undefined;
  const key = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content)[0];
  return key ? normalize(content[key]?.schema) : undefined;
}

function pickSuccess(responses: Record<string, any>): { status: number; schema?: JsonSchema } {
  const codes = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).sort();
  if (codes.length === 0) return { status: 200 };
  const withBody = codes.find((c) => jsonSchemaOf(responses[c]?.content));
  const code = withBody ?? codes[0];
  return { status: Number(code), schema: jsonSchemaOf(responses[code]?.content) };
}

/** OpenAPI 3.0 `nullable` → JSON Schema; drops keywords Ajv rejects in strict-off mode anyway. */
function normalize(schema: any): JsonSchema | undefined {
  if (!schema || typeof schema !== "object") return schema;
  const seen = new WeakSet();
  const walk = (s: any) => {
    if (!s || typeof s !== "object" || seen.has(s)) return;
    seen.add(s);
    if (s.nullable === true && typeof s.type === "string") {
      s.type = [s.type, "null"];
      delete s.nullable;
    }
    for (const v of Object.values(s)) walk(v);
  };
  walk(schema);
  return schema;
}

export function pathPattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((seg) => (/^\{.+\}$/.test(seg) ? "([^/]+)" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}/?$`);
}

function inferResources(operations: Operation[]): Map<string, Resource> {
  const resources = new Map<string, Resource>();
  const byPath = new Map<string, Operation[]>();
  for (const op of operations) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);

  // Collection paths end with a literal segment; their item path appends one {param}.
  for (const [path, ops] of byPath) {
    const segments = path.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (!last || last.startsWith("{")) continue;
    const itemPath = [...byPath.keys()].find((p) => p.startsWith(path + "/{") && p.split("/").length === path.split("/").length + 1);
    const itemOps = itemPath ? byPath.get(itemPath)! : [];
    const itemSchema = itemSchemaOf(ops, itemOps);
    if (!itemSchema) continue;

    const itemParam = itemPath?.match(/\{([^}]+)\}$/)?.[1];
    const props = Object.keys(itemSchema.properties ?? {});
    const idField = itemParam && props.includes(itemParam) ? itemParam : props.includes("id") ? "id" : itemParam ?? "id";
    // A name collision between nested collections in different parents: qualify with the parent.
    let name = last;
    const parentParam = segments.length > 1 ? segments.at(-2)?.match(/^\{(.+)\}$/)?.[1] : undefined;
    if (resources.has(name)) name = `${segments.at(-3) ?? "root"}.${last}`;

    const resource: Resource = { name, collectionPath: path, itemParam, idField, itemSchema };
    if (parentParam) {
      // The parent id is stored on the record under the path parameter's name (e.g. accountId).
      resource.parent = { resource: segments.at(-3) ?? "parent", param: parentParam, field: parentParam };
    }
    const listOp = ops.find((o) => o.method === "GET");
    const listSchema = listOp?.responseSchema;
    if (listSchema?.type === "object") {
      const arrayProp = Object.entries<any>(listSchema.properties ?? {}).find(([, s]) => s?.type === "array")?.[0];
      if (arrayProp) resource.listWrapper = { arrayProp, schema: listSchema };
    }
    resources.set(name, resource);

    for (const op of ops) {
      if (op.method === "GET") assign(op, "list", resource);
      if (op.method === "POST") assign(op, "create", resource);
    }
    for (const op of itemOps) {
      const role = ({ GET: "read", PATCH: "update", PUT: "replace", DELETE: "delete" } as const)[
        op.method as "GET" | "PATCH" | "PUT" | "DELETE"
      ];
      if (role) assign(op, role, resource);
    }
  }
  // Resolve parents by path once every resource exists (spec order is arbitrary).
  for (const r of resources.values()) {
    if (!r.parent) continue;
    const parentPath = r.collectionPath.split("/").slice(0, -2).join("/");
    const parent = [...resources.values()].find((p) => p.collectionPath === parentPath);
    if (parent) r.parent.resource = parent.name;
  }
  return resources;
}

function assign(op: Operation, role: Operation["role"], resource: Resource) {
  op.role = role;
  op.resource = resource;
}

function itemSchemaOf(collectionOps: Operation[], itemOps: Operation[]): JsonSchema | undefined {
  const read = itemOps.find((o) => o.method === "GET")?.responseSchema;
  if (read?.type === "object" || read?.properties) return read;
  const list = collectionOps.find((o) => o.method === "GET")?.responseSchema;
  if (list?.type === "array" && list.items) return list.items;
  if (list?.type === "object") {
    const arr = Object.values<any>(list.properties ?? {}).find((s) => s?.type === "array");
    if (arr?.items) return arr.items;
  }
  const created = collectionOps.find((o) => o.method === "POST")?.responseSchema;
  return created?.type === "object" || created?.properties ? created : undefined;
}
