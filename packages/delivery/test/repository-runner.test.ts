import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { digest } from "../src/core.ts";
import { processIdentity, RepositoryRegistry, resolveRepository } from "../src/repository.ts";
import { controlRunner, deliveryRequiresDrain, runnerLaunchEnvironment } from "../src/runner.ts";
import { FileStateStore } from "../src/store.ts";
import { DeliveryEngine } from "../src/engine.ts";
import { loadLocalProfile } from "../src/config.ts";
import { policy } from "./helpers.ts";
import { ForegroundSupervisor } from "../src/foreground.ts";
import { ProposalSpool } from "../src/proposals.ts";

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim(); }

function fixtureRepository(repo = "owner/repository"): { root: string; work: string; sibling: string } {
  const root = mkdtempSync(join(tmpdir(), "delivery-repository-")), work = join(root, "work"), sibling = join(root, "sibling"); mkdirSync(work);
  git(work, "init", "-b", "main"); writeFileSync(join(work, "README.md"), "fixture\n"); git(work, "add", "."); git(work, "commit", "-m", "initial"); git(work, "remote", "add", "origin", `https://github.com/${repo}.git`); git(work, "worktree", "add", "-b", "sibling", sibling); return { root, work, sibling };
}

function profile(root: string, repo = "owner/repository"): string {
  mkdirSync(root, { recursive: true, mode: 0o700 }); root = realpathSync(root);
  const skills = join(root, "skills"), path = join(root, "profile.json"), policyPath = join(root, "policy.toml"), foreground = join(root, "foreground.json"), publisher = join(root, "publisher.json"); mkdirSync(skills, { recursive: true, mode: 0o700 });
  for (const name of ["next-issue", "plan-pr", "implement-plan", "pr-closeout"]) { const directory = join(skills, name); mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`, { mode: 0o600 }); }
  const policySource = `version = 1\n[delivery]\nfinal_target = "main"\npublisher_id = 7\n[branches]\ndefault_parent = "main"\nplan_template = "plan"\nimplementation_template = "impl"\n[eligibility]\nrequired_labels = []\nexcluded_labels = []\n[approvals.plan]\nminimum = 0\nreviewer_ids = []\n[approvals.implementation]\nminimum = 0\nreviewer_ids = []\n`; writeFileSync(policyPath, policySource, { mode: 0o600 });
  writeFileSync(foreground, JSON.stringify({ schema_version: 1, repository: repo, repository_id: 1, auto_schedule: false, pr_publication: "off", issue_publication: "off" }), { mode: 0o600 });
  writeFileSync(publisher, JSON.stringify({ repo, repositoryId: 1, login: "fixture", actorId: 7, stateRoot: join(root, "publisher-state"), remoteUrl: `https://github.com/${repo}.git` }), { mode: 0o600 });
  writeFileSync(path, JSON.stringify({ schema_version: 1, repository: repo, state_dir: join(root, "state"), skills_root: skills, policy: { path: policyPath, ref: "refs/heads/main", sha: "a".repeat(40), digest: digest(policySource), fetched_at: new Date().toISOString() }, foreground_policy: foreground, publisher_config: publisher, executor: { kind: "executable", argv: [process.execPath], cwd: root } }), { mode: 0o600 }); chmodSync(path, 0o600); return path;
}

test("repository identity is shared by linked worktrees and exposes checkout provenance", () => {
  const { work, sibling } = fixtureRepository(), nested = join(work, "nested", "directory"); mkdirSync(nested, { recursive: true }); const first = resolveRepository(nested), second = resolveRepository(sibling);
  assert.equal(first.repo, "owner/repository"); assert.equal(second.repo, first.repo); assert.equal(second.commonDir, first.commonDir); assert.notEqual(second.worktree, first.worktree); assert.equal(first.branch, "main"); assert.equal(second.branch, "sibling");
});

test("repository identity rejects ambiguous and credential-bearing origins", () => {
  const { work } = fixtureRepository(); git(work, "remote", "set-url", "--add", "origin", "https://github.com/other/repository.git"); assert.throws(() => resolveRepository(work), /exactly one origin/);
  git(work, "remote", "set-url", "--delete", "origin", "https://github.com/other/repository.git"); git(work, "remote", "set-url", "origin", "ssh://git@github.com/Owner/Repository.git"); assert.equal(resolveRepository(work).repo, "owner/repository");
  git(work, "remote", "set-url", "origin", "https://token@github.com/owner/repository.git"); assert.throws(() => resolveRepository(work), /credential-bearing/);
});

test("protected profiles reject intermediate symlinks and relative policy assets", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-profile-"))), path = profile(root), alias = join(root, "alias"); symlinkSync(root, alias, "dir");
  assert.throws(() => loadLocalProfile(join(alias, "profile.json")), /must not traverse symlinks/);
  const value = JSON.parse(readFileSync(path, "utf8")); value.policy.path = "policy.toml"; writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  assert.throws(() => loadLocalProfile(path), /must be absolute/);
});

test("repository registry refuses intermediate symlinks without creating through them", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-registry-parent-link-")), target = mkdtempSync(join(tmpdir(), "delivery-registry-parent-target-")), link = join(root, "link"), requested = join(link, "registry");
  chmodSync(target, 0o700); symlinkSync(target, link);
  assert.throws(() => new RepositoryRegistry(requested), /unsafe state path component/);
  assert.equal(existsSync(join(target, "registry")), false);
});

test("repository registry reads do not create an absent root", () => {
  const parent = mkdtempSync(join(tmpdir(), "delivery-registry-read-only-")), root = join(parent, "registry"), registry = new RepositoryRegistry(root);
  assert.equal(registry.readBinding("owner/repository"), undefined);
  assert.equal(registry.readSession("owner/repository").revision, 0);
  assert.equal(existsSync(root), false);
});

test("repository registry operations refuse a replaced root identity", () => {
  const parent = mkdtempSync(join(tmpdir(), "delivery-registry-replaced-root-")), root = join(parent, "registry"), displaced = join(parent, "displaced"), registry = new RepositoryRegistry(root), bindingPath = registry.bindingPath("owner/repository"); registry.writeConfiguration(bindingPath, { unsafe: false });
  renameSync(root, displaced); mkdirSync(root, { mode: 0o700 });
  assert.throws(() => registry.readBinding("owner/repository"), /state directory identity changed/);
  assert.throws(() => registry.writeConfiguration(bindingPath, { unsafe: true }), /state directory identity changed/);
  assert.equal(existsSync(bindingPath), false);
});

test("repository registry reads refuse a child directory replaced by a symlink", () => {
  const { root, work } = fixtureRepository(), registryRoot = join(root, "registry"), registry = new RepositoryRegistry(registryRoot), identity = resolveRepository(work);
  registry.bind(identity, profile(root), 0); const repositories = join(registryRoot, "repositories"), displaced = join(registryRoot, "repositories-displaced"); renameSync(repositories, displaced); symlinkSync(displaced, repositories);
  assert.throws(() => registry.readBinding(identity.repo), /unsafe state path component/);
});

test("registry binds one protected profile and state root across worktrees", () => {
  const { root, work, sibling } = fixtureRepository(), registry = new RepositoryRegistry(join(root, "registry")), path = profile(root), first = resolveRepository(work), second = resolveRepository(sibling);
  const bound = registry.bind(first, path, 0); assert.equal(bound.revision, 1); assert.equal(registry.readBinding(second.repo)?.state_dir, join(realpathSync(root), "state"));
  assert.throws(() => registry.bind(second, profile(join(root, "alternate")), 1), /immutable/); assert.throws(() => registry.bind(second, path, 0), /stale setup revision/);
});

test("concurrent repositories cannot bind one canonical publisher root", async () => {
  const common = realpathSync(mkdtempSync(join(tmpdir(), "delivery-publisher-collision-"))), repoA = fixtureRepository("owner/alpha"), repoB = fixtureRepository("owner/beta"), profileA = profile(join(common, "profile-a"), "owner/alpha"), profileB = profile(join(common, "profile-b"), "owner/beta"), registryRoot = join(common, "registry");
  const publisherA = JSON.parse(readFileSync(JSON.parse(readFileSync(profileA, "utf8")).publisher_config, "utf8")), profileBValue = JSON.parse(readFileSync(profileB, "utf8"));
  const publisherB = JSON.parse(readFileSync(profileBValue.publisher_config, "utf8")); publisherB.stateRoot = publisherA.stateRoot; writeFileSync(profileBValue.publisher_config, JSON.stringify(publisherB), { mode: 0o600 }); chmodSync(profileBValue.publisher_config, 0o600);
  const repositoryUrl = new URL("../src/repository.ts", import.meta.url).href;
  const launch = (work: string, selected: string) => new Promise<{ code: number | null; output: string }>((resolveChild) => { const program = `import{RepositoryRegistry,resolveRepository}from ${JSON.stringify(repositoryUrl)};try{new RepositoryRegistry(${JSON.stringify(registryRoot)}).bind(resolveRepository(${JSON.stringify(work)}),${JSON.stringify(selected)},0);console.log('bound')}catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=2}`; const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; child.stdout!.setEncoding("utf8").on("data", (part) => { output += part; }); child.stderr!.setEncoding("utf8").on("data", (part) => { output += part; }); child.once("exit", (code) => resolveChild({ code, output })); });
  const results = await Promise.all([launch(repoA.work, profileA), launch(repoB.work, profileB)]);
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results)); assert.equal(results.filter((result) => result.code === 2).length, 1, JSON.stringify(results)); assert.match(results.find((result) => result.code === 2)!.output, /publisher state root is already frozen/);
});

test("legacy bindings reserve their protected publisher root before migration", () => {
  const common = realpathSync(mkdtempSync(join(tmpdir(), "delivery-legacy-publisher-collision-"))), repoA = fixtureRepository("owner/legacy"), repoB = fixtureRepository("owner/new"), profileA = profile(join(common, "profile-a"), "owner/legacy"), profileB = profile(join(common, "profile-b"), "owner/new"), registry = new RepositoryRegistry(join(common, "registry"));
  const publisherAPath = JSON.parse(readFileSync(profileA, "utf8")).publisher_config, profileBValue = JSON.parse(readFileSync(profileB, "utf8")), publisherBPath = profileBValue.publisher_config;
  const publisherA = JSON.parse(readFileSync(publisherAPath, "utf8")), publisherB = JSON.parse(readFileSync(publisherBPath, "utf8")); publisherB.stateRoot = publisherA.stateRoot; writeFileSync(publisherBPath, JSON.stringify(publisherB), { mode: 0o600 }); chmodSync(publisherBPath, 0o600);
  const identityA = resolveRepository(repoA.work), localA = loadLocalProfile(profileA), now = new Date().toISOString();
  registry.writeConfiguration(registry.bindingPath(identityA.repo), { schema_version: 1, repo: identityA.repo, revision: 1, profile_path: profileA, state_dir: localA.state_dir, created_at: now, updated_at: now, requests: { initial_setup: "legacy" } });
  assert.throws(() => registry.bind(resolveRepository(repoB.work), profileB, 0), /publisher state root is already frozen for owner\/legacy/);
  assert.equal(registry.readBinding("owner/new"), undefined);
});

test("legacy publisher config drift cannot free its historically protected root", () => {
  const common = realpathSync(mkdtempSync(join(tmpdir(), "delivery-legacy-publisher-drift-"))), repoA = fixtureRepository("owner/legacy-drift"), repoB = fixtureRepository("owner/new-root-claim"), profileA = profile(join(common, "profile-a"), "owner/legacy-drift"), profileB = profile(join(common, "profile-b"), "owner/new-root-claim"), registry = new RepositoryRegistry(join(common, "registry"));
  const identityA = resolveRepository(repoA.work), localA = loadLocalProfile(profileA), publisherAPath = localA.publisher_config, originalPublisher = JSON.parse(readFileSync(publisherAPath, "utf8")), originalRoot = originalPublisher.stateRoot;
  new DeliveryEngine({ store: new FileStateStore(localA.state_dir) }).start({ repo: identityA.repo, issue: 1, deliveryId: "legacy-root-pin", policy: policy(), pinLocations: { profile: profileA, publisher_config: publisherAPath } });
  const now = new Date().toISOString(); registry.writeConfiguration(registry.bindingPath(identityA.repo), { schema_version: 1, repo: identityA.repo, revision: 1, profile_path: profileA, state_dir: localA.state_dir, created_at: now, updated_at: now, requests: {} });
  originalPublisher.stateRoot = join(common, "replacement-root"); writeFileSync(publisherAPath, JSON.stringify(originalPublisher), { mode: 0o600 }); chmodSync(publisherAPath, 0o600);
  const profileBValue = JSON.parse(readFileSync(profileB, "utf8")), publisherBPath = profileBValue.publisher_config, publisherB = JSON.parse(readFileSync(publisherBPath, "utf8")); publisherB.stateRoot = originalRoot; writeFileSync(publisherBPath, JSON.stringify(publisherB), { mode: 0o600 }); chmodSync(publisherBPath, 0o600);
  assert.throws(() => registry.bind(resolveRepository(repoB.work), profileB, 0), /unknown publisher ownership|historical publisher provenance/i);
  assert.equal(registry.readBinding("owner/new-root-claim"), undefined);
});

test("legacy publisher config path drift cannot hide historical root ownership", () => {
  const common = realpathSync(mkdtempSync(join(tmpdir(), "delivery-legacy-publisher-path-drift-"))), repoA = fixtureRepository("owner/legacy-path-drift"), repoB = fixtureRepository("owner/path-root-claim"), profileA = profile(join(common, "profile-a"), "owner/legacy-path-drift"), profileB = profile(join(common, "profile-b"), "owner/path-root-claim"), registry = new RepositoryRegistry(join(common, "registry"));
  const identityA = resolveRepository(repoA.work), profileAValue = JSON.parse(readFileSync(profileA, "utf8")), originalPublisherPath = profileAValue.publisher_config, originalPublisher = JSON.parse(readFileSync(originalPublisherPath, "utf8")), originalRoot = originalPublisher.stateRoot, localA = loadLocalProfile(profileA);
  new DeliveryEngine({ store: new FileStateStore(localA.state_dir) }).start({ repo: identityA.repo, issue: 1, deliveryId: "legacy-path-pin", policy: policy(), pinLocations: { profile: profileA, publisher_config: originalPublisherPath } });
  const now = new Date().toISOString(); registry.writeConfiguration(registry.bindingPath(identityA.repo), { schema_version: 1, repo: identityA.repo, revision: 1, profile_path: profileA, state_dir: localA.state_dir, created_at: now, updated_at: now, requests: {} });
  const replacementPublisherPath = join(common, "profile-a", "replacement-publisher.json"); originalPublisher.stateRoot = join(common, "replacement-root"); writeFileSync(replacementPublisherPath, JSON.stringify(originalPublisher), { mode: 0o600 }); chmodSync(replacementPublisherPath, 0o600); profileAValue.publisher_config = replacementPublisherPath; writeFileSync(profileA, JSON.stringify(profileAValue), { mode: 0o600 }); chmodSync(profileA, 0o600);
  const profileBValue = JSON.parse(readFileSync(profileB, "utf8")), publisherBPath = profileBValue.publisher_config, publisherB = JSON.parse(readFileSync(publisherBPath, "utf8")); publisherB.stateRoot = originalRoot; writeFileSync(publisherBPath, JSON.stringify(publisherB), { mode: 0o600 }); chmodSync(publisherBPath, 0o600);
  assert.throws(() => registry.bind(resolveRepository(repoB.work), profileB, 0), /unknown publisher ownership|historical publisher provenance/i); assert.equal(registry.readBinding("owner/path-root-claim"), undefined);
});

test("legacy admission and repository bind share one publisher-root mutex", async () => {
  const common = realpathSync(mkdtempSync(join(tmpdir(), "delivery-admission-bind-race-"))), repoA = fixtureRepository("owner/admitted"), repoB = fixtureRepository("owner/bound"), profileA = profile(join(common, "profile-a"), "owner/admitted"), profileB = profile(join(common, "profile-b"), "owner/bound"), registryRoot = join(common, "registry"), repositoryUrl = new URL("../src/repository.ts", import.meta.url).href;
  const publisherAPath = JSON.parse(readFileSync(profileA, "utf8")).publisher_config, publisherBPath = JSON.parse(readFileSync(profileB, "utf8")).publisher_config, publisherA = JSON.parse(readFileSync(publisherAPath, "utf8")), publisherB = JSON.parse(readFileSync(publisherBPath, "utf8")); publisherB.stateRoot = publisherA.stateRoot; writeFileSync(publisherBPath, JSON.stringify(publisherB), { mode: 0o600 }); chmodSync(publisherBPath, 0o600);
  const launch = (operation: "admit" | "bind", work: string, selected: string) => new Promise<{ code: number | null; output: string }>((resolveChild) => { const method = operation === "admit" ? `r.admitProfile(i,${JSON.stringify(selected)})` : `r.bind(i,${JSON.stringify(selected)},0)`; const program = `import{RepositoryRegistry,resolveRepository}from ${JSON.stringify(repositoryUrl)};const r=new RepositoryRegistry(${JSON.stringify(registryRoot)}),i=resolveRepository(${JSON.stringify(work)});try{${method};console.log(${JSON.stringify(operation)})}catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=2}`; const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; child.stdout!.setEncoding("utf8").on("data", (part) => { output += part; }); child.stderr!.setEncoding("utf8").on("data", (part) => { output += part; }); child.once("exit", (code) => resolveChild({ code, output })); });
  const results = await Promise.all([launch("admit", repoA.work, profileA), launch("bind", repoB.work, profileB)]); assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results)); assert.equal(results.filter((result) => result.code === 2).length, 1, JSON.stringify(results)); assert.match(results.find((result) => result.code === 2)!.output, /publisher state root is already (admitted|frozen)/);
  const admissionWon = results[0]!.code === 0, registry = new RepositoryRegistry(registryRoot);
  if (admissionWon) { const repeated = registry.admitProfile(resolveRepository(repoA.work), profileA); assert.equal(repeated.admission.repo, "owner/admitted"); assert.throws(() => registry.bind(resolveRepository(repoB.work), profileB, 0), /already admitted/); }
  else assert.throws(() => registry.admitProfile(resolveRepository(repoA.work), profileA), /already frozen/);
});

test("legacy binding migration is explicit and requires protected never-started proof", () => {
  const value = fixtureRepository(), identity = resolveRepository(value.work), selected = profile(value.root), registry = new RepositoryRegistry(join(value.root, "registry")), local = loadLocalProfile(selected), now = new Date().toISOString();
  registry.writeConfiguration(registry.bindingPath(identity.repo), { schema_version: 1, repo: identity.repo, revision: 1, profile_path: selected, state_dir: local.state_dir, created_at: now, updated_at: now, requests: { initial_setup: "legacy" } });
  assert.equal(registry.readBinding(identity.repo)?.publisher_state_root, undefined);
  const migrated = registry.bind(identity, selected, 1, "migration_request_001"); assert.equal(migrated.revision, 2); assert.equal(typeof migrated.publisher_state_root, "string"); assert.equal(migrated.profile_path, selected);

  const changed = fixtureRepository("owner/changed"), changedIdentity = resolveRepository(changed.work), changedProfile = profile(changed.root, "owner/changed"), changedRegistry = new RepositoryRegistry(join(changed.root, "registry")), changedLocal = loadLocalProfile(changedProfile);
  changedRegistry.writeConfiguration(changedRegistry.bindingPath(changedIdentity.repo), { schema_version: 1, repo: changedIdentity.repo, revision: 1, profile_path: changedProfile, state_dir: changedLocal.state_dir, created_at: now, updated_at: now, requests: {} });
  changedRegistry.mutateSession(changedIdentity.repo, 0, (session) => { session.generation = 1; return session; });
  const publisherPath = JSON.parse(readFileSync(changedProfile, "utf8")).publisher_config, publisher = JSON.parse(readFileSync(publisherPath, "utf8")); publisher.stateRoot = join(realpathSync(changed.root), "changed-publisher-root"); writeFileSync(publisherPath, JSON.stringify(publisher), { mode: 0o600 }); chmodSync(publisherPath, 0o600);
  assert.throws(() => changedRegistry.bind(changedIdentity, changedProfile, 1, "migration_changed_001"), /lacks exact historical publisher provenance/);
});

test("legacy binding migration accepts an exact production-hashed historical publisher pin", () => {
  const value = fixtureRepository("owner/historical"), identity = resolveRepository(value.work), selected = profile(value.root, identity.repo), local = loadLocalProfile(selected), registry = new RepositoryRegistry(join(value.root, "registry")), now = new Date().toISOString();
  new DeliveryEngine({ store: new FileStateStore(local.state_dir) }).start({ repo: identity.repo, issue: 1, deliveryId: "historical-pin", policy: policy(), pinLocations: { profile: selected, publisher_config: local.publisher_config } });
  registry.writeConfiguration(registry.bindingPath(identity.repo), { schema_version: 1, repo: identity.repo, revision: 1, profile_path: selected, state_dir: local.state_dir, created_at: now, updated_at: now, requests: {} });
  const migrated = registry.bind(identity, selected, 1, "migration_historical_001");
  assert.equal(migrated.revision, 2);
  assert.equal(typeof migrated.publisher_state_root, "string");
});

test("legacy never-started migration rejects runner, proposal, and publisher residue", () => {
  const legacy = (repo: string, withLedger = true) => {
    const value = fixtureRepository(repo), identity = resolveRepository(value.work), selected = profile(value.root, repo), local = loadLocalProfile(selected), registry = new RepositoryRegistry(join(value.root, "registry")), now = new Date().toISOString();
    registry.writeConfiguration(registry.bindingPath(repo), { schema_version: 1, repo, revision: 1, profile_path: selected, state_dir: local.state_dir, created_at: now, updated_at: now, requests: withLedger ? { initial_setup: "legacy" } : {} });
    return { value, identity, selected, local, registry };
  };
  const missingLedger = legacy("owner/missing-ledger", false);
  assert.throws(() => missingLedger.registry.bind(missingLedger.identity, missingLedger.selected, 1, "migration_missing_ledger"), /never-started provenance/);

  const session = legacy("owner/session-residue"); session.registry.mutateSession(session.identity.repo, 0, (current) => current);
  assert.throws(() => session.registry.bind(session.identity, session.selected, 1, "migration_session_residue"), /never-started provenance/);

  const proposal = legacy("owner/proposal-residue"); new ProposalSpool(new FileStateStore(proposal.local.state_dir)).enqueue({ repo: proposal.identity.repo, repositoryId: 1, actorId: 7, title: "retained", body: "retained" });
  assert.throws(() => proposal.registry.bind(proposal.identity, proposal.selected, 1, "migration_proposal_residue"), /never-started provenance/);

  const publication = legacy("owner/publication-residue"), publisherRoot = JSON.parse(readFileSync(publication.local.publisher_config, "utf8")).stateRoot;
  mkdirSync(join(publisherRoot, "publication-intents"), { recursive: true, mode: 0o700 });
  assert.throws(() => publication.registry.bind(publication.identity, publication.selected, 1, "migration_publication_residue"), /never-started provenance/);
});

test("legacy foreground ownership blocks binding and Start until its clean exit", async () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), profilePath = profile(root), store = new FileStateStore(join(realpathSync(root), "state"));
  const options = { repo: identity.repo, policy: policy(), policyConfig: { schema_version: 1 as const, repository: identity.repo, repository_id: 1, auto_schedule: false, pr_publication: "off" as const, issue_publication: "off" as const }, sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)) };
  const controller = new AbortController(), supervisor = new ForegroundSupervisor({ ...options, engine: new DeliveryEngine({ store }) }), running = supervisor.run(controller.signal), session = join(store.repoDir(identity.repo), "foreground", "session.lock");
  for (let attempt = 0; attempt < 100 && !existsSync(session); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(existsSync(session), true); assert.throws(() => registry.bind(identity, profilePath, 0), /foreground ownership/);
  controller.abort(); await running; assert.equal(existsSync(session), false); registry.bind(identity, profilePath, 0);
  const secondController = new AbortController(), second = new ForegroundSupervisor({ ...options, engine: new DeliveryEngine({ store }) }), secondRun = second.run(secondController.signal);
  for (let attempt = 0; attempt < 100 && !existsSync(session); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => controlRunner({ identity, expectedRevision: 0, requestId: "start-legacy-1", action: "start", issue: 1 }, registry), /foreground ownership/);
  secondController.abort(); await secondRun;
});

test("foreground acquisition and repository binding are linearized by one registry mutex", async () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registryRoot = join(root, "registry"), profilePath = profile(root), store = new FileStateStore(join(realpathSync(root), "state")), session = join(store.repoDir(identity.repo), "foreground", "session.lock"), ready = join(root, "legacy-ready"), release = join(root, "legacy-release"), repositoryUrl = new URL("../src/repository.ts", import.meta.url).href;
  const legacyProgram = `import fs from 'node:fs';import {RepositoryRegistry} from ${JSON.stringify(repositoryUrl)};const registry=new RepositoryRegistry(${JSON.stringify(registryRoot)});const release=registry.withLegacyForegroundGuard(${JSON.stringify(identity.repo)},${JSON.stringify(join(realpathSync(root), "state"))},()=>{fs.mkdirSync(${JSON.stringify(session)},{recursive:true,mode:0o700});fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);});release();`;
  const legacy = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", legacyProgram], { stdio: ["ignore", "ignore", "pipe"] }), legacyExit = new Promise<number | null>((resolve) => legacy.once("exit", resolve)); let legacyError = ""; legacy.stderr.setEncoding("utf8").on("data", (chunk) => { legacyError += chunk; });
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(existsSync(ready), true, legacyError);
  const bindProgram = `import {RepositoryRegistry,resolveRepository} from ${JSON.stringify(repositoryUrl)};try{new RepositoryRegistry(${JSON.stringify(registryRoot)}).bind(resolveRepository(${JSON.stringify(work)}),${JSON.stringify(profilePath)},0);console.log('bound')}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=2}`;
  const binder = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bindProgram], { stdio: ["ignore", "pipe", "pipe"] }), binderExit = new Promise<number | null>((resolve) => binder.once("exit", resolve)); let bindError = ""; binder.stderr.setEncoding("utf8").on("data", (chunk) => { bindError += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(binder.exitCode, null); assert.equal(new RepositoryRegistry(registryRoot).readBinding(identity.repo), undefined);
  writeFileSync(release, "release"); assert.equal(await legacyExit, 0, legacyError); assert.equal(await binderExit, 2); assert.match(bindError, /foreground ownership/); assert.equal(new RepositoryRegistry(registryRoot).readBinding(identity.repo), undefined); rmdirSync(session);
});

test("repository-wide legacy ownership blocks alternate-root setup and releases exactly on clean exit", async () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), legacyRoot = join(root, "legacy-state"), durableProfile = profile(join(root, "durable")), store = new FileStateStore(legacyRoot), controller = new AbortController();
  const supervisor = new ForegroundSupervisor({ engine: new DeliveryEngine({ store }), repo: identity.repo, policy: policy(), policyConfig: { schema_version: 1, repository: identity.repo, repository_id: 1, auto_schedule: false, pr_publication: "off", issue_publication: "off" }, sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)), sessionGuard: (acquire) => registry.withLegacyForegroundGuard(identity.repo, legacyRoot, acquire) });
  const running = supervisor.run(controller.signal);
  for (let attempt = 0; attempt < 100 && !registry.readLegacyForeground(identity.repo); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(registry.readLegacyForeground(identity.repo)?.state_dir, legacyRoot); assert.throws(() => registry.bind(identity, durableProfile, 0), /legacy foreground ownership/); assert.equal(registry.readBinding(identity.repo), undefined);
  controller.abort(); await running; assert.equal(registry.readLegacyForeground(identity.repo), undefined); assert.equal(registry.bind(identity, durableProfile, 0).state_dir, join(realpathSync(root), "durable", "state"));
  registry.writeConfiguration(registry.legacyForegroundPath(identity.repo), { schema_version: 1, repo: identity.repo, state_dir: legacyRoot, pid: process.pid, process_identity: processIdentity(process.pid), token: "ambiguous-owner", started_at: new Date().toISOString() });
  assert.throws(() => controlRunner({ identity, expectedRevision: 0, requestId: "start-global-legacy-1", action: "start", issue: 1 }, registry), /legacy foreground ownership/); assert.equal(registry.readSession(identity.repo).revision, 0);
});

test("clean legacy release preserves the original state root while a delivery is unfinished", () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), stateRoot = join(root, "legacy-continuity"), store = new FileStateStore(stateRoot), active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 1, deliveryId: "legacy-clean-unfinished", policy: policy() });
  const release = registry.withLegacyForegroundGuard(identity.repo, stateRoot, () => undefined); assert.throws(release, /unfinished|unresolved/); assert.equal(registry.readLegacyForeground(identity.repo)?.state_dir, stateRoot); assert.throws(() => registry.bind(identity, profile(join(root, "alternate-continuity")), 0), /legacy foreground ownership/);
  const cancelled = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.status = "cancelled"; state.claim_status = "released"; state.controls.cancelled = true; return state; }); store.release(cancelled); release(); assert.equal(registry.readLegacyForeground(identity.repo), undefined); assert.ok(registry.bind(identity, profile(join(root, "alternate-continuity")), 0));
});

test("two alternate-root legacy foregrounds race to one repository-wide owner", async () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), roots = [join(root, "legacy-a"), join(root, "legacy-b")], controllers = [new AbortController(), new AbortController()];
  const supervisors = roots.map((stateRoot) => new ForegroundSupervisor({ engine: new DeliveryEngine({ store: new FileStateStore(stateRoot) }), repo: identity.repo, policy: policy(), policyConfig: { schema_version: 1, repository: identity.repo, repository_id: 1, auto_schedule: false, pr_publication: "off", issue_publication: "off" }, sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)), sessionGuard: (acquire) => registry.withLegacyForegroundGuard(identity.repo, stateRoot, acquire) }));
  const runs = supervisors.map((supervisor, index) => supervisor.run(controllers[index]!.signal));
  for (let attempt = 0; attempt < 100 && !registry.readLegacyForeground(identity.repo); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const owner = registry.readLegacyForeground(identity.repo); assert.ok(owner); assert.equal(roots.includes(owner.state_dir), true); controllers[roots.indexOf(owner.state_dir)]!.abort();
  const results = await Promise.allSettled(runs); assert.equal(results.filter((result) => result.status === "fulfilled").length, 1); const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected"); assert.ok(rejected); assert.match(String(rejected.reason), /legacy foreground ownership/); assert.equal(registry.readLegacyForeground(identity.repo), undefined);
});

test("killed legacy ownership stays blocked until explicit proven-loss recovery", async () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registryRoot = join(root, "registry"), registry = new RepositoryRegistry(registryRoot), stateRoot = join(root, "legacy-crash"), ready = join(root, "legacy-crash-ready"), repositoryUrl = new URL("../src/repository.ts", import.meta.url).href, storeUrl = new URL("../src/store.ts", import.meta.url).href, foregroundUrl = new URL("../src/foreground.ts", import.meta.url).href, cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const program = `import fs from'node:fs';import{RepositoryRegistry,processIdentity}from${JSON.stringify(repositoryUrl)};import{FileStateStore}from${JSON.stringify(storeUrl)};import{foregroundSessionPath}from${JSON.stringify(foregroundUrl)};const repo=${JSON.stringify(identity.repo)},state=${JSON.stringify(stateRoot)},store=new FileStateStore(state),registry=new RepositoryRegistry(${JSON.stringify(registryRoot)});registry.withLegacyForegroundGuard(repo,state,()=>{const session=foregroundSessionPath(store,repo);fs.mkdirSync(session,{recursive:true,mode:0o700});store.writeProtected(session+'/owner.json',{schema_version:1,repo,pid:process.pid,process_identity:processIdentity(process.pid),token:'local-owner',started_at:new Date().toISOString()});fs.writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60_000);});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: ["ignore", "ignore", "pipe"] }), exited = new Promise<number | null>((resolve) => child.once("exit", resolve)); let childError = ""; child.stderr.setEncoding("utf8").on("data", (chunk) => { childError += chunk; });
  const readyDeadline = Date.now() + 15_000;
  while (!existsSync(ready) && child.exitCode === null && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!existsSync(ready)) { if (child.exitCode === null) child.kill("SIGKILL"); await exited; assert.fail(childError || "legacy fixture exited or did not establish ownership before the readiness deadline"); }
  const invoke = (requestId: string) => spawnSync(process.execPath, ["--experimental-strip-types", cli, "runner-control", "--directory", work, "--expected-revision", "0", "--request-id", requestId, "--action", "recover"], { encoding: "utf8", env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot } });
  const live = invoke("legacy-live-recover-1"); assert.equal(live.status, 2, live.stderr); assert.match(JSON.parse(live.stdout).error.message, /still alive|proven lost/); assert.ok(registry.readLegacyForeground(identity.repo));
  child.kill("SIGKILL"); await exited;
  const store = new FileStateStore(stateRoot), active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 1, deliveryId: "legacy-unfinished", policy: policy() }), blocked = invoke("legacy-dead-recover-1"); assert.equal(blocked.status, 2, blocked.stderr); assert.match(JSON.parse(blocked.stdout).error.message, /unfinished|unresolved/); assert.ok(registry.readLegacyForeground(identity.repo));
  const released = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.status = "cancelled"; state.claim_status = "released"; state.controls.cancelled = true; return state; }); store.release(released);
  const recovered = invoke("legacy-dead-recover-2"); assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`); assert.equal(registry.readLegacyForeground(identity.repo), undefined); assert.equal(invoke("legacy-dead-recover-2").status, 0); assert.ok(registry.bind(identity, profile(join(root, "durable-after-crash")), 0));
});

test("runner controls are revision fenced, idempotent and distinguish pause from stop", () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry"));
  registry.bind(identity, profile(root), 0);
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("fixture"); session.heartbeat_at = new Date().toISOString(); return session; });
  const pausing = controlRunner({ identity, expectedRevision: 1, requestId: "pause-request-1", action: "pause" }, registry); assert.equal(pausing.status, "pausing"); assert.equal(pausing.desired_state, "paused");
  assert.equal(controlRunner({ identity, expectedRevision: 1, requestId: "pause-request-1", action: "pause" }, registry).revision, pausing.revision);
  assert.throws(() => controlRunner({ identity, expectedRevision: pausing.revision, requestId: "pause-request-1", action: "stop" }, registry), /different runner input/);
  const paused = registry.mutateSession(identity.repo, pausing.revision, (session) => { session.status = "paused"; return session; });
  const resumed = controlRunner({ identity, expectedRevision: paused.revision, requestId: "resume-request-1", action: "resume" }, registry); assert.equal(resumed.status, "running");
  const stopping = controlRunner({ identity, expectedRevision: resumed.revision, requestId: "stop-request-1", action: "stop" }, registry); assert.equal(stopping.status, "stopping"); assert.equal(stopping.owner_pid, process.pid);
});

test("runner child preserves selected GitHub config without forwarding ambient tokens", () => {
  const environment = runnerLaunchEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME, GH_CONFIG_DIR: "/protected/gh-config", GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github", GITHUB_ENTERPRISE_TOKEN: "ambient-enterprise" });
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({config:process.env.GH_CONFIG_DIR,gh:process.env.GH_TOKEN,github:process.env.GITHUB_TOKEN,enterprise:process.env.GITHUB_ENTERPRISE_TOKEN}))"], { encoding: "utf8", env: environment });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), { config: "/protected/gh-config" });
});

test("Stop drain detection includes an independently running reviewer", () => {
  const state = new DeliveryEngine({ store: new FileStateStore(realpathSync(mkdtempSync(join(tmpdir(), "delivery-reviewer-drain-")))) }).start({ repo: "owner/reviewer-drain", issue: 1, deliveryId: "reviewer-drain", policy: policy() });
  state.runner.status = "idle"; state.executions.push({ id: "reviewer-task", kind: "reviewer", stage: "engineering_review", status: "running", external_id: "reviewer-external", started_at: new Date().toISOString() });
  assert.equal(deliveryRequiresDrain(state), true);
});

test("Stop drain detection excludes only authenticated terminal handled observations", () => {
  const state = new DeliveryEngine({ store: new FileStateStore(realpathSync(mkdtempSync(join(tmpdir(), "delivery-handled-drain-")))) }).start({ repo: "owner/handled-drain", issue: 1, deliveryId: "handled-drain", policy: policy() });
  state.runner.status = "failed";
  state.executions.push({
    id: "handled-task", kind: "agent", stage: "rank", status: "uncertain", external_id: "pi:v1:handled-reference", started_at: new Date().toISOString(),
    effect: "unknown", terminal: "failed", provider: "pi", proof: { kind: "no_ordinary_run", reference: "handled-reference" }, proof_digest: "a".repeat(64),
  });
  assert.equal(deliveryRequiresDrain(state), false);
  delete state.executions[0]!.proof_digest; assert.equal(deliveryRequiresDrain(state), true, "unproven uncertainty must keep Stop draining");
  state.executions[0]!.proof_digest = "a".repeat(64); state.executions[0]!.terminal = "nonterminal"; assert.equal(deliveryRequiresDrain(state), true, "nonterminal uncertainty must keep Stop draining");
  state.executions[0]!.terminal = "failed"; state.executions[0]!.proof!.kind = "process_exit"; assert.equal(deliveryRequiresDrain(state), true, "generic terminal uncertainty must keep Stop draining");
});

test("a runner that dies before PID acknowledgment becomes explicitly lost", () => {
  const registry = new RepositoryRegistry(realpathSync(mkdtempSync(join(tmpdir(), "delivery-preack-"))));
  const session = registry.mutateSession("owner/repository", 0, (value) => { value.status = "starting"; value.desired_state = "running"; value.owner_started_at = new Date(0).toISOString(); return value; });
  assert.deepEqual(registry.observe(session), { status: "uncertain", observedState: "lost" });
});

test("ambiguous mutation locks fail closed instead of stale-PID stealing", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-lock-")), store = new FileStateStore(root), repo = "owner/repository", lock = join(store.repoDir(repo), ".mutation.lock"); mkdirSync(lock, { recursive: true, mode: 0o700 }); store.writeProtected(join(lock, "owner.json"), { pid: 99999999, process_identity: "definitely-dead", token: "dead", at: new Date(0).toISOString() });
  assert.throws(() => store.withRepoLock(repo, () => undefined, 40), /timed out/); assert.equal(new FileStateStore(root).readProtected(join(lock, "owner.json")).token, "dead"); assert.equal(store.recoverRepoLock(repo), true); assert.equal(store.withRepoLock(repo, () => "recovered"), "recovered");
});

test("workspace CLI setup is idempotent, repository scoped, and never starts a runner", () => {
  const { root, work } = fixtureRepository(), registryRoot = join(root, "registry"), profilePath = profile(root), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const invoke = (args: string[], input?: unknown) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8", input: input ? JSON.stringify(input) : undefined, env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot } });
  const before = invoke(["workspace-status", "--directory", work]); assert.equal(before.status, 0, before.stderr); assert.equal(JSON.parse(before.stdout).data.setup.configured, false); assert.equal(JSON.parse(before.stdout).data.runner.status, "stopped");
  const command = ["workspace-setup", "--directory", work, "--expected-revision", "0", "--request-id", "setup-request-1"];
  const saved = invoke(command, { mode: "import", profilePath }); assert.equal(saved.status, 0, saved.stderr); const data = JSON.parse(saved.stdout).data; assert.equal(data.setup.configured, true); assert.equal(data.setup.revision, 1); assert.equal(data.runner.status, "stopped"); assert.deepEqual(data.runs, []);
  const replay = invoke(command, { mode: "import", profilePath }); assert.equal(replay.status, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).data.setup.revision, 1);
});

test("profile-free publisher commands cannot bypass repository root admission", () => {
  const common = realpathSync(mkdtempSync(join(tmpdir(), "delivery-cli-publisher-admission-"))), repoA = fixtureRepository("owner/admitted-cli"), repoB = fixtureRepository("owner/profile-free-cli"), profileA = profile(join(common, "profile-a"), "owner/admitted-cli"), profileB = profile(join(common, "profile-b"), "owner/profile-free-cli"), registryRoot = join(common, "registry"), registry = new RepositoryRegistry(registryRoot), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  registry.bind(resolveRepository(repoA.work), profileA, 0);
  const profileAValue = JSON.parse(readFileSync(profileA, "utf8")), profileBValue = JSON.parse(readFileSync(profileB, "utf8")), publisherA = JSON.parse(readFileSync(profileAValue.publisher_config, "utf8")), publisherB = JSON.parse(readFileSync(profileBValue.publisher_config, "utf8"));
  publisherB.stateRoot = publisherA.stateRoot; writeFileSync(profileBValue.publisher_config, JSON.stringify(publisherB), { mode: 0o600 }); chmodSync(profileBValue.publisher_config, 0o600);
  const base = ["--state-dir", profileBValue.state_dir, "--repo", "owner/profile-free-cli", "--delivery-id", "missing-delivery", "--publisher-config", profileBValue.publisher_config, "--expected-revision", "1"];
  const commands = [
    ["publish-plan", ...base, "--digest", "a".repeat(64)],
    ["publish-implementation", ...base, "--digest", "a".repeat(64)],
    ["export-handoff", ...base, "--stage", "plan"],
    ["bind-manual-pr", ...base, "--stage", "plan", "--number", "1"],
    ["cancel", ...base, "--request-id", "profile_free_cancel_001"],
  ];
  for (const command of commands) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...command], { cwd: repoB.work, encoding: "utf8", env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-grant" } });
    assert.equal(result.status, 2, `${command[0]}\n${result.stdout}\n${result.stderr}`);
    assert.match(JSON.parse(result.stdout).error.message, /publisher state root is already frozen for owner\/admitted-cli/, command[0]);
  }
});

test("workspace import rejects unattended scheduling before immutable binding", () => {
  const { root, work } = fixtureRepository(), registryRoot = join(root, "registry"), profilePath = profile(root), value = JSON.parse(readFileSync(profilePath, "utf8")), foreground = JSON.parse(readFileSync(value.foreground_policy, "utf8")), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url)); foreground.auto_schedule = true; writeFileSync(value.foreground_policy, JSON.stringify(foreground), { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-setup", "--directory", work, "--expected-revision", "0", "--request-id", "setup-auto-1"], { encoding: "utf8", input: JSON.stringify({ mode: "import", profilePath }), env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot } });
  assert.equal(result.status, 2, result.stderr); assert.match(JSON.parse(result.stdout).error.message, /unattended scheduling off/); assert.equal(new RepositoryRegistry(registryRoot).readBinding("owner/repository"), undefined);
});

test("workspace import rejects an unsafe publisher state root before binding", () => {
  const { root, work } = fixtureRepository(), registryRoot = join(root, "registry"), profilePath = profile(root), value = JSON.parse(readFileSync(profilePath, "utf8")), publisher = JSON.parse(readFileSync(value.publisher_config, "utf8")), unsafeTarget = join(root, "publisher-state-target"), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  mkdirSync(unsafeTarget, { mode: 0o700 }); symlinkSync(unsafeTarget, publisher.stateRoot, "dir");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-setup", "--directory", work, "--expected-revision", "0", "--request-id", "setup-publisher-root-1"], { encoding: "utf8", input: JSON.stringify({ mode: "import", profilePath }), env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot } });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`); assert.match(JSON.parse(result.stdout).error.message, /publisher state root|symlink|unsafe/i); assert.equal(new RepositoryRegistry(registryRoot).readBinding("owner/repository"), undefined);
});

test("workspace mutation rejects a stale repository scope even when revisions coincide", () => {
  const { root, work } = fixtureRepository(), registryRoot = join(root, "registry"), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url)), environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot };
  const before = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-status", "--directory", work], { encoding: "utf8", env: environment }); assert.equal(before.status, 0, before.stderr); const scope = JSON.parse(before.stdout).data.scopeDigest;
  git(work, "remote", "set-url", "origin", "https://github.com/Other/Repository.git");
  const stale = spawnSync(process.execPath, ["--experimental-strip-types", cli, "runner-control", "--directory", work, "--expected-revision", "0", "--expected-scope", scope, "--request-id", "scope-change-1", "--action", "start"], { encoding: "utf8", env: environment }); assert.equal(stale.status, 2, stale.stderr); assert.equal(JSON.parse(stale.stdout).error.code, "SCOPE_CHANGED"); assert.equal(new RepositoryRegistry(registryRoot).readSession("other/repository").revision, 0);
});

test("structured create setup succeeds from a fresh empty registry", () => {
  const { root, work } = fixtureRepository(), sourceProfile = profile(root), source = JSON.parse(readFileSync(sourceProfile, "utf8")), executorPath = join(realpathSync(root), "executor.json"), registryRoot = join(realpathSync(root), "fresh-registry"), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url)); writeFileSync(executorPath, JSON.stringify(source.executor), { mode: 0o600 });
  const createInput = { mode: "create", policyPath: source.policy.path, policy: { ref: source.policy.ref, sha: source.policy.sha, digest: source.policy.digest, fetched_at: source.policy.fetched_at }, skillsRoot: source.skills_root, publisherConfigPath: source.publisher_config, executorConfigPath: executorPath, allowedPaths: { plan: ["docs/delivery-plan.md"], implementation: ["packages/delivery"] } };
  const unsafe = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-setup", "--directory", work, "--expected-revision", "0", "--request-id", "create-unsafe-1"], { encoding: "utf8", input: JSON.stringify({ ...createInput, allowedPaths: { ...createInput.allowedPaths, plan: ["../outside"] } }), env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot } }); assert.equal(unsafe.status, 64, unsafe.stderr); assert.equal(new RepositoryRegistry(registryRoot).readBinding("owner/repository"), undefined);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-setup", "--directory", work, "--expected-revision", "0", "--request-id", "create-request-1"], { encoding: "utf8", input: JSON.stringify(createInput), env: { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); const data = JSON.parse(result.stdout).data; assert.equal(data.setup.configured, true); assert.equal(data.runner.status, "stopped"); assert.deepEqual(data.runs, []);
  const binding = new RepositoryRegistry(registryRoot).readBinding("owner/repository"); assert.ok(binding); const createdProfile = JSON.parse(readFileSync(binding.profile_path, "utf8")), createdForeground = JSON.parse(readFileSync(createdProfile.foreground_policy, "utf8")); assert.deepEqual(createdForeground.allowed_paths, { plan: ["docs/delivery-plan.md"], implementation: ["packages/delivery"] });
});

test("Start refuses an unfinished repository claim instead of silently adopting it", () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), profilePath = profile(root); registry.bind(identity, profilePath, 0);
  const store = new FileStateStore(join(root, "state")); new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 1, deliveryId: "unfinished", policy: policy() });
  assert.throws(() => controlRunner({ identity, expectedRevision: 0, requestId: "start-request-1", action: "start", issue: 1 }, registry), /unfinished delivery/);
});

test("Start refuses corrupt retained state instead of inferring an empty repository", () => {
  const { root, work } = fixtureRepository(), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), profilePath = profile(root); registry.bind(identity, profilePath, 0);
  const store = new FileStateStore(join(realpathSync(root), "state")), corrupt = join(store.repoDir(identity.repo), "deliveries", "corrupt"); mkdirSync(corrupt, { recursive: true, mode: 0o700 }); writeFileSync(join(corrupt, "state.json"), "{not-json\n", { mode: 0o600 });
  assert.throws(() => controlRunner({ identity, expectedRevision: 0, requestId: "start-corrupt-1", action: "start", issue: 1 }, registry), /unreadable/); assert.equal(registry.readSession(identity.repo).revision, 0);
});

test("Start retires a completed cancellation barrier into durable audit", (context) => {
  const { root, work } = fixtureRepository("owner/cancelled-start"), identity = resolveRepository(work), registry = new RepositoryRegistry(join(root, "registry")), profilePath = profile(root, identity.repo); registry.bind(identity, profilePath, 0);
  const seeded = registry.mutateSession(identity.repo, 0, (session) => { session.cancellation = { kind: "cancellation", token: "completed-token", started_at: new Date().toISOString(), owner_pid: process.pid, owner_process_identity: processIdentity(process.pid)!, delivery_id: "cancelled-delivery", request_id: "cancelled_request_001", input_digest: "a".repeat(64), expected_revision: 1, epoch: "b".repeat(64), phase: "complete", generation: 0, owner_token_digest: "c".repeat(64), acknowledgement_digest: "d".repeat(64), completed_at: new Date().toISOString() }; return session; });
  const started = controlRunner({ identity, expectedRevision: seeded.revision, requestId: "start_after_cancel_001", action: "start", issue: 1 }, registry);
  context.after(() => { if (started.owner_pid) { try { process.kill(started.owner_pid, "SIGKILL"); } catch {} } });
  assert.equal(started.cancellation, undefined); assert.equal(started.cancellation_history?.length, 1); assert.equal(started.cancellation_history?.[0]?.request_id, "cancelled_request_001");
});
