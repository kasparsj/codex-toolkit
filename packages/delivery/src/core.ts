import { createHash, randomBytes } from "node:crypto";
import type { JsonValue } from "./types.ts";

export class DeliveryError extends Error {
  readonly code: string;
  constructor(message: string, code = "DELIVERY_BLOCKED") { super(message); this.name = "DeliveryError"; this.code = code; }
}

export function requireCondition(condition: unknown, message: string, code?: string): asserts condition {
  if (!condition) throw new DeliveryError(message, code);
}

function normalized(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), "canonical JSON does not support non-finite numbers");
    return value;
  }
  requireCondition(typeof value === "object", "canonical JSON value is not serializable");
  requireCondition(!seen.has(value), "canonical JSON does not support cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => normalized(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    requireCondition(item !== undefined && typeof item !== "function" && typeof item !== "symbol" && typeof item !== "bigint", `canonical JSON unsupported value at ${key}`);
    result[key] = normalized(item, seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value: unknown): string {
  const encodeString = (input: string): string => JSON.stringify(input).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const encode = (input: JsonValue): string => {
    if (input === null) return "null";
    if (typeof input === "string") return encodeString(input);
    if (typeof input === "number" || typeof input === "boolean") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
    return `{${Object.keys(input).sort().map((key) => `${encodeString(key)}:${encode(input[key]!)}`).join(",")}}`;
  };
  return encode(normalized(value));
}

export function digest(value: unknown): string {
  const bytes = typeof value === "string" || value instanceof Uint8Array ? value : canonicalJson(value);
  return createHash("sha256").update(bytes).digest("hex");
}

const REPO = /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function repoIdentity(repo: string): string {
  requireCondition(REPO.test(repo), "repo must be [host/]owner/name");
  const lower = repo.toLowerCase();
  return lower.split("/").length === 2 ? `github.com/${lower}` : lower;
}

export function validateDeliveryId(value: string): void { requireCondition(DELIVERY_ID.test(value), "invalid delivery ID"); }
export function validateSha(value: unknown, label = "SHA"): asserts value is string { requireCondition(typeof value === "string" && FULL_SHA.test(value), `${label} must be a full lowercase SHA`); }
export function validateRef(value: unknown, label = "ref"): asserts value is string {
  requireCondition(typeof value === "string" && value.length > 0 && !value.startsWith("-") && !value.includes("..") && !/[\s~^:?*[\\]/.test(value) && !value.endsWith(".") && !value.endsWith("/"), `unsafe ${label}: ${JSON.stringify(value)}`);
}
export function utcNow(): string { return new Date().toISOString(); }
export function newToken(bytes = 16): string { return randomBytes(bytes).toString("hex"); }

export function parseTimestamp(value: string, label = "timestamp"): number {
  requireCondition(typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value), `${label} must include timezone`);
  const result = Date.parse(value);
  requireCondition(Number.isFinite(result), `invalid ${label}`);
  return result;
}
