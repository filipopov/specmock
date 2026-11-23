import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { fake, Random } from "./fake.js";
import type { ApiSpec, JsonSchema, Operation, Resource } from "./spec.js";

export type Json = any;

export interface MockRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: Json;
  /** Who sent it: "http" for real clients, "mcp" when the model calls the API through the tools. */
  source?: "http" | "mcp";
}

export interface MockResponse {
  status: number;
  body?: Json;
  headers?: Record<string, string>;
}

export interface Fault {
  id: string;
  method: string; // "*" for any
  path: string; // a spec path (/payments/{paymentId}), a concrete path, or a glob with *
  status?: number;
  body?: Json;
  delayMs?: number;
  /** Remaining hits; undefined = until cleared. */
  times?: number;
  /** 0..1, default 1. */
  probability?: number;
  hits: number;
}

export interface LogEntry {
  at: string;
  source: "http" | "mcp";
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: Json;
  status: number;
  operation?: string;
  fault?: string;
  error?: Json;
  ms: number;
}

const LOG_SIZE = 200;

export class MockEngine {
  readonly spec: ApiSpec;
  private readonly records = new Map<string, Json[]>();
  private readonly faults: Fault[] = [];
  private readonly log: LogEntry[] = [];
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  private readonly validators = new WeakMap<object, ValidateFunction>();
  private random: Random;
  private faultSeq = 0;
  private counters = new Map<string, number>();

  constructor(spec: ApiSpec, private readonly options: { seed?: number; count?: number } = {}) {
    this.spec = spec;
    // ajv-formats is CommonJS: the plugin is the default export or its .default, depending on the loader.
    const addFormats = ((addFormatsPlugin as any).default ?? addFormatsPlugin) as (ajv: Ajv2020) => void;
    addFormats(this.ajv);
    this.random = new Random(options.seed ?? 42);
    this.reset();
  }

  // ---------------------------------------------------------------- state

  /** Regenerates seed data: `count` records per top-level resource, 1..count per parent for nested ones. */
  reset(seed = this.options.seed ?? 42, count = this.options.count ?? 5): Record<string, number> {
    this.random = new Random(seed);
    this.records.clear();
    this.counters.clear();
    for (const resource of this.ordered()) {
      const list: Json[] = [];
      if (resource.parent) {
        for (const parent of this.records.get(resource.parent.resource) ?? []) {
          const parentId = parent[this.resource(resource.parent.resource).idField];
          for (let i = 0; i < this.random.int(1, count); i++) {
            list.push(this.generate(resource, { [resource.parent.field]: parentId }));
          }
        }
      } else {
        for (let i = 0; i < count; i++) list.push(this.generate(resource));
      }
      this.records.set(resource.name, list);
    }
    return this.counts();
  }

  counts(): Record<string, number> {
    return Object.fromEntries([...this.spec.resources.keys()].map((name) => [name, this.records.get(name)?.length ?? 0]));
  }

  list(name: string, where: Record<string, Json> = {}, limit = 50): Json[] {
    const rows = this.records.get(this.resource(name).name) ?? [];
    return rows.filter((row) => matches(row, where)).slice(0, limit);
  }

  /**
   * Inserts or updates records. Missing fields are generated; the result is validated against the
   * resource schema. Returns the stored records.
   */
  upsert(name: string, input: Json[]): Json[] {
    const resource = this.resource(name);
    const rows = this.records.get(resource.name) ?? [];
    const stored: Json[] = [];
    for (const partial of input) {
      const id = partial?.[resource.idField];
      const existing = id === undefined ? undefined : rows.find((r) => String(r[resource.idField]) === String(id));
      const record = existing ? { ...existing, ...partial } : this.generate(resource, partial);
      const errors = this.validate(resource.itemSchema, record);
      if (errors) throw new Error(`Invalid ${resource.name} record: ${JSON.stringify(errors)}`);
      if (existing) Object.assign(existing, record);
      else rows.push(record);
      stored.push(existing ?? record);
    }
    this.records.set(resource.name, rows);
    return stored;
  }

  remove(name: string, ids: string[]): number {
    const resource = this.resource(name);
    const rows = this.records.get(resource.name) ?? [];
    const keep = rows.filter((r) => !ids.includes(String(r[resource.idField])));
    this.records.set(resource.name, keep);
    return rows.length - keep.length;
  }

  snapshot(): Record<string, Json[]> {
    return structuredClone(Object.fromEntries(this.records));
  }

  restore(state: Record<string, Json[]>): void {
    for (const [name, rows] of Object.entries(state)) this.records.set(this.resource(name).name, structuredClone(rows));
  }

  // ---------------------------------------------------------------- faults and log

  addFault(fault: Omit<Fault, "id" | "hits">): Fault {
    const created: Fault = { ...fault, method: fault.method.toUpperCase(), id: `f${++this.faultSeq}`, hits: 0 };
    this.faults.push(created);
    return created;
  }

  listFaults(): Fault[] {
    return this.faults.map((f) => ({ ...f }));
  }

  clearFaults(id?: string): number {
    const before = this.faults.length;
    const keep = id ? this.faults.filter((f) => f.id !== id) : [];
    this.faults.splice(0, this.faults.length, ...keep);
    return before - this.faults.length;
  }

  requests(limit = 20, onlyErrors = false): LogEntry[] {
    return this.log.filter((e) => !onlyErrors || e.status >= 400).slice(-limit);
  }

  // ---------------------------------------------------------------- HTTP semantics

  async handle(request: MockRequest): Promise<MockResponse> {
    const started = Date.now();
    const method = request.method.toUpperCase();
    const path = request.path.split("?")[0].replace(/\/+$/, "") || "/";
    const entry: LogEntry = {
      at: new Date().toISOString(), source: request.source ?? "http", method, path,
      query: request.query && Object.keys(request.query).length ? request.query : undefined,
      body: request.body, status: 0, ms: 0,
    };
    let response: MockResponse;
    try {
      const op = this.spec.operations.find((o) => o.method === method && o.pattern.test(path));
      entry.operation = op?.operationId ?? (op ? `${op.method} ${op.path}` : undefined);
      const fault = this.matchFault(method, path, op);
      if (fault) {
        entry.fault = fault.id;
        if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      }
      if (fault?.status) {
        response = { status: fault.status, body: fault.body ?? { error: "Injected fault", fault: fault.id } };
      } else if (!op) {
        const pathKnown = this.spec.operations.some((o) => o.pattern.test(path));
        response = pathKnown
          ? { status: 405, body: { error: `${method} not allowed on ${path}` } }
          : { status: 404, body: { error: `No operation for ${method} ${path}` } };
      } else {
        response = this.execute(op, path, request);
      }
    } catch (e) {
      response = { status: 500, body: { error: (e as Error).message } };
    }
    entry.status = response.status;
    if (response.status >= 400) entry.error = response.body;
    entry.ms = Date.now() - started;
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    return response;
  }

  private execute(op: Operation, path: string, request: MockRequest): MockResponse {
    const params = Object.fromEntries(op.paramNames.map((name, i) => [name, decodeURIComponent(op.pattern.exec(path)![i + 1])]));
    if (op.requestSchema && ["POST", "PUT", "PATCH"].includes(op.method)) {
      if (request.body === undefined || request.body === null) {
        return { status: 400, body: { error: "Request body required" } };
      }
      const errors = this.validate(op.requestSchema, request.body);
      if (errors) return { status: 400, body: { error: "Request body does not match the schema", details: errors } };
    }
    const resource = op.resource;
    if (!resource || op.role === "action") {
      return { status: op.successStatus, body: op.responseSchema ? fake(op.responseSchema, this.random) : undefined };
    }
    const rows = this.records.get(resource.name) ?? [];
    const scope = resource.parent ? { [resource.parent.field]: params[resource.parent.param] } : {};
    if (resource.parent && !this.findById(resource.parent.resource, params[resource.parent.param])) {
      return { status: 404, body: { error: `${resource.parent.resource} ${params[resource.parent.param]} not found` } };
    }
    const id = resource.itemParam ? params[resource.itemParam] : undefined;
    const item = id === undefined ? undefined : rows.find((r) => String(r[resource.idField]) === id && matches(r, scope));

    switch (op.role) {
      case "list": {
        const filters = Object.fromEntries(Object.entries(request.query ?? {})
          .filter(([key]) => key in (resource.itemSchema.properties ?? {})));
        const found = rows.filter((r) => matches(r, { ...scope, ...filters }));
        const limit = Number(request.query?.limit ?? request.query?.size ?? found.length);
        const offset = Number(request.query?.offset ?? 0);
        const page = found.slice(offset, offset + limit);
        if (!resource.listWrapper) return { status: op.successStatus, body: page };
        const wrapper = fake(resource.listWrapper.schema, this.random) as Record<string, Json>;
        for (const [key, s] of Object.entries<JsonSchema>(resource.listWrapper.schema.properties ?? {})) {
          if (s?.type === "integer" && /total|count/i.test(key)) wrapper[key] = found.length;
        }
        wrapper[resource.listWrapper.arrayProp] = page;
        return { status: op.successStatus, body: wrapper };
      }
      case "create": {
        const record = this.generate(resource, { ...pick(request.body, resource.itemSchema), ...scope }, true);
        rows.push(record);
        this.records.set(resource.name, rows);
        return { status: op.successStatus, body: record, headers: { Location: `${path}/${record[resource.idField]}` } };
      }
      case "read":
        return item ? { status: op.successStatus, body: item } : notFound(resource, id);
      case "update":
      case "replace": {
        if (!item) return notFound(resource, id);
        const changes = pick(request.body, resource.itemSchema);
        if (op.role === "replace") {
          for (const key of Object.keys(item)) if (key !== resource.idField && !(key in scope) && !(key in changes)) delete item[key];
        }
        Object.assign(item, changes, { [resource.idField]: item[resource.idField] });
        return { status: op.successStatus, body: op.successStatus === 204 ? undefined : item };
      }
      case "delete": {
        if (!item) return notFound(resource, id);
        rows.splice(rows.indexOf(item), 1);
        return { status: op.successStatus };
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  resource(name: string): Resource {
    const resource = this.spec.resources.get(name)
      ?? [...this.spec.resources.values()].find((r) => r.name.endsWith(`.${name}`) || r.collectionPath === name);
    if (!resource) throw new Error(`Unknown resource '${name}'. Known: ${[...this.spec.resources.keys()].join(", ")}`);
    return resource;
  }

  private findById(name: string, id: string): Json | undefined {
    const resource = this.resource(name);
    return (this.records.get(resource.name) ?? []).find((r) => String(r[resource.idField]) === String(id));
  }

  /** Parents before children, so nested resources and *Id references can point at existing records. */
  private ordered(): Resource[] {
    const all = [...this.spec.resources.values()];
    const depth = (r: Resource): number => (r.parent ? 1 + depth(this.resource(r.parent.resource)) : 0);
    const refs = (r: Resource) => this.referencedResources(r).length;
    return all.sort((a, b) => depth(a) - depth(b) || refs(a) - refs(b));
  }

  private generate(resource: Resource, overrides: Json = {}, created = false): Json {
    const record = fake(resource.itemSchema, this.random) as Json;
    record[resource.idField] = this.nextId(resource);
    // Point *Id fields (accountId, fromAccountId) at existing records of the matching resource.
    for (const [field, target] of this.referencedResources(resource)) {
      const candidates = this.records.get(target.name) ?? [];
      if (candidates.length) record[field] = this.random.pick(candidates)[target.idField];
    }
    if (created) {
      for (const [key, s] of Object.entries<JsonSchema>(resource.itemSchema.properties ?? {})) {
        if (s?.format === "date-time" && /created|opened|booked|updated|at$/i.test(key)) record[key] = new Date().toISOString();
      }
    }
    return Object.assign(record, overrides);
  }

  private referencedResources(resource: Resource): [string, Resource][] {
    const out: [string, Resource][] = [];
    for (const field of Object.keys(resource.itemSchema.properties ?? {})) {
      if (field === resource.idField || field === resource.parent?.field || !/Id$/.test(field)) continue;
      const stem = field.slice(0, -2).toLowerCase();
      const target = [...this.spec.resources.values()].find((r) => r !== resource && stem.endsWith(singular(r.name.split(".").at(-1)!)));
      if (target) out.push([field, target]);
    }
    return out;
  }

  private nextId(resource: Resource): Json {
    const idSchema = resource.itemSchema.properties?.[resource.idField];
    if (idSchema?.type === "integer" || idSchema?.type === "number") {
      const next = (this.counters.get(resource.name) ?? 0) + 1;
      this.counters.set(resource.name, next);
      return next;
    }
    return this.random.uuid();
  }

  private validate(schema: JsonSchema, value: Json): Json[] | undefined {
    const validator = this.validators.get(schema) ?? this.ajv.compile(schema);
    this.validators.set(schema, validator);
    return validator(value) ? undefined : (validator.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message, params: e.params }));
  }

  private matchFault(method: string, path: string, op?: Operation): Fault | undefined {
    for (const fault of this.faults) {
      if (fault.times !== undefined && fault.times <= 0) continue;
      if (fault.method !== "*" && fault.method !== method) continue;
      const pathMatches = fault.path === path || fault.path === op?.path || globToRegex(fault.path).test(path);
      if (!pathMatches) continue;
      if (fault.probability !== undefined && this.random.next() >= fault.probability) continue;
      fault.hits++;
      if (fault.times !== undefined) fault.times--;
      return fault;
    }
    return undefined;
  }
}

function matches(row: Json, where: Record<string, Json>): boolean {
  return Object.entries(where).every(([key, value]) => String(row?.[key]) === String(value));
}

function pick(body: Json, schema: JsonSchema): Json {
  if (!body || typeof body !== "object") return {};
  const props = schema.properties;
  return props ? Object.fromEntries(Object.entries(body).filter(([key]) => key in props)) : { ...body };
}

function notFound(resource: Resource, id?: string): MockResponse {
  return { status: 404, body: { error: `${resource.name} ${id} not found` } };
}

function singular(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith("ies")) return n.slice(0, -3) + "y";
  if (n.endsWith("ses")) return n.slice(0, -2);
  return n.endsWith("s") ? n.slice(0, -1) : n;
}

function globToRegex(glob: string): RegExp {
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`);
}
