import { digest, repoIdentity, requireCondition, validateDeliveryId, validateRef, validateSha } from "./core.ts";
import type { ManifestEnvelope, Stage } from "./types.ts";

const ALLOWED: Record<Stage, Set<string>> = {
  rank: new Set(["winner", "no_candidate", "shortlist"]),
  plan: new Set(["artifact_paths", "artifact_hashes", "plan_revision", "issue", "baseline", "base"]),
  implement: new Set(["candidate_sha", "artifact_paths", "verification", "issue", "base"]),
  closeout: new Set(["status", "delivery_status", "head_sha", "base_sha", "checks"]),
};
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function paths(value: unknown): string[] {
  requireCondition(Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && !item.startsWith("/") && !item.split("/").includes("..")), "artifact_paths must be safe relative paths");
  requireCondition(new Set(value).size === value.length, "artifact_paths must be unique");
  return value as string[];
}
export interface GitPoint { repo: string; ref: string; sha: string }
export function gitPoint(value: unknown, label: string): GitPoint {
  requireCondition(plain(value), `${label} must be a repository/ref/SHA object`);
  requireCondition(Object.keys(value).every((key) => ["repo", "ref", "sha"].includes(key)), `unexpected ${label} fields`);
  requireCondition(typeof value.repo === "string", `${label} repository required`); repoIdentity(value.repo);
  validateRef(value.ref, `${label} ref`); validateSha(value.sha, `${label} SHA`);
  return value as unknown as GitPoint;
}

export function validateManifest(value: unknown, expectedKind?: Stage): ManifestEnvelope {
  requireCondition(plain(value), "manifest object required");
  requireCondition(value.schema_version === 1, "manifest schema_version must be 1");
  requireCondition(typeof value.kind === "string" && value.kind in ALLOWED, "unsupported manifest kind");
  const kind = value.kind as Stage;
  requireCondition(expectedKind === undefined || kind === expectedKind, `manifest kind must be ${expectedKind}`);
  requireCondition(typeof value.delivery_id === "string", "manifest delivery_id required"); validateDeliveryId(value.delivery_id);
  requireCondition(typeof value.repo === "string", "manifest repo required");
  requireCondition(plain(value.result), "manifest result object required");
  requireCondition(Object.keys(value).every((key) => ["schema_version", "kind", "delivery_id", "repo", "result"].includes(key)), "unexpected manifest envelope fields");
  requireCondition(Object.keys(value.result).every((key) => ALLOWED[kind].has(key)), `unexpected ${kind} manifest fields`);
  const result = value.result;
  if (kind === "rank") {
    requireCondition(typeof result.no_candidate === "boolean" || Number.isInteger(result.winner), "rank manifest requires winner or no_candidate");
    if (result.no_candidate === true) requireCondition(result.winner === undefined && (result.shortlist === undefined || Array.isArray(result.shortlist)), "no_candidate cannot include a winner");
    else requireCondition(Number.isInteger(result.winner) && (result.winner as number) > 0, "rank winner must be positive");
    if (result.shortlist !== undefined) requireCondition(Array.isArray(result.shortlist) && result.shortlist.every((item) => Number.isInteger(item) && item > 0), "rank shortlist must contain positive issue numbers");
  } else if (kind === "plan") {
    paths(result.artifact_paths);
    requireCondition(plain(result.artifact_hashes), "plan artifact_hashes object required");
    for (const [path, hash] of Object.entries(result.artifact_hashes)) requireCondition((result.artifact_paths as string[]).includes(path) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash), "invalid plan artifact hash");
    requireCondition(Object.keys(result.artifact_hashes).length === (result.artifact_paths as string[]).length, "every plan artifact requires a digest");
    validateSha(result.plan_revision, "plan_revision"); gitPoint(result.baseline, "baseline");
    if (result.base !== undefined) gitPoint(result.base, "base");
    requireCondition(Number.isInteger(result.issue) && (result.issue as number) > 0, "plan issue must be positive");
  } else if (kind === "implement") {
    paths(result.artifact_paths); validateSha(result.candidate_sha, "candidate_sha"); gitPoint(result.base, "base");
    requireCondition(Number.isInteger(result.issue) && (result.issue as number) > 0, "implementation issue must be positive");
    requireCondition(Array.isArray(result.verification) && result.verification.every((item) => typeof item === "string" && item.length > 0) || plain(result.verification), "implementation verification evidence required");
  } else {
    validateSha(result.head_sha, "closeout head_sha"); validateSha(result.base_sha, "closeout base_sha");
    requireCondition(["READY", "WAITING", "BLOCKED"].includes(result.status as string), "invalid closeout status");
    requireCondition(["READY", "WAITING", "BLOCKED"].includes(result.delivery_status as string), "invalid delivery closeout status");
    requireCondition(Array.isArray(result.checks) && result.checks.length > 0 && result.checks.every((item) => ["success", "pending", "failure", "unknown", "no_required_checks"].includes(item)), "invalid closeout checks");
  }
  return value as unknown as ManifestEnvelope;
}

export function manifestMaterial(manifest: ManifestEnvelope): { digest: string; materialDigest: string } {
  const material = { ...manifest.result };
  if (manifest.kind === "implement") delete material.verification;
  if ((manifest.kind === "plan" || manifest.kind === "implement") && Array.isArray(material.artifact_paths)) material.artifact_paths = [...material.artifact_paths].sort();
  return { digest: digest(manifest), materialDigest: digest(material) };
}
