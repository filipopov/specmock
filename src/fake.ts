import type { JsonSchema } from "./spec.js";

/** Small deterministic PRNG (mulberry32), so the same seed always produces the same data. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(0, 15).toString(16));
    hex[12] = "4";
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

const FIRST = ["Ana", "Luca", "Mila", "Noah", "Sara", "Jonas", "Elena", "Marko", "Lea", "David", "Iva", "Tim"];
const LAST = ["Novak", "Meier", "Rossi", "Popov", "Keller", "Horvat", "Weber", "Costa", "Fischer", "Petrov"];
const WORDS = ["coffee", "rent", "groceries", "salary", "books", "train", "gym", "insurance", "dinner", "refund"];
const CITIES = ["Zurich", "Skopje", "Vienna", "Lisbon", "Berlin", "Ljubljana", "Milan", "Basel"];
const BASE_TIME = Date.UTC(2026, 0, 1);

/** Generates a value that satisfies the schema, using property names as hints (email, iban, amount...). */
export function fake(schema: JsonSchema | undefined, random: Random, name = "", depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (Array.isArray(schema.examples) && schema.examples.length) return structuredClone(random.pick(schema.examples));
  if (Array.isArray(schema.enum)) return random.pick(schema.enum);
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length) return fake(random.pick(variants), random, name, depth + 1);
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((s: JsonSchema) => fake(s, random, name, depth + 1)));
  }

  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  switch (type ?? (schema.properties ? "object" : schema.items ? "array" : "string")) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries<JsonSchema>(schema.properties ?? {})) {
        out[key] = fake(sub, random, key, depth + 1);
      }
      return out;
    }
    case "array": {
      const min = schema.minItems ?? 1;
      const max = Math.max(min, Math.min(schema.maxItems ?? 3, 3));
      return Array.from({ length: random.int(min, max) }, () => fake(schema.items, random, name, depth + 1));
    }
    case "integer":
      return random.int(Math.ceil(lower(schema, 0)), Math.floor(upper(schema, 1000)));
    case "number": {
      const value = lower(schema, 0) + random.next() * (upper(schema, 1000) - lower(schema, 0));
      return Math.round(value * 100) / 100;
    }
    case "boolean":
      return random.next() < 0.5;
    default:
      return fakeString(schema, random, name);
  }
}

function lower(schema: JsonSchema, fallback: number): number {
  if (typeof schema.exclusiveMinimum === "number") return schema.exclusiveMinimum + 0.01;
  return schema.minimum ?? fallback;
}

function upper(schema: JsonSchema, fallback: number): number {
  if (typeof schema.exclusiveMaximum === "number") return schema.exclusiveMaximum - 0.01;
  return schema.maximum ?? Math.max(fallback, lower(schema, 0) + fallback);
}

function fakeString(schema: JsonSchema, random: Random, property: string): string {
  const name = property.toLowerCase();
  const format = schema.format;
  const time = () => new Date(BASE_TIME + random.int(0, 300 * 24 * 3600) * 1000);
  let value: string;
  if (format === "uuid" || name === "id" || /(Id|_id|ID)$/.test(property)) value = random.uuid();
  else if (format === "date-time") value = time().toISOString();
  else if (format === "date") value = time().toISOString().slice(0, 10);
  else if (format === "email" || name.includes("email")) value = `${random.pick(FIRST)}.${random.pick(LAST)}@example.com`.toLowerCase();
  else if (format === "uri" || format === "url" || name.includes("url")) value = `https://example.com/${random.pick(WORDS)}`;
  else if (name.includes("iban")) value = `CH${random.int(10, 99)}0000${String(random.int(0, 999999999999)).padStart(12, "0")}`;
  else if (name.includes("currency")) value = random.pick(["EUR", "CHF", "USD"]);
  else if (name.includes("phone")) value = `+41 7${random.int(5, 9)} ${random.int(100, 999)} ${random.int(10, 99)} ${random.int(10, 99)}`;
  else if (name.includes("city")) value = random.pick(CITIES);
  else if (name.includes("name") || name === "owner" || name.includes("customer")) value = `${random.pick(FIRST)} ${random.pick(LAST)}`;
  else if (name.includes("description") || name.includes("reference") || name.includes("note")) value = `${random.pick(WORDS)} ${random.pick(WORDS)}`;
  else value = `${random.pick(WORDS)}-${random.int(100, 999)}`;

  if (schema.maxLength !== undefined && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
  if (schema.minLength !== undefined && value.length < schema.minLength) value = value.padEnd(schema.minLength, "x");
  return value;
}
