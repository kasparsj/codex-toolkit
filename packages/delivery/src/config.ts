import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { canonicalJson, requireCondition, repoIdentity } from "./core.ts";
import { loadForegroundPolicy } from "./foreground.ts";
import { loadPolicy } from "./policy.ts";
import { Publisher, type PublisherConfig } from "./publisher.ts";
import { resolveRepository, type RepositoryIdentity } from "./repository-identity.ts";

export interface LocalProfile {
  schema_version: 1; repository: string; state_dir: string; skills_root: string;
  policy: { path: string; ref: string; sha: string; digest: string; fetched_at: string };
  foreground_policy: string; publisher_config: string;
  executor: ExecutorProfile;
  checker?: { argv: [string, ...string[]]; cwd: string };
  reviewer?: ExecutorProfile;
}
export type ExecutorProfile = { kind: "executable"; argv: [string, ...string[]]; cwd: string } | { kind: "pi"; executable: string; cwd: string; provider?: string; model?: string; session_dir?: string } | { kind: "paseo"; url: string; host_id: string; repository_path: string; base_ref: string; base_sha: string; provider: string; model: string; modeId?: string; featureValues: Record<string, unknown>; options: Record<string, unknown>; toolPolicy?: { preapproved: Array<{ kind: "mcp"; server: string; tool: string }> } };
export interface ConfiguredRepositorySource { repo: string; repository_path: string; common_dir: string }
export interface ProfileResources { publisher_state_root: string; configured_sources: { executor?: ConfiguredRepositorySource; reviewer?: ConfiguredRepositorySource }; publisher: PublisherConfig }
export interface PublisherResource { publisher_config_path: string; publisher_state_root: string; publisher: PublisherConfig }

function normalizedAbsolute(path: string, label: string): void {
  requireCondition(isAbsolute(path) && resolve(path) === path, `${label} must be absolute, canonical, and normalized`);
}

function ownerControlled(info: Stats): boolean {
  const uid = process.getuid?.();
  if (info.isDirectory() && (info.mode & 0o1000) !== 0) return true;
  if (uid === undefined) return (info.mode & 0o002) === 0;
  if (info.uid === uid) return (info.mode & 0o002) === 0;
  return info.uid === 0 && (info.mode & 0o022) === 0;
}

function canonicalExisting(path: string, label: string, kind: "file" | "directory" | "executable" | "any" = "any"): string {
  normalizedAbsolute(path, label);
  const root = parse(path).root;
  let component = root;
  for (const segment of path.slice(root.length).split("/").filter(Boolean)) {
    component = join(component, segment);
    const info = lstatSync(component);
    requireCondition(!info.isSymbolicLink(), `${label} must not traverse symlinks`);
    requireCondition(ownerControlled(info), `${label} must be owner-controlled`);
  }
  requireCondition(realpathSync(path) === path, `${label} must preserve its canonical path identity`);
  const info = lstatSync(path);
  if (kind === "file") requireCondition(info.isFile(), `${label} must be a regular file`);
  if (kind === "directory") requireCondition(info.isDirectory(), `${label} must be a directory`);
  if (kind === "executable") requireCondition(info.isFile() && (info.mode & 0o111) !== 0, `${label} must be an executable regular file`);
  return path;
}

function protectedFile(path: string, label: string): string {
  canonicalExisting(path, label, "file");
  const info = lstatSync(path);
  const uid = process.getuid?.();
  requireCondition((uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0 && info.size <= 256 * 1024, `${label} must be an owner-only regular file`);
  return path;
}

function privateJson(path: string, label = "profile"): unknown {
  protectedFile(path, label);
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalFuturePath(path: string, label: string): string {
  normalizedAbsolute(path, label);
  if (existsSync(path)) return canonicalExisting(path, label);
  const parent = canonicalExisting(dirname(path), `${label} parent`, "directory");
  return join(parent, basename(path));
}

export function loadLocalProfile(path: string): LocalProfile {
  const value = privateJson(path) as Record<string, unknown>;
  requireCondition(value.schema_version === 1 && typeof value.repository === "string", "invalid local profile"); repoIdentity(value.repository);
  for (const key of ["state_dir", "skills_root", "foreground_policy", "publisher_config"] as const) requireCondition(typeof value[key] === "string", `profile ${key} must be canonical and absolute`);
  value.state_dir = canonicalFuturePath(value.state_dir as string, "profile state_dir");
  value.skills_root = canonicalExisting(value.skills_root as string, "profile skills_root", "directory");
  value.foreground_policy = protectedFile(value.foreground_policy as string, "profile foreground_policy");
  value.publisher_config = protectedFile(value.publisher_config as string, "profile publisher_config");
  const policy = value.policy as Record<string, unknown>;
  requireCondition(policy && typeof policy.path === "string" && typeof policy.ref === "string" && typeof policy.sha === "string" && typeof policy.digest === "string" && typeof policy.fetched_at === "string", "profile policy provenance missing");
  policy.path = protectedFile(policy.path as string, "profile policy path");
  const validateExecutor = (candidate: unknown, label: string): void => {
    const executor = candidate as Record<string, unknown>;
    requireCondition(executor && (executor.kind === "executable" || executor.kind === "pi" || executor.kind === "paseo"), `invalid ${label} profile`);
    if (executor.kind !== "paseo") {
      requireCondition(typeof executor.cwd === "string", `${label} cwd must be canonical and absolute`);
      executor.cwd = canonicalExisting(executor.cwd, `${label} cwd`, "directory");
    }
    if (executor.kind === "executable") {
      requireCondition(Array.isArray(executor.argv) && executor.argv.length > 0 && executor.argv.every((item) => typeof item === "string"), `${label} executable argv requires a canonical absolute executable`);
      executor.argv[0] = canonicalExisting(executor.argv[0] as string, `${label} executable`, "executable");
    } else if (executor.kind === "pi") {
      requireCondition(typeof executor.executable === "string", `${label} Pi executable must be canonical and absolute`);
      executor.executable = canonicalExisting(executor.executable, `${label} Pi executable`, "executable");
    } else {
      requireCondition(typeof executor.url === "string" && /^wss?:\/\//.test(executor.url) && typeof executor.host_id === "string" && typeof executor.repository_path === "string" && typeof executor.base_ref === "string" && typeof executor.base_sha === "string" && /^[0-9a-f]{40}$/.test(executor.base_sha) && typeof executor.provider === "string" && typeof executor.model === "string" && (executor.modeId === undefined || (typeof executor.modeId === "string" && executor.modeId.length > 0)) && executor.featureValues !== null && typeof executor.featureValues === "object" && !Array.isArray(executor.featureValues) && executor.options !== null && typeof executor.options === "object" && !Array.isArray(executor.options), `invalid ${label} Paseo profile`);
      canonicalJson(executor.featureValues); canonicalJson(executor.options);
      requireCondition(executor.toolPolicy === undefined, `${label} Paseo toolPolicy is unsupported because Delivery does not configure MCP servers`);
      const providerName = executor.provider.split("/")[0];
      if (providerName === "codex") {
        requireCondition(executor.modeId === "auto", `${label} Paseo Codex mode must be auto`);
        const features = executor.featureValues as Record<string, unknown>;
        requireCondition(Object.keys(features).every((key) => key === "plan_mode") && (features.plan_mode === undefined || features.plan_mode === false), `${label} Paseo Codex featureValues may only select plan_mode false`);
        requireCondition(canonicalJson(executor.options) === canonicalJson({ approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } }), `${label} Paseo Codex options must select on-request workspace-write with network disabled, no extra roots, and temporary roots excluded`);
      } else requireCondition(Object.keys(executor.options as Record<string, unknown>).length === 0, `${label} Paseo provider ${providerName} native options are unsupported without a validated provider schema`);
      executor.repository_path = canonicalExisting(executor.repository_path, `${label} repository_path`, "directory");
    }
  };
  validateExecutor(value.executor, "executor");
  if (value.reviewer !== undefined) validateExecutor(value.reviewer, "reviewer");
  if (value.checker !== undefined) {
    const checker = value.checker as Record<string, unknown>;
    requireCondition(checker && Array.isArray(checker.argv) && checker.argv.length > 0 && checker.argv.every((item) => typeof item === "string") && typeof checker.cwd === "string", "invalid checker profile");
    checker.argv[0] = canonicalExisting(checker.argv[0] as string, "checker executable", "executable");
    checker.cwd = canonicalExisting(checker.cwd as string, "checker cwd", "directory");
  }
  return value as unknown as LocalProfile;
}

export function profileResources(profile: LocalProfile, repositoryRepo: string): ProfileResources {
  const direct = loadPublisherConfig(profile.publisher_config, repositoryRepo), publisher = direct.publisher, publisherStateRoot = direct.publisher_state_root;
  const source = (candidate: ExecutorProfile, label: string): ConfiguredRepositorySource | undefined => {
    if (candidate.kind !== "paseo") return undefined;
    const identity = resolveRepository(candidate.repository_path);
    requireCondition(identity.repo === repositoryRepo, `${label} configured source repository does not match profile repository`);
    return { repo: identity.repo, repository_path: identity.worktree, common_dir: identity.commonDir };
  };
  const executor = source(profile.executor, "executor"), reviewer = profile.reviewer ? source(profile.reviewer, "reviewer") : undefined;
  return { publisher_state_root: publisherStateRoot, configured_sources: { ...(executor ? { executor } : {}), ...(reviewer ? { reviewer } : {}) }, publisher };
}

export function loadPublisherConfig(path: string, repositoryRepo: string): PublisherResource {
  const canonical = protectedFile(path, "publisher config"), publisher = privateJson(canonical, "publisher config") as PublisherConfig;
  new Publisher(publisher);
  requireCondition(publisher.repo.toLowerCase() === repositoryRepo.toLowerCase(), "publisher config repository does not match workspace repository");
  return { publisher_config_path: canonical, publisher_state_root: canonicalFuturePath(publisher.stateRoot, "publisher state root"), publisher };
}

export function loadBoundProfile(profilePath: string, repository: RepositoryIdentity, expectedStateDir: string): LocalProfile {
  requireCondition(repoIdentity(repository.repo) === `github.com/${repository.repo}` && repository.repo === repository.repo.toLowerCase(), "repository identity must be canonical owner/name");
  for (const [path, label] of [[repository.gitRoot, "repository git root"], [repository.commonDir, "repository common directory"], [repository.worktree, "repository worktree"]] as const) canonicalExisting(path, label, "directory");
  const profile = loadLocalProfile(profilePath);
  requireCondition(profile.repository === repository.repo, "profile repository does not match workspace repository");
  const expected = canonicalFuturePath(expectedStateDir, "expected state directory");
  requireCondition(profile.state_dir === expected, "bound profile state root changed");

  const foreground = loadForegroundPolicy(profile.foreground_policy, repository.repo);
  const policy = loadPolicy(profile.policy.path, { expectedDigest: profile.policy.digest, sourceRef: profile.policy.ref, sourceSha: profile.policy.sha, fetchedAt: profile.policy.fetched_at });
  const publisherValue = profileResources(profile, repository.repo).publisher;
  requireCondition(publisherValue.repo === repository.repo, "publisher config repository does not match workspace repository");
  requireCondition(foreground.repository_id === publisherValue.repositoryId, "foreground and publisher repository IDs do not agree");
  requireCondition(policy.delivery.publisher_id === publisherValue.actorId, "policy and publisher actor IDs do not agree");
  return profile;
}

export function inferRepository(cwd = process.cwd()): string {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const match = /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote); requireCondition(match, "cannot infer a canonical GitHub origin repository"); return `${match[1]}/${match[2]}`.toLowerCase();
}
export function defaultProfilePath(repo: string): string { const [owner, name] = repo.split("/"); return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "codex-toolkit", "foreground", owner!, `${name!}.json`); }
