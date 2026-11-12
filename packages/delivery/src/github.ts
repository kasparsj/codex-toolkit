import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeliveryError, requireCondition } from "./core.ts";

const execFileAsync = promisify(execFile);
const API = "https://api.github.com";
const TOKEN = /^[A-Za-z0-9_.-]{1,1024}$/;

export class GitHubUnavailable extends DeliveryError {
  readonly retryAfterSeconds: number;
  constructor(message = "GitHub is temporarily unavailable", retryAfterSeconds = 0) {
    super(message, "GITHUB_UNAVAILABLE"); this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GitHubTransportOptions {
  repo: string;
  token: string;
  baseUrl?: string;
  testOnly?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
}

export interface GhTokenOptions {
  login: string;
  ghPath?: string;
  configDir?: string;
  timeoutMs?: number;
}

export async function resolveGhToken(options: GhTokenOptions): Promise<string> {
  requireCondition(/^[A-Za-z0-9-]{1,39}$/.test(options.login), "invalid selected GitHub login");
  const base: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL"] as const) if (process.env[name]) base[name] = process.env[name];
  base.GH_PROMPT_DISABLED = "1";
  delete base.GH_TOKEN; delete base.GITHUB_TOKEN; delete base.GITHUB_ENTERPRISE_TOKEN;
  if (options.configDir ?? process.env.GH_CONFIG_DIR) base.GH_CONFIG_DIR = options.configDir ?? process.env.GH_CONFIG_DIR;
  const gh = options.ghPath ?? "gh";
  let help: string;
  try {
    ({ stdout: help } = await execFileAsync(gh, ["auth", "token", "--help"], { env: base, timeout: options.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024 }));
  } catch { throw new DeliveryError("GitHub CLI account selection is unavailable", "AUTH_UNAVAILABLE"); }
  requireCondition(/(?<!\S)--user\b/.test(help), "GitHub CLI does not support explicit account selection", "AUTH_UNAVAILABLE");
  const argv = ["auth", "token", "--hostname", "github.com", "--user", options.login];
  if (help.includes("--no-refresh")) argv.push("--no-refresh");
  try {
    const result = await execFileAsync(gh, argv, { env: base, timeout: options.timeoutMs ?? 15_000, maxBuffer: 4096 });
    const token = result.stdout.trim();
    requireCondition(TOKEN.test(token), "selected GitHub CLI credential is invalid", "AUTH_UNAVAILABLE");
    return token;
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError("configured GitHub CLI account is unavailable", "AUTH_UNAVAILABLE");
  }
}

function allowed(repo: string, method: string, path: string): boolean {
  const prefix = `/repos/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  const rules: Array<[string, RegExp]> = [
    ["GET", /^\/user$/], ["GET", new RegExp(`^${prefix}$`)],
    ["GET", new RegExp(`^${prefix}/pulls(?:/[0-9]+)?$`)],
    ["GET", new RegExp(`^${prefix}/pulls/[0-9]+/reviews$`)],
    ["GET", new RegExp(`^${prefix}/issues(?:/[0-9]+)?$`)],
    ["GET", new RegExp(`^${prefix}\/commits\/[0-9a-f]{40}\/check-runs$`)],
    ["GET", new RegExp(`^${prefix}\/commits\/[0-9a-f]{40}\/status$`)],
    ["POST", new RegExp(`^${prefix}\/pulls$`)],
    ["PATCH", new RegExp(`^${prefix}/pulls/[0-9]+$`)],
    ["POST", new RegExp(`^${prefix}\/issues$`)],
  ];
  return rules.some(([verb, expression]) => verb === method && expression.test(path));
}

function retryDelay(headers: Headers, status: number): number {
  const values: number[] = status === 429 ? [60] : [0];
  const retry = headers.get("retry-after");
  if (retry && /^\d+$/.test(retry)) values.push(Number(retry));
  else if (retry && Number.isFinite(Date.parse(retry))) values.push(Math.max(0, (Date.parse(retry) - Date.now()) / 1000));
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) values.push(Math.max(0, reset - Date.now() / 1000));
  }
  return Math.ceil(Math.max(...values));
}

export class GitHubTransport {
  readonly repo: string;
  readonly baseUrl: string;
  #token: string;
  #timeoutMs: number;
  #maxResponseBytes: number;
  #maxPages: number;

  constructor(options: GitHubTransportOptions) {
    requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo), "invalid GitHub repository");
    requireCondition(TOKEN.test(options.token), "invalid GitHub token");
    const base = options.baseUrl ?? API;
    const url = new URL(base);
    if (base !== API) requireCondition(options.testOnly === true && ["127.0.0.1", "::1", "localhost"].includes(url.hostname), "custom GitHub transport is test-only and must be loopback");
    requireCondition(url.protocol === "https:" || options.testOnly === true, "GitHub transport requires HTTPS");
    this.repo = options.repo; this.baseUrl = base.replace(/\/$/, ""); this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 30_000; this.#maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024; this.#maxPages = options.maxPages ?? 100;
  }

  async request(method: "GET" | "POST" | "PATCH", path: string, payload?: Record<string, unknown>): Promise<{ value: unknown; headers: Headers }> {
    const url = new URL(path, `${this.baseUrl}/`);
    requireCondition(url.origin === new URL(this.baseUrl).origin && allowed(this.repo, method, url.pathname), "GitHub operation is outside the local publisher allowlist");
    requireCondition((method === "GET") === (payload === undefined), "invalid GitHub request payload");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { method, redirect: "error", signal: controller.signal, headers: {
        accept: "application/vnd.github+json", authorization: `Bearer ${this.#token}`,
        "x-github-api-version": "2022-11-28", "user-agent": "codex-toolkit-local-publisher",
        ...(payload ? { "content-type": "application/json" } : {}),
      }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (response.status === 429 || response.status >= 500 || response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"))
        throw new GitHubUnavailable("GitHub is temporarily unavailable", retryDelay(response.headers, response.status));
      if (!response.ok) throw new DeliveryError(`GitHub refused the request (${response.status})`, "GITHUB_REFUSED");
      const declared = response.headers.get("content-length");
      if (declared !== null) { const length = Number(declared); requireCondition(Number.isSafeInteger(length) && length >= 0 && length <= this.#maxResponseBytes, "GitHub response exceeds size limit"); }
      requireCondition(response.body !== null, "GitHub response body is missing");
      const chunks: Uint8Array[] = []; let total = 0; const reader = response.body.getReader();
      while (true) {
        const item = await reader.read(); if (item.done) break;
        total += item.value.byteLength; requireCondition(total <= this.#maxResponseBytes, "GitHub response exceeds size limit"); chunks.push(item.value);
      }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new DeliveryError("GitHub returned invalid JSON", "GITHUB_INVALID"); }
      return { value, headers: response.headers };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new GitHubUnavailable(`GitHub request failed: ${error instanceof Error ? error.name : "network error"}`);
    } finally { clearTimeout(timer); }
  }

  async object(method: "GET" | "POST" | "PATCH", path: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { value } = await this.request(method, path, payload);
    requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "GitHub returned an invalid object");
    return value as Record<string, unknown>;
  }

  async pages(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    let next: URL | null = new URL(path, `${this.baseUrl}/`);
    Object.entries({ ...query, per_page: "100" }).forEach(([key, value]) => next!.searchParams.set(key, value));
    for (let page = 0; next && page < this.#maxPages; page += 1) {
      requireCondition(!visited.has(next.href), "GitHub pagination cycle detected"); visited.add(next.href);
      const result = await this.request("GET", next.pathname + next.search);
      requireCondition(Array.isArray(result.value) && result.value.length <= 100 && result.value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item)), "GitHub returned an invalid page");
      rows.push(...result.value as Record<string, unknown>[]);
      const match = /<([^>]+)>;\s*rel="next"/.exec(result.headers.get("link") ?? "");
      if (!match) return rows;
      const candidate = new URL(match[1]!);
      requireCondition(candidate.origin === new URL(this.baseUrl).origin && allowed(this.repo, "GET", candidate.pathname), "GitHub pagination escaped the allowlist");
      next = candidate;
    }
    requireCondition(next === null, "GitHub pagination exceeds page limit");
    return rows;
  }

  async checkRuns(path: string, expectedSha: string): Promise<Record<string, unknown>[]> {
    const endpoint = new URL(path, `${this.baseUrl}/`);
    requireCondition(allowed(this.repo, "GET", endpoint.pathname) && endpoint.search === "", "invalid check-runs endpoint");
    endpoint.searchParams.set("filter", "latest"); endpoint.searchParams.set("per_page", "100");
    const rows: Record<string, unknown>[] = [], ids = new Set<number>(), visited = new Set<string>();
    let next: URL | null = endpoint, expectedTotal: number | undefined;
    const validateUrl = (candidate: URL): void => {
      requireCondition(candidate.origin === endpoint.origin && candidate.pathname === endpoint.pathname, "GitHub check-runs pagination escaped the exact endpoint");
      const keys = [...candidate.searchParams.keys()];
      requireCondition(keys.every((key) => ["filter", "per_page", "page"].includes(key))
        && candidate.searchParams.getAll("filter").length === 1 && candidate.searchParams.get("filter") === "latest"
        && candidate.searchParams.getAll("per_page").length === 1 && candidate.searchParams.get("per_page") === "100"
        && candidate.searchParams.getAll("page").length <= 1, "GitHub check-runs pagination changed query semantics");
      const page = candidate.searchParams.get("page");
      requireCondition(page === null || /^[1-9][0-9]*$/.test(page) && Number.isSafeInteger(Number(page)), "GitHub check-runs pagination has an invalid page");
    };
    for (let page = 0; next && page < this.#maxPages; page += 1) {
      validateUrl(next); requireCondition(!visited.has(next.href), "GitHub pagination cycle detected"); visited.add(next.href);
      const result = await this.request("GET", next.pathname + next.search);
      requireCondition(result.value !== null && typeof result.value === "object" && !Array.isArray(result.value), "GitHub returned an invalid check-runs envelope");
      const envelope = result.value as Record<string, unknown>, total = envelope.total_count, pageRows = envelope.check_runs;
      requireCondition(Number.isSafeInteger(total) && (total as number) >= 0 && Array.isArray(pageRows) && pageRows.length <= 100
        && pageRows.every((item) => item !== null && typeof item === "object" && !Array.isArray(item)), "GitHub returned an invalid check-runs envelope");
      if (expectedTotal === undefined) expectedTotal = total as number;
      else requireCondition(total === expectedTotal, "GitHub check-runs total changed during pagination");
      for (const item of pageRows as Record<string, unknown>[]) {
        requireCondition(Number.isSafeInteger(item.id) && (item.id as number) > 0 && !ids.has(item.id as number), "GitHub check-runs contain an invalid or duplicate ID");
        requireCondition(item.head_sha === expectedSha, "GitHub check-run head differs from the exact candidate");
        ids.add(item.id as number); rows.push(item);
      }
      const links = (result.headers.get("link") ?? "").split(",").map((value) => value.trim()).filter((value) => /;\s*rel="next"(?:\s*;|$)/.test(value));
      requireCondition(links.length <= 1, "GitHub check-runs pagination has ambiguous next links");
      if (!links.length) { next = null; break; }
      requireCondition(pageRows.length > 0 && rows.length < expectedTotal, "GitHub check-runs pagination is inconsistent with the advertised count");
      const match = /^<([^>]+)>;/.exec(links[0]!); requireCondition(match !== null, "GitHub check-runs pagination link is malformed");
      try { next = new URL(match[1]!); } catch { throw new DeliveryError("GitHub check-runs pagination link is malformed", "GITHUB_INVALID"); }
    }
    requireCondition(next === null, "GitHub pagination exceeds page limit");
    requireCondition(expectedTotal !== undefined && rows.length === expectedTotal && ids.size === expectedTotal, "GitHub check-runs collection is incomplete");
    return rows;
  }
}
