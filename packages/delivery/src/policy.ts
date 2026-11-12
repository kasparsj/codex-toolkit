import { readFileSync } from "node:fs";
import { canonicalJson, DeliveryError, digest, parseTimestamp, requireCondition, validateRef, validateSha } from "./core.ts";
import type { DeliveryPolicy, PolicySource } from "./types.ts";

function stripComment(line: string): string {
  let quoted = false, escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

function parseValue(source: string): unknown {
  const value = source.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { throw new DeliveryError("invalid policy TOML string"); }
  }
  if (value.startsWith("[")) {
    try { return JSON.parse(value); } catch { throw new DeliveryError("invalid policy TOML array"); }
  }
  throw new DeliveryError(`unsupported policy TOML value: ${value}`);
}

export function parseToml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table = root;
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const heading = /^\[([A-Za-z0-9_.-]+)]$/.exec(line);
    if (heading) {
      table = root;
      for (const key of heading[1]!.split(".")) {
        const prior = table[key];
        requireCondition(prior === undefined || (typeof prior === "object" && prior !== null && !Array.isArray(prior)), `invalid duplicate TOML table at line ${index + 1}`);
        if (prior === undefined) table[key] = {};
        table = table[key] as Record<string, unknown>;
      }
      continue;
    }
    const item = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    requireCondition(item, `invalid policy TOML at line ${index + 1}`);
    requireCondition(!(item[1]! in table), `duplicate policy key ${item[1]}`);
    table[item[1]!] = parseValue(item[2]!);
  }
  return root;
}

function object(value: unknown, label: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label} table missing`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, label: string): string[] {
  requireCondition(Array.isArray(value) && value.every((x) => typeof x === "string" && x.length > 0), `invalid ${label}`);
  return value;
}

export function validatePolicy(value: unknown, source?: PolicySource, now = new Date()): DeliveryPolicy {
  const root = object(value, "policy");
  requireCondition(root.version === 1, "policy version must be 1");
  const delivery = object(root.delivery, "delivery");
  const branches = object(root.branches, "branches");
  const eligibility = object(root.eligibility, "eligibility");
  const approvals = object(root.approvals, "approvals");
  const tracking = root.tracking === undefined ? {} : object(root.tracking, "tracking");
  for (const [table, key] of [[delivery, "final_target"], [branches, "default_parent"], [branches, "plan_template"], [branches, "implementation_template"]] as const) {
    requireCondition(typeof table[key] === "string" && table[key].length > 0, `policy ${key} required`);
  }
  validateRef(delivery.final_target, "final_target");
  validateRef(branches.default_parent, "default_parent");
  requireCondition(delivery.require_github_actions === undefined || typeof delivery.require_github_actions === "boolean", "require_github_actions must be a boolean");
  const maxAge = delivery.policy_max_age_seconds ?? 86400;
  requireCondition(Number.isInteger(maxAge) && (maxAge as number) > 0, "invalid policy_max_age_seconds");
  requireCondition(Number.isInteger(delivery.publisher_id) && (delivery.publisher_id as number) > 0, "publisher_id required");
  const required = strings(eligibility.required_labels ?? [], "required_labels");
  const excluded = strings(eligibility.excluded_labels ?? [], "excluded_labels");
  const prefixes = strings(branches.allowed_parent_prefixes ?? [], "allowed_parent_prefixes");
  if (tracking.review_label !== undefined) requireCondition(typeof tracking.review_label === "string" && tracking.review_label.length > 0, "invalid review_label");
  const normalizedApprovals: Record<string, { minimum: number; reviewer_ids: number[] }> = {};
  for (const stage of ["plan", "implementation"] as const) {
    const config = object(approvals[stage], `approvals.${stage}`);
    requireCondition(Number.isInteger(config.minimum) && (config.minimum as number) >= 0, `approval minimum missing for ${stage}`);
    requireCondition(Array.isArray(config.reviewer_ids) && config.reviewer_ids.every((id) => Number.isInteger(id) && id > 0), `invalid reviewer_ids for ${stage}`);
    const ids = config.reviewer_ids as number[];
    requireCondition(new Set(ids).size === ids.length, `invalid reviewer_ids for ${stage}`);
    requireCondition((config.minimum as number) <= ids.length, `approval minimum exceeds reviewers for ${stage}`);
    normalizedApprovals[stage] = { minimum: config.minimum as number, reviewer_ids: [...ids] };
  }
  const provenance = source ?? object(root._source, "policy _source") as unknown as PolicySource;
  requireCondition(typeof provenance.ref === "string" && /^(refs\/heads\/|refs\/remotes\/origin\/)/.test(provenance.ref), "policy ref must be a remote or local branch ref");
  validateRef(provenance.ref.replace(/^refs\/(?:heads|remotes\/origin)\//, ""), "policy branch ref");
  validateSha(provenance.sha, "policy source SHA");
  requireCondition(/^[0-9a-f]{64}$/.test(provenance.digest), "policy digest must be lowercase SHA-256");
  const fetched = parseTimestamp(provenance.fetched_at, "policy fetched_at");
  requireCondition(fetched <= now.getTime(), "policy fetched_at is in the future");
  requireCondition(now.getTime() - fetched <= (maxAge as number) * 1000, "policy is stale");
  return {
    version: 1,
    delivery: { final_target: delivery.final_target as string, publisher_id: delivery.publisher_id as number, policy_max_age_seconds: maxAge as number, require_github_actions: (delivery.require_github_actions ?? true) as boolean },
    branches: { default_parent: branches.default_parent as string, plan_template: branches.plan_template as string, implementation_template: branches.implementation_template as string, allowed_parent_prefixes: [...prefixes] },
    eligibility: { required_labels: [...required], excluded_labels: [...excluded] },
    tracking: typeof tracking.review_label === "string" ? { review_label: tracking.review_label } : {},
    approvals: { plan: normalizedApprovals.plan!, implementation: normalizedApprovals.implementation! },
    _source: { ...provenance },
  };
}

export interface LoadPolicyOptions { expectedDigest: string; sourceRef: string; sourceSha: string; fetchedAt: string; now?: Date }
export function loadPolicy(path: string, options: LoadPolicyOptions): DeliveryPolicy {
  const raw = readFileSync(path);
  requireCondition(digest(raw) === options.expectedDigest, "policy digest mismatch");
  let parsed: unknown;
  try { parsed = path.endsWith(".json") ? JSON.parse(raw.toString("utf8")) : parseToml(raw.toString("utf8")); }
  catch (error) { if (error instanceof DeliveryError) throw error; throw new DeliveryError(`invalid policy: ${String(error)}`); }
  return validatePolicy(parsed, { ref: options.sourceRef, sha: options.sourceSha, digest: options.expectedDigest, fetched_at: options.fetchedAt }, options.now);
}

export function policyRequirements(policy: DeliveryPolicy, escalation: Partial<Record<"plan" | "implementation", number>> = {}): { plan: number; implementation: number } {
  const result = { plan: policy.approvals.plan.minimum, implementation: policy.approvals.implementation.minimum };
  for (const stage of ["plan", "implementation"] as const) {
    const value = escalation[stage];
    if (value === undefined) continue;
    requireCondition(Number.isInteger(value) && value >= result[stage], "workflow escalation cannot lower policy requirements");
    requireCondition(value <= policy.approvals[stage].reviewer_ids.length, "escalation exceeds reviewers");
    result[stage] = value;
  }
  return result;
}

export function policyIdentity(policy: DeliveryPolicy): string {
  const { _source, ...values } = policy;
  return digest(canonicalJson({ values, source: _source }));
}
