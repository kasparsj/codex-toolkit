import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBoundProfile, loadLocalProfile } from "../src/config.ts";
import { resolveRepository, type RepositoryIdentity } from "../src/repository.ts";

interface Fixture {
  root: string;
  profile: string;
  policy: string;
  foreground: string;
  publisher: string;
  state: string;
  repository: RepositoryIdentity;
}
const codexSettings = { modeId: "auto", featureValues: { plan_mode: false }, options: { approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } };

function protectedWrite(path: string, value: unknown): void {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-config-boundary-")));
  const worktree = join(root, "worktree"), commonDir = join(root, "git-common"), skills = join(root, "skills");
  mkdirSync(worktree, { mode: 0o700 }); mkdirSync(commonDir, { mode: 0o700 }); mkdirSync(skills, { mode: 0o700 });
  const profile = join(root, "profile.json"), policy = join(root, "policy.toml"), foreground = join(root, "foreground.json"), publisher = join(root, "publisher.json"), state = join(root, "state");
  const policySource = `version = 1
[delivery]
final_target = "main"
publisher_id = 7
[branches]
default_parent = "main"
plan_template = "delivery/plan"
implementation_template = "delivery/implementation"
allowed_parent_prefixes = []
[eligibility]
required_labels = []
excluded_labels = []
[approvals.plan]
minimum = 0
reviewer_ids = []
[approvals.implementation]
minimum = 0
reviewer_ids = []
`;
  protectedWrite(policy, policySource);
  protectedWrite(foreground, { schema_version: 1, repository: "owner/repository", repository_id: 42, auto_schedule: false, pr_publication: "off", issue_publication: "off" });
  protectedWrite(publisher, { repo: "owner/repository", repositoryId: 42, login: "fixture", actorId: 7, stateRoot: join(root, "publisher-state"), remoteUrl: "https://github.com/owner/repository.git" });
  protectedWrite(profile, {
    schema_version: 1,
    repository: "owner/repository",
    state_dir: state,
    skills_root: skills,
    policy: { path: policy, ref: "refs/heads/main", sha: "a".repeat(40), digest: createHash("sha256").update(policySource).digest("hex"), fetched_at: new Date().toISOString() },
    foreground_policy: foreground,
    publisher_config: publisher,
    executor: { kind: "executable", argv: [process.execPath, "--experimental-strip-types"], cwd: worktree },
    checker: { argv: [process.execPath, "--version"], cwd: worktree },
  });
  return { root, profile, policy, foreground, publisher, state, repository: { repo: "owner/repository", gitRoot: worktree, commonDir, worktree, branch: "main", head: "b".repeat(40) } };
}

function editJson(path: string, edit: (value: Record<string, any>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  edit(value); protectedWrite(path, value);
}

function gitRepository(root: string, name: string, repo: string): RepositoryIdentity {
  const work = join(root, name); mkdirSync(work, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
  git("init", "-b", "main"); writeFileSync(join(work, "README.md"), `${name}\n`); git("add", "."); git("commit", "-m", "initial"); git("remote", "add", "origin", `https://github.com/${repo}.git`); return resolveRepository(work);
}

test("loadBoundProfile accepts matching protected source and canonical runtime inputs", () => {
  const value = fixture();
  const profile = loadBoundProfile(value.profile, value.repository, value.state);
  assert.equal(profile.repository, value.repository.repo);
  assert.equal(profile.state_dir, value.state);
  assert.equal(profile.executor.kind, "executable");
  if (profile.executor.kind === "executable") assert.equal(profile.executor.argv[0], process.execPath);
});

test("loadBoundProfile rejects profile repository and bound state-root drift", () => {
  const repoDrift = fixture(); editJson(repoDrift.profile, (profile) => { profile.repository = "other/repository"; });
  assert.throws(() => loadBoundProfile(repoDrift.profile, repoDrift.repository, repoDrift.state), /profile repository does not match/);

  const stateDrift = fixture();
  assert.throws(() => loadBoundProfile(stateDrift.profile, stateDrift.repository, join(stateDrift.root, "other-state")), /state root changed/);
});

test("loadBoundProfile rejects foreground repository and repository-ID drift", () => {
  const repoDrift = fixture(); editJson(repoDrift.foreground, (policy) => { policy.repository = "other/repository"; });
  assert.throws(() => loadBoundProfile(repoDrift.profile, repoDrift.repository, repoDrift.state), /foreground policy repository identity mismatch/);

  const idDrift = fixture(); editJson(idDrift.foreground, (policy) => { policy.repository_id = 99; });
  assert.throws(() => loadBoundProfile(idDrift.profile, idDrift.repository, idDrift.state), /repository IDs do not agree/);
});

test("loadBoundProfile rejects publisher repository, repository-ID, and actor-ID drift", () => {
  const repoDrift = fixture(); editJson(repoDrift.publisher, (publisher) => { publisher.repo = "other/repository"; publisher.remoteUrl = "https://github.com/other/repository.git"; });
  assert.throws(() => loadBoundProfile(repoDrift.profile, repoDrift.repository, repoDrift.state), /publisher config repository does not match/);

  const repositoryIdDrift = fixture(); editJson(repositoryIdDrift.publisher, (publisher) => { publisher.repositoryId = 99; });
  assert.throws(() => loadBoundProfile(repositoryIdDrift.profile, repositoryIdDrift.repository, repositoryIdDrift.state), /repository IDs do not agree/);

  const actorIdDrift = fixture(); editJson(actorIdDrift.publisher, (publisher) => { publisher.actorId = 99; });
  assert.throws(() => loadBoundProfile(actorIdDrift.profile, actorIdDrift.repository, actorIdDrift.state), /actor IDs do not agree/);
});

test("protected policy inputs reject relative paths and intermediate symlinks", () => {
  const relative = fixture(); editJson(relative.profile, (profile) => { profile.policy.path = "policy.toml"; });
  assert.throws(() => loadLocalProfile(relative.profile), /policy path must be absolute/);

  const linked = fixture(), alias = join(linked.root, "policy-alias"); symlinkSync(linked.root, alias, "dir");
  editJson(linked.profile, (profile) => { profile.policy.path = join(alias, "policy.toml"); });
  assert.throws(() => loadLocalProfile(linked.profile), /policy path must not traverse symlinks/);
});

test("protected profile and publisher inputs reject intermediate symlinks", () => {
  const profileLinked = fixture(), profileAlias = join(profileLinked.root, "profile-alias"); symlinkSync(profileLinked.root, profileAlias, "dir");
  assert.throws(() => loadLocalProfile(join(profileAlias, "profile.json")), /profile must not traverse symlinks/);

  const publisherLinked = fixture(), publisherAlias = join(publisherLinked.root, "publisher-alias"); symlinkSync(publisherLinked.root, publisherAlias, "dir");
  editJson(publisherLinked.profile, (profile) => { profile.publisher_config = join(publisherAlias, "publisher.json"); });
  assert.throws(() => loadLocalProfile(publisherLinked.profile), /publisher_config must not traverse symlinks/);
});

test("configured Paseo executor and reviewer sources must match the canonical profile repository", () => {
  const executorDrift = fixture(), sourceB = gitRepository(executorDrift.root, "source-b", "other/repository");
  editJson(executorDrift.profile, (profile) => { profile.executor = { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "fixture", repository_path: sourceB.worktree, base_ref: "main", base_sha: sourceB.head, provider: "codex", model: "fixture", ...codexSettings }; });
  assert.throws(() => loadBoundProfile(executorDrift.profile, executorDrift.repository, executorDrift.state), /executor configured source repository does not match/);

  const reviewerDrift = fixture(), reviewerSourceB = gitRepository(reviewerDrift.root, "reviewer-b", "other/repository");
  editJson(reviewerDrift.profile, (profile) => { profile.reviewer = { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "fixture", repository_path: reviewerSourceB.worktree, base_ref: "main", base_sha: reviewerSourceB.head, provider: "codex", model: "fixture", ...codexSettings }; });
  assert.throws(() => loadBoundProfile(reviewerDrift.profile, reviewerDrift.repository, reviewerDrift.state), /reviewer configured source repository does not match/);
});

test("configured Paseo source is independent from same-repository UI clone and detects source drift", () => {
  const value = fixture(), source = gitRepository(value.root, "configured-source", "owner/repository"), uiClone = gitRepository(value.root, "ui-clone", "owner/repository");
  editJson(value.profile, (profile) => { profile.executor = { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "fixture", repository_path: source.worktree, base_ref: "main", base_sha: source.head, provider: "codex", model: "fixture", ...codexSettings }; });
  const loaded = loadBoundProfile(value.profile, uiClone, value.state); assert.equal(loaded.repository, "owner/repository"); assert.notEqual(source.commonDir, uiClone.commonDir);
  execFileSync("git", ["remote", "set-url", "origin", "https://github.com/other/repository.git"], { cwd: source.worktree });
  assert.throws(() => loadBoundProfile(value.profile, uiClone, value.state), /configured source repository does not match/);
});

test("Paseo profiles allow an omitted mode only for non-Codex providers", () => {
  const pi = fixture();
  editJson(pi.profile, (profile) => { profile.executor = { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "fixture", repository_path: pi.repository.worktree, base_ref: "main", base_sha: pi.repository.head, provider: "pi", model: "fixture", featureValues: {}, options: {} }; });
  const loaded = loadLocalProfile(pi.profile);
  assert.equal(loaded.executor.kind, "paseo");
  if (loaded.executor.kind === "paseo") assert.equal(Object.prototype.hasOwnProperty.call(loaded.executor, "modeId"), false);

  const codex = fixture();
  editJson(codex.profile, (profile) => { profile.executor = { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "fixture", repository_path: codex.repository.worktree, base_ref: "main", base_sha: codex.repository.head, provider: "codex", model: "fixture", featureValues: { plan_mode: false }, options: codexSettings.options }; });
  assert.throws(() => loadLocalProfile(codex.profile), /Codex mode must be auto/);

  for (const invalidMode of [null, ""]) {
    const invalid = fixture();
    editJson(invalid.profile, (profile) => { profile.executor = { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "fixture", repository_path: invalid.repository.worktree, base_ref: "main", base_sha: invalid.repository.head, provider: "pi", model: "fixture", modeId: invalidMode, featureValues: {}, options: {} }; });
    assert.throws(() => loadLocalProfile(invalid.profile), /invalid executor Paseo profile/);
  }
});
