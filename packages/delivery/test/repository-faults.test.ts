import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DeliveryEngine, repositoryCommandInputDigest } from "../src/engine.ts";
import { digest } from "../src/core.ts";
import { ExecutableJsonAdapter } from "../src/executors.ts";
import { loadPolicy } from "../src/policy.ts";
import { processIdentity, RepositoryRegistry, resolveRepository } from "../src/repository.ts";
import { beginCoordinatedCancellation, reconcileCoordinatedCancellation } from "../src/cancellation-coordinator.ts";
import { controlRunner } from "../src/runner.ts";
import { FileStateStore } from "../src/store.ts";
import { ProposalSpool } from "../src/proposals.ts";
import { Publisher, publicationAuthorizationDigest } from "../src/publisher.ts";
import { reserveProposalCommand, reserveWorkspaceCommand } from "../src/cli.ts";
import { policy } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const storeModule = pathToFileURL(fileURLToPath(new URL("../src/store.ts", import.meta.url))).href;
const repositoryModule = pathToFileURL(fileURLToPath(new URL("../src/repository.ts", import.meta.url))).href;
const coreModule = pathToFileURL(fileURLToPath(new URL("../src/core.ts", import.meta.url))).href;
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Delivery Fault Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Delivery Fault Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

type Fixture = { root: string; work: string; sibling: string; registry: string; profile: string; state: string };
type Invocation = { status: number | null; stdout: string; stderr: string; json: Record<string, any> };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8" }).trim();
}

function protectedJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-faults-")));
  const work = join(root, "work"), sibling = join(root, "sibling"), registry = join(root, "registry"), state = join(root, "state");
  mkdirSync(work); mkdirSync(registry, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  git(work, "init", "-b", "main"); writeFileSync(join(work, "README.md"), "fault fixture\n"); git(work, "add", "."); git(work, "commit", "-m", "initial");
  git(work, "remote", "add", "origin", "https://github.com/Fixture/Faults.git"); git(work, "worktree", "add", "-b", "related", sibling);
  const skills = join(root, "skills"), policyPath = join(root, "policy.json"), foreground = join(root, "foreground.json"), publisher = join(root, "publisher.json"), profile = join(root, "profile.json");
  mkdirSync(skills, { mode: 0o700 });
  for (const name of ["next-issue", "plan-pr", "implement-plan", "pr-closeout"]) {
    const directory = join(skills, name); mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, "SKILL.md"), `# ${name}\n`, { mode: 0o600 });
  }
  const policyValue = { version: 1, delivery: { final_target: "main", publisher_id: 7 }, branches: { default_parent: "main", plan_template: "plan", implementation_template: "implementation" }, eligibility: {}, approvals: { plan: { minimum: 0, reviewer_ids: [] }, implementation: { minimum: 0, reviewer_ids: [] } }, tracking: { review_label: "delivery-review" } };
  protectedJson(policyPath, policyValue);
  protectedJson(foreground, { schema_version: 1, repository: "fixture/faults", repository_id: 77, auto_schedule: false, pr_publication: "off", issue_publication: "off" });
  protectedJson(publisher, { repo: "fixture/faults", repositoryId: 77, login: "fixture", actorId: 7, stateRoot: join(root, "publisher-state"), remoteUrl: "https://github.com/fixture/faults.git" });
  protectedJson(profile, { schema_version: 1, repository: "fixture/faults", state_dir: state, skills_root: skills, policy: { path: policyPath, ref: "refs/heads/main", sha: git(work, "rev-parse", "HEAD"), digest: createHash("sha256").update(readFileSync(policyPath)).digest("hex"), fetched_at: new Date().toISOString() }, foreground_policy: foreground, publisher_config: publisher, executor: { kind: "executable", argv: [process.execPath, "-e", "process.stdin.resume()"], cwd: work } });
  return { root, work, sibling, registry, profile, state };
}

function cliEnv(registry: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, DELIVERY_REGISTRY_DIR: registry };
}

function invoke(fixtureValue: Fixture, args: string[], extra: NodeJS.ProcessEnv = {}): Invocation {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8", env: cliEnv(fixtureValue.registry, extra), timeout: 15_000 });
  const stdout = result.stdout.trim();
  return { status: result.status, stdout, stderr: result.stderr, json: stdout ? JSON.parse(stdout) : {} };
}
async function invokeAsync(fixtureValue: Fixture, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Invocation> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], { env: cliEnv(fixtureValue.registry, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (value) => { stdout += value; }); child.stderr!.setEncoding("utf8").on("data", (value) => { stderr += value; });
    child.once("error", reject); child.once("exit", (status) => { const text = stdout.trim(); resolve({ status, stdout: text, stderr, json: text ? JSON.parse(text) : {} }); });
  });
}
async function invokeAsyncFrom(fixtureValue: Fixture, cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Invocation> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd, env: cliEnv(fixtureValue.registry, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout!.setEncoding("utf8").on("data", (value) => { stdout += value; }); child.stderr!.setEncoding("utf8").on("data", (value) => { stderr += value; });
    child.once("error", reject); child.once("exit", (status) => { const output = stdout.trim(); resolve({ status, stdout: output, stderr, json: output ? JSON.parse(output) : {} }); });
  });
}

function dummyOwner(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(child.pid); return child;
}

function killSessionOwner(registry: RepositoryRegistry, repo: string): void {
  const pid = registry.readSession(repo).owner_pid; if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

function seedLiveSession(fixtureValue: Fixture, child: ChildProcess, status: "running" | "paused" = "running"): RepositoryRegistry {
  const identity = resolveRepository(fixtureValue.work), registry = new RepositoryRegistry(fixtureValue.registry), ownerIdentity = processIdentity(child.pid!);
  assert.ok(ownerIdentity);
  registry.bind(identity, fixtureValue.profile, 0, "setup_live_session_001");
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = status; session.desired_state = status; session.owner_pid = child.pid!; session.owner_process_identity = ownerIdentity; session.owner_token_digest = digest("fault-owner"); session.heartbeat_at = new Date().toISOString(); return session; });
  return registry;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail("timed out waiting for fault fixture state");
}

test("workspace CLI refuses a DELIVERY_REGISTRY_DIR beneath an intermediate symlink", () => {
  const value = fixture(), target = mkdtempSync(join(tmpdir(), "delivery-cli-registry-target-")), link = join(value.root, "registry-link"), requested = join(link, "state");
  chmodSync(target, 0o700); symlinkSync(target, link);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-status", "--directory", value.work], { encoding: "utf8", env: { ...process.env, DELIVERY_REGISTRY_DIR: requested }, timeout: 15_000 });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /unsafe state path component/);
  assert.equal(existsSync(join(target, "state")), false);
});

test("unconfigured workspace-status does not create DELIVERY_REGISTRY_DIR", () => {
  const value = fixture(), requested = join(value.root, "absent-registry");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-status", "--directory", value.work], { encoding: "utf8", env: { ...process.env, DELIVERY_REGISTRY_DIR: requested }, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(requested), false);
});

test("concurrent same-ID Pause requests are one mutation and lifecycle acknowledgments remain owner-driven", async (context) => {
  const value = fixture(), owner = dummyOwner(); context.after(() => owner.kill("SIGKILL")); const registry = seedLiveSession(value, owner);
  const command = ["runner-control", "--directory", value.work, "--expected-revision", "1", "--request-id", "pause_same_001", "--action", "pause"];
  const [first, second] = await Promise.all([invokeAsync(value, command), invokeAsync(value, command)]);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.equal(first.json.data.runner.revision, 2); assert.equal(second.json.data.runner.revision, 2); assert.equal(registry.readSession("fixture/faults").status, "pausing");

  registry.mutateSession("fixture/faults", 2, (session) => { session.status = "paused"; session.heartbeat_at = new Date().toISOString(); return session; });
  const before = invoke(value, ["workspace-status", "--directory", value.work]); const repeated = invoke(value, ["workspace-status", "--directory", value.sibling]);
  assert.equal(before.json.data.runner.status, "paused"); assert.equal(repeated.json.data.runner.status, "paused"); assert.equal(before.json.data.runner.revision, 3); assert.equal(repeated.json.data.runner.revision, 3);
  const resume = invoke(value, ["runner-control", "--directory", value.sibling, "--expected-revision", "3", "--request-id", "resume_same_001", "--action", "resume"]);
  assert.equal(resume.status, 0, resume.stderr); assert.equal(resume.json.data.runner.status, "running"); assert.equal(resume.json.data.runner.revision, 4);
  const replay = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", "3", "--request-id", "resume_same_001", "--action", "resume"]);
  assert.equal(replay.status, 0, replay.stderr); assert.equal(replay.json.data.runner.revision, 4);
  const stop = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", "4", "--request-id", "stop_ack_001", "--action", "stop"]);
  assert.equal(stop.status, 0, stop.stderr); assert.equal(stop.json.data.runner.status, "stopping"); assert.equal(stop.json.data.runner.observedState, "alive"); assert.equal(registry.readSession("fixture/faults").owner_pid, owner.pid);
  registry.mutateSession("fixture/faults", 5, (session) => { session.status = "stopped"; session.owner_pid = null; delete session.owner_process_identity; return session; });
  const acknowledged = invoke(value, ["workspace-status", "--directory", value.sibling]); assert.equal(acknowledged.json.data.runner.status, "stopped"); assert.equal(acknowledged.json.data.runner.observedState, "not_running");
});

test("Pause and Stop after command reservation atomically refuse workspace, proposal, and manual effects", async (context) => {
  const value = fixture(), owner = dummyOwner(); context.after(() => owner.kill("SIGKILL")); const registry = seedLiveSession(value, owner);
  const actions = ["correct", "publish_issue", "export_handoff"] as const;
  for (const [index, action] of actions.entries()) {
    const lifecycleAction = index === 1 ? "stop" : "pause";
    const requestId = `post_reserve_${action}_${index}`, ready = join(value.root, `${requestId}.ready`), release = join(value.root, `${requestId}.release`);
    const input = { action, delivery_id: action === "correct" ? "delivery-race" : `publication-race-${index}`, request_id: requestId, input_digest: digest({ action, index }), ...(action === "correct" ? { expected_revision: 1 } : { allow_stopped: true }) };
    const code = `import{existsSync,writeFileSync}from'node:fs';import{RepositoryRegistry}from ${JSON.stringify(repositoryModule)};const r=new RepositoryRegistry(${JSON.stringify(value.registry)});const s=r.reserveCommand('fixture/faults',${JSON.stringify(input)}),token=s.operation.token;writeFileSync(${JSON.stringify(ready)},'ready');while(!existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);try{r.markCommandEffect('fixture/faults',token,'effect-${index}');process.stdout.write(JSON.stringify({marked:true}))}catch(error){process.stdout.write(JSON.stringify({marked:false,code:error.code,message:error.message}))}`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] }); context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let output = "", childError = ""; child.stdout!.setEncoding("utf8").on("data", (part) => { output += part; }); child.stderr!.setEncoding("utf8").on("data", (part) => { childError += part; });
    await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8") === "ready" && child.exitCode === null); const reserved = registry.readSession("fixture/faults"); assert.equal(reserved.operation?.phase, "reserved");
    const lifecycle = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(reserved.revision), "--request-id", `${lifecycleAction}_after_${action}_${index}`, "--action", lifecycleAction]); assert.equal(lifecycle.status, 0, lifecycle.stderr || lifecycle.stdout);
    writeFileSync(release, "release"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const result = JSON.parse(output); assert.equal(result.marked, false, childError || output); assert.equal(result.code, "RUNNER_BARRIER", childError);
    const after = registry.readSession("fixture/faults"); assert.equal(after.operation, undefined); assert.equal(after.desired_state, lifecycleAction === "pause" ? "paused" : "stopped"); assert.equal(after.status, lifecycleAction === "pause" ? "pausing" : "stopping");
    registry.mutateSession("fixture/faults", after.revision, (session) => { session.desired_state = "running"; session.status = "running"; session.heartbeat_at = new Date().toISOString(); return session; });
  }
  const running = registry.readSession("fixture/faults"); registry.mutateSession("fixture/faults", running.revision, (session) => { session.desired_state = "stopped"; session.status = "stopped"; session.owner_pid = null; delete session.owner_process_identity; return session; });
  const explicit = registry.reserveCommand("fixture/faults", { action: "publish_issue", delivery_id: "explicit-stopped", request_id: "explicit_stopped_effect_001", input_digest: digest("explicit-stopped"), allow_stopped: true });
  const admitted = registry.markCommandEffect("fixture/faults", explicit.operation!.token, "explicit-stopped-operation"); assert.equal(admitted.operation?.kind, "command"); assert.equal(admitted.operation?.phase, "effect"); assert.equal(admitted.operation?.effect_admission, "stopped_explicit"); registry.finishReservation("fixture/faults", explicit.operation!.token);
  const stopped = registry.readSession("fixture/faults"); registry.mutateSession("fixture/faults", stopped.revision, (session) => { session.desired_state = "running"; session.status = "running"; session.owner_pid = owner.pid!; session.owner_process_identity = processIdentity(owner.pid!)!; session.heartbeat_at = new Date().toISOString(); session.operation = { kind: "command", token: "legacy-live-reserved", started_at: new Date(0).toISOString(), owner_pid: process.pid, owner_process_identity: processIdentity(process.pid)!, action: "correct", delivery_id: "legacy-live", request_id: "legacy_live_reserved_001", input_digest: digest("legacy-live"), phase: "reserved" }; return session; });
  assert.throws(() => registry.markCommandEffect("fixture/faults", "legacy-live-reserved", "must-not-run"), /lifecycle changed/); assert.equal(registry.readSession("fixture/faults").operation, undefined);
  const legacyInput = { action: "correct", delivery_id: "legacy-dead", request_id: "legacy_dead_reserved_001", input_digest: digest("legacy-dead") };
  registry.mutateSession("fixture/faults", undefined, (session) => { session.operation = { kind: "command", token: "legacy-dead-reserved", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-owner", ...legacyInput, phase: "reserved" }; return session; });
  const recoveredLegacy = registry.reserveCommand("fixture/faults", legacyInput); assert.equal(recoveredLegacy.operation?.kind, "command"); assert.equal(recoveredLegacy.operation?.effect_admission, "running"); const recoveredEffect = registry.markCommandEffect("fixture/faults", recoveredLegacy.operation!.token, "legacy-recovered-effect"); assert.equal(recoveredEffect.operation?.phase, "effect"); registry.finishReservation("fixture/faults", recoveredLegacy.operation!.token);
});

test("Stop after worker reservation retires the pre-effect transition without running it", async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_worker_mark_race_001");
  const ready = join(value.root, "worker-mark.ready"), release = join(value.root, "worker-mark.release");
  const code = `import{existsSync,writeFileSync}from'node:fs';import{RepositoryRegistry,processIdentity}from ${JSON.stringify(repositoryModule)};import{digest}from ${JSON.stringify(coreModule)};const r=new RepositoryRegistry(${JSON.stringify(value.registry)}),token='worker-race-token';r.mutateSession('fixture/faults',0,s=>{s.generation=1;s.status='running';s.desired_state='running';s.owner_pid=process.pid;s.owner_process_identity=processIdentity(process.pid);s.owner_token_digest=digest(token);s.heartbeat_at=new Date().toISOString();return s});const reserved=r.reserveWorkerTransition('fixture/faults',1,digest(token),'worker-race-reservation');writeFileSync(${JSON.stringify(ready)},reserved?'ready':'failed');while(!existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);const marked=r.markWorkerEffect('fixture/faults','worker-race-reservation','worker-effect');process.stdout.write(JSON.stringify({marked:Boolean(marked)}))`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] }); context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "", childError = ""; child.stdout!.setEncoding("utf8").on("data", (part) => { output += part; }); child.stderr!.setEncoding("utf8").on("data", (part) => { childError += part; });
  await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8") === "ready" && child.exitCode === null); assert.equal(readFileSync(ready, "utf8"), "ready"); const reserved = registry.readSession(identity.repo); assert.equal(reserved.operation?.phase, "reserved");
  const stopped = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(reserved.revision), "--request-id", "stop_after_worker_reserve_001", "--action", "stop"]); assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  writeFileSync(release, "release"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.deepEqual(JSON.parse(output), { marked: false }, childError); const after = registry.readSession(identity.repo); assert.equal(after.operation, undefined); assert.equal(after.desired_state, "stopped"); assert.equal(after.status, "stopping");
  registry.mutateSession(identity.repo, after.revision, (session) => { session.desired_state = "running"; session.status = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("legacy-worker-owner"); session.generation += 1; session.operation = { kind: "worker", token: "legacy-worker-reserved", started_at: new Date(0).toISOString(), owner_pid: process.pid, owner_process_identity: processIdentity(process.pid)!, generation: session.generation, owner_token_digest: digest("legacy-worker-owner"), phase: "reserved" }; return session; });
  assert.equal(registry.markWorkerEffect(identity.repo, "legacy-worker-reserved", "must-not-run"), undefined); assert.equal(registry.readSession(identity.repo).operation, undefined);
  registry.mutateSession(identity.repo, undefined, (session) => { session.desired_state = "stopped"; session.status = "stopping"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("drain-owner"); session.generation += 1; return session; });
  const drainOwner = registry.readSession(identity.repo), drain = registry.reserveWorkerTransition(identity.repo, drainOwner.generation, digest("drain-owner"), "stopping-drain-reservation", true); assert.equal(drain?.operation?.kind, "worker");
  const admittedDrain = registry.markWorkerEffect(identity.repo, "stopping-drain-reservation", "stopping-drain-effect"); assert.equal(admittedDrain?.operation?.kind, "worker"); assert.equal(admittedDrain?.operation?.phase, "effect"); assert.equal(admittedDrain?.operation?.effect_admission, "stopping_drain"); registry.finishReservation(identity.repo, "stopping-drain-reservation");
});

test("live PID identity ambiguity is unknown and cannot authorize recovery", () => {
  const value = fixture(), registry = new RepositoryRegistry(value.registry), identity = resolveRepository(value.work), actual = JSON.parse(processIdentity(process.pid)!);
  registry.bind(identity, value.profile, 0, "setup_identity_ambiguity_001");
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 3; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = JSON.stringify({ ...actual, argv_digest: "0".repeat(64) }); session.heartbeat_at = new Date().toISOString(); return session; });
  const changedArgv = invoke(value, ["workspace-status", "--directory", value.work]); assert.equal(changedArgv.json.data.runner.status, "uncertain"); assert.equal(changedArgv.json.data.runner.observedState, "unknown");
  const refusedRecovery = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", "1", "--request-id", "recover_unknown_001", "--action", "recover"]); assert.equal(refusedRecovery.status, 2, refusedRecovery.stdout); assert.match(refusedRecovery.json.error.message, /proven lost process ownership/); assert.equal(registry.readSession(identity.repo).revision, 1);
  registry.mutateSession(identity.repo, 1, (session) => { session.owner_process_identity = JSON.stringify({ ...actual, started_at: "Mon Jan  1 00:00:00 1990" }); return session; });
  const lost = invoke(value, ["workspace-status", "--directory", value.work]); assert.equal(lost.status, 0, lost.stderr); assert.equal(lost.json.data.runner.status, "uncertain"); assert.equal(lost.json.data.runner.observedState, "lost");
  registry.mutateSession(identity.repo, 2, (session) => { session.status = "blocked"; session.owner_pid = null; delete session.owner_process_identity; session.reason = "explicit fixture hold"; return session; });
  const blocked = invoke(value, ["workspace-status", "--directory", value.work]); assert.equal(blocked.status, 0, blocked.stderr); assert.equal(blocked.json.data.runner.status, "blocked"); assert.equal(blocked.json.data.runner.observedState, "unknown"); assert.equal(blocked.json.data.runner.reason, "explicit fixture hold");
});

test("two exact-owner lock reclaimers cannot remove the fresh winner lock or execute twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-lock-recovery-")), repo = "fixture/faults", store = new FileStateStore(root), lock = join(store.repoDir(repo), ".mutation.lock"), entered = join(root, "entered"), frozen = join(root, "frozen"), ready = join(root, "ready");
  mkdirSync(lock, { recursive: true, mode: 0o700 }); store.writeProtected(join(lock, "owner.json"), { pid: 99_999_999, process_identity: "dead-owner", token: "dead-token", at: new Date(0).toISOString() });
  const instrument = (delay: number, signal?: string) => `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const originalRename = fs.renameSync; fs.renameSync = (oldPath, newPath) => { if (oldPath === ${JSON.stringify(lock)} && String(newPath).startsWith(${JSON.stringify(`${lock}.recovery-`)})) { ${signal ? `fs.writeFileSync(${JSON.stringify(signal)}, 'frozen');` : ""} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delay}); } return originalRename(oldPath, newPath); }; syncBuiltinESMExports();`;
  const winnerCode = `${instrument(1_000, frozen)} const { FileStateStore } = await import(${JSON.stringify(`${storeModule}?winner`)}); const { appendFileSync, writeFileSync } = fs; const store = new FileStateStore(${JSON.stringify(root)}); if (store.recoverRepoLock(${JSON.stringify(repo)})) store.withRepoLock(${JSON.stringify(repo)}, () => { appendFileSync(${JSON.stringify(entered)}, 'winner\\n'); writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200); });`;
  const challengerCode = `${instrument(1_500)} const { FileStateStore } = await import(${JSON.stringify(`${storeModule}?challenger`)}); const { appendFileSync } = fs; const store = new FileStateStore(${JSON.stringify(root)}); try { if (store.recoverRepoLock(${JSON.stringify(repo)})) appendFileSync(${JSON.stringify(entered)}, 'challenger\\n'); } catch (error) { process.stdout.write(String(error)); }`;
  const winner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", winnerCode], { env: { ...process.env, DELIVERY_REGISTRY_DIR: join(root, "unused-registry") }, stdio: ["ignore", "pipe", "pipe"] });
  await waitFor(() => existsSync(frozen));
  const challenger = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", challengerCode], { env: { ...process.env, DELIVERY_REGISTRY_DIR: join(root, "unused-registry") }, stdio: ["ignore", "pipe", "pipe"] });
  const winnerExit = new Promise<void>((resolve) => winner.once("exit", () => resolve())), challengerExit = new Promise<void>((resolve) => challenger.once("exit", () => resolve()));
  let challengerOutput = ""; challenger.stdout!.setEncoding("utf8").on("data", (part) => { challengerOutput += part; }); challenger.stderr!.setEncoding("utf8").on("data", (part) => { challengerOutput += part; });
  await waitFor(() => existsSync(ready)); await challengerExit;
  assert.match(challengerOutput, /exact lock recovery is already in progress|changed during recovery|still alive/i); assert.equal(existsSync(lock), true, "second reclaimer removed the winner's fresh live lock");
  await winnerExit;
  assert.deepEqual(readFileSync(entered, "utf8").trim().split("\n"), ["winner"]); assert.equal(existsSync(lock), false);
});

test("simultaneous Start from related worktrees has one repository-level winner", async (context) => {
  const value = fixture(), registry = new RepositoryRegistry(value.registry); context.after(() => killSessionOwner(registry, "fixture/faults"));
  const setup = spawnSync(process.execPath, ["--experimental-strip-types", cli, "workspace-setup", "--directory", value.work, "--expected-revision", "0", "--request-id", "setup_race_001"], { encoding: "utf8", input: JSON.stringify({ mode: "import", profilePath: value.profile }), env: cliEnv(value.registry) });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const first = ["runner-control", "--directory", value.work, "--expected-revision", "0", "--request-id", "start_race_001", "--action", "start", "--issue", "17"];
  const second = ["runner-control", "--directory", value.sibling, "--expected-revision", "0", "--request-id", "start_race_002", "--action", "start", "--issue", "17"];
  const results = await Promise.all([invokeAsync(value, first), invokeAsync(value, second)]), successes = results.filter((result) => result.status === 0), failures = results.filter((result) => result.status !== 0);
  assert.equal(successes.length, 1, JSON.stringify(results)); assert.equal(failures.length, 1, JSON.stringify(results));
  await waitFor(() => ["blocked", "stopped", "uncertain"].includes(registry.readSession("fixture/faults").status));
  const session = registry.readSession("fixture/faults"); assert.equal(session.generation, 1); assert.equal(Object.keys(session.requests).filter((id) => id.startsWith("start_race_")).length, 1);
  if (session.owner_pid) { try { process.kill(session.owner_pid, "SIGKILL"); } catch { /* already exited */ } }
});

test("Cancel racing stopped Resume never creates a replacement delivery", async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state);
  context.after(() => killSessionOwner(registry, identity.repo));
  registry.bind(identity, value.profile, 0, "setup_cancel_001");
  const original = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "resume-cancel-fixture", policy: policy() });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "stopped"; session.desired_state = "stopped"; session.delivery_id = original.delivery_id; return session; });
  const resume = ["runner-control", "--directory", value.work, "--expected-revision", "1", "--request-id", "resume_cancel_001", "--action", "resume"];
  const cancel = ["workspace-command", "--directory", value.work, "--delivery-id", original.delivery_id, "--expected-revision", String(original.revision), "--request-id", "cancel_resume_001", "--action", "cancel"];
  const [resumeResult, cancelResult] = await Promise.all([invokeAsync(value, resume), invokeAsync(value, cancel, { DELIVERY_OPERATOR_GRANT: "fault-grant" })]);
  assert.equal(cancelResult.status, 0, JSON.stringify(cancelResult)); assert.ok(resumeResult.status === 0 || resumeResult.json.error?.code === "STALE_REVISION", resumeResult.stderr || resumeResult.stdout);
  await waitFor(() => store.read(identity.repo, original.delivery_id).claim_status === "released", 30_000);
  const states = store.list(identity.repo); assert.equal(states.length, 1, `Resume created replacement deliveries: ${states.map((state) => state.delivery_id).join(", ")}`); assert.equal(states[0]!.delivery_id, original.delivery_id); assert.equal(states[0]!.status, "cancelled"); assert.equal(states[0]!.controls.cancellation?.phase, "complete");
  const session = registry.readSession(identity.repo); if (session.owner_pid) { try { process.kill(session.owner_pid, "SIGKILL"); } catch { /* already exited */ } }
});

test("legacy Start cannot bypass a repository binding through an alternate state root", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), alternateState = join(value.root, "alternate-state"), alternateProfile = join(value.root, "alternate-profile.json");
  registry.bind(identity, value.profile, 0, "setup_legacy_guard_001"); mkdirSync(alternateState, { mode: 0o700 });
  const profile = JSON.parse(readFileSync(value.profile, "utf8")); profile.state_dir = alternateState; protectedJson(alternateProfile, profile);
  const result = invoke(value, ["start", "--profile", alternateProfile, "--repo", identity.repo, "--issue", "17", "--no-dispatch"]);
  assert.equal(result.status, 2, result.stdout); assert.equal(result.json.error.code, "RUNNER_BARRIER"); assert.match(result.json.error.message, /bound to a different durable state root/);
  assert.deepEqual(new FileStateStore(alternateState).list(identity.repo), []);
});

test("an aged pre-ack launch reservation projects lost and supports explicit recovery", async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_preack_001");
  context.after(() => killSessionOwner(registry, identity.repo));
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "starting"; session.desired_state = "running"; session.owner_pid = null; session.owner_started_at = new Date(0).toISOString(); session.owner_token_digest = digest("unacknowledged-launch"); return session; });
  const lost = invoke(value, ["workspace-status", "--directory", value.work]); assert.equal(lost.status, 0, lost.stderr); assert.equal(lost.json.data.runner.status, "uncertain"); assert.equal(lost.json.data.runner.observedState, "lost");
  const recovered = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", "1", "--request-id", "recover_preack_001", "--action", "recover"]);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout); assert.equal(recovered.json.data.runner.generation, 2); assert.ok(["starting", "running", "blocked"].includes(recovered.json.data.runner.status));
  await waitFor(() => registry.readSession(identity.repo).owner_pid !== null || registry.readSession(identity.repo).status === "blocked"); const session = registry.readSession(identity.repo);
  if (session.owner_pid) { try { process.kill(session.owner_pid, "SIGKILL"); } catch { /* already exited */ } }
});

test("explicit recovery reconciles an exact dead typed worker reservation", async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_worker_operation_recovery_001"); context.after(() => killSessionOwner(registry, identity.repo));
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = 99_999_999; session.owner_process_identity = "dead-runner"; session.owner_token_digest = digest("dead-worker-token"); session.heartbeat_at = new Date(0).toISOString(); session.operation = { kind: "worker", token: "dead-worker-operation", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-runner", generation: 1, owner_token_digest: digest("dead-worker-token"), phase: "effect" }; return session; });
  const recovered = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", "1", "--request-id", "recover_worker_operation_001", "--action", "recover"]);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout); const session = registry.readSession(identity.repo); assert.equal(session.operation, undefined); assert.equal(session.generation, 2);
});

test("a killed durable recovery intent is taken over once by the same request ID", async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state); registry.bind(identity, value.profile, 0, "setup_recovery_crash_001");
  const recoveryChildren: ChildProcess[] = []; context.after(() => { for (const child of recoveryChildren) if (child.exitCode === null) child.kill("SIGKILL"); killSessionOwner(registry, identity.repo); });
  const seed = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "recovery-scan-seed", policy: policy() });
  const released = store.mutate(identity.repo, seed.delivery_id, seed.revision, (state) => { state.claim_status = "released"; state.status = "cancelled"; state.controls.cancelled = true; return state; }); store.release(released);
  for (let index = 0; index < 400; index += 1) {
    const deliveryId = `recovery-scan-${String(index).padStart(4, "0")}`, copy = { ...released, delivery_id: deliveryId };
    store.writeProtected(store.statePath(identity.repo, deliveryId), copy);
  }
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 2; session.status = "running"; session.desired_state = "running"; session.owner_pid = 99_999_999; session.owner_process_identity = "dead-runner"; session.heartbeat_at = new Date(0).toISOString(); return session; });
  const args = ["runner-control", "--directory", value.work, "--expected-revision", "1", "--request-id", "recover_crash_001", "--action", "recover"];
  const startRecovery = () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], { env: cliEnv(value.registry), stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
    recoveryChildren.push(child);
    child.stdout!.setEncoding("utf8").on("data", (part) => { stdout += part; }); child.stderr!.setEncoding("utf8").on("data", (part) => { stderr += part; });
    return { child, output: () => ({ stdout, stderr }), exited: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
  };
  const first = startRecovery(), deadline = Date.now() + 15_000;
  while (!registry.readSession(identity.repo).recovery && first.child.exitCode === null && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  const firstIntent = registry.readSession(identity.repo); assert.ok(firstIntent.recovery, first.output().stderr || first.output().stdout); process.kill(first.child.pid!, "SIGSTOP"); process.kill(first.child.pid!, "SIGKILL"); await first.exited;
  const stranded = registry.readSession(identity.repo); assert.equal(stranded.requests.recover_crash_001?.status, "intent"); assert.ok(stranded.recovery); assert.notEqual(processIdentity(stranded.recovery!.owner_pid), stranded.recovery!.owner_process_identity);

  const retry = startRecovery(), takeoverDeadline = Date.now() + 15_000;
  while (registry.readSession(identity.repo).recovery?.owner_pid === stranded.recovery!.owner_pid && retry.child.exitCode === null && Date.now() < takeoverDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  const takeover = registry.readSession(identity.repo); assert.ok(takeover.recovery); assert.notEqual(takeover.recovery!.owner_pid, stranded.recovery!.owner_pid); process.kill(retry.child.pid!, "SIGSTOP");
  const concurrent = invoke(value, args); assert.equal(concurrent.status, 0, concurrent.stderr || concurrent.stdout); assert.equal(registry.readSession(identity.repo).recovery?.token, takeover.recovery!.token);
  process.kill(retry.child.pid!, "SIGCONT");
  const retryStatus = await retry.exited; assert.equal(retryStatus, 0, retry.output().stderr || retry.output().stdout);
  const settled = registry.readSession(identity.repo); assert.equal(settled.recovery, undefined); assert.ok(["reconciled", "completed"].includes(settled.requests.recover_crash_001?.status ?? "")); assert.equal(Object.keys(settled.requests).filter((id) => id === "recover_crash_001").length, 1);
  if (settled.owner_pid) { try { process.kill(settled.owner_pid, "SIGKILL"); } catch { /* already exited */ } }
});

test("Pause and Stop cannot acknowledge across an in-flight workspace publication", { timeout: 60_000 }, async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state), baseline = git(value.work, "rev-parse", "HEAD");
  const bin = join(value.root, "bin"), gh = join(bin, "gh"); mkdirSync(bin, { mode: 0o700 }); writeFileSync(gh, "#!/bin/sh\nif [ \"$3\" = \"--help\" ] || [ \"$2\" = \"--help\" ]; then echo 'usage: gh auth token --hostname HOST --user LOGIN --no-refresh'; exit 0; fi\necho fixture-token\n", { mode: 0o700 }); chmodSync(gh, 0o700);
  const bare = join(value.root, "publisher.git"), bundle = join(value.root, "plan.bundle"); git(value.root, "init", "--bare", bare); git(value.work, "remote", "add", "fixture", bare); git(value.work, "push", "fixture", "main");
  git(value.work, "checkout", "-b", "fixture-plan"); writeFileSync(join(value.work, "plan.md"), "# Fault plan\n"); git(value.work, "add", "plan.md"); git(value.work, "commit", "-m", "fault plan"); const planSha = git(value.work, "rev-parse", "HEAD"); git(value.work, "bundle", "create", bundle, "fixture-plan"); git(value.work, "checkout", "main");
  let releasePost!: () => void, observedPost!: () => void; const postSeen = new Promise<void>((resolve) => { observedPost = resolve; }), postRelease = new Promise<void>((resolve) => { releasePost = resolve; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); let raw = ""; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : {};
    const send = (status: number, data: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (url.pathname === "/user") return send(200, { id: 7, login: "fixture", type: "User" });
    if (url.pathname === `/repos/${identity.repo}`) return send(200, { id: 77, full_name: identity.repo, private: false, default_branch: "main" });
    if (url.pathname === `/repos/${identity.repo}/pulls` && request.method === "GET") return send(200, []);
    if (url.pathname === `/repos/${identity.repo}/pulls` && request.method === "POST") { observedPost(); await postRelease; return send(201, { number: 1, id: 101, node_id: "PR_fault", html_url: `https://github.com/${identity.repo}/pull/1`, state: "open", draft: true, title: body.title, body: body.body, user: { id: 7, login: "fixture", type: "User" }, head: { ref: body.head, sha: planSha, repo: { id: 77 } }, base: { ref: body.base, sha: baseline, repo: { id: 77 } } }); }
    return send(404, { message: url.pathname });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(async () => { releasePost(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const profile = JSON.parse(readFileSync(value.profile, "utf8"));
  protectedJson(profile.publisher_config, { repo: identity.repo, repositoryId: 77, login: "fixture", actorId: 7, stateRoot: join(value.root, "publisher-state"), remoteUrl: bare, transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true, allowLocalRemote: true }); registry.bind(identity, value.profile, 0, "setup_command_barrier_001");
  const loadedPolicy = loadPolicy(profile.policy.path, { expectedDigest: profile.policy.digest, sourceRef: profile.policy.ref, sourceSha: profile.policy.sha, fetchedAt: profile.policy.fetched_at }), engine = new DeliveryEngine({ store });
  let state = engine.start({ repo: identity.repo, issue: 17, deliveryId: "command-barrier-run", policy: loadedPolicy, safeguards: { publication: { pr: "explicit", issue: "off" }, allowedPaths: { plan: ["plan.md"] } } });
  state = engine.acceptManifest(identity.repo, state.delivery_id, { schema_version: 1, kind: "plan", delivery_id: state.delivery_id, repo: identity.repo, result: { issue: 17, plan_revision: planSha, baseline: { repo: identity.repo, ref: "main", sha: baseline }, artifact_paths: ["plan.md"], artifact_hashes: { "plan.md": createHash("sha256").update("# Fault plan\n").digest("hex") } } }, state.revision);
  state = engine.stageHandoff(identity.repo, state.delivery_id, "plan", { expected: { head: "delivery/fault-plan", base: "main", head_sha: planSha, base_sha: baseline, previous_sha: null }, payload: { title: "Fault plan", body: "Publication barrier fixture", bundle, allowed_paths: ["plan.md"] } }, state.revision);
  const fixturePath = `${bin}:${process.env.PATH ?? ""}`, token = "command-barrier-owner-token", worker = spawn(process.execPath, ["--experimental-strip-types", cli, "runner-worker", "--directory", value.work, "--generation", "1", "--token", token], { env: cliEnv(value.registry, { DELIVERY_OPERATOR_GRANT: "fault-grant", DELIVERY_RUNNER_POLL_MS: "2000", PATH: fixturePath }), stdio: "ignore" }); context.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); }); assert.ok(worker.pid);
  const seeded = registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = worker.pid!; session.owner_process_identity = processIdentity(worker.pid!); session.owner_token_digest = digest(token); session.heartbeat_at = new Date().toISOString(); session.delivery_id = state.delivery_id; return session; });
  await waitFor(() => { const session = registry.readSession(identity.repo); return session.owner_pid === worker.pid && session.owner_process_identity === processIdentity(worker.pid!) && Date.parse(session.heartbeat_at ?? "") > Date.parse(seeded.heartbeat_at ?? "") && !session.operation && !session.in_flight; }); state = store.read(identity.repo, state.delivery_id);
  const publication = invokeAsync(value, ["workspace-command", "--directory", value.work, "--delivery-id", state.delivery_id, "--expected-revision", String(state.revision), "--request-id", "publish_barrier_001", "--action", "publish_plan", "--digest", state.handoffs.plan!.digest], { DELIVERY_OPERATOR_GRANT: "fault-grant", PATH: fixturePath });
  const publicationReachedHttp = await Promise.race([postSeen.then(() => ({ posted: true as const })), publication.then((result) => ({ posted: false as const, result }))]); assert.equal(publicationReachedHttp.posted, true, publicationReachedHttp.posted ? undefined : `${publicationReachedHttp.result.stderr || publicationReachedHttp.result.stdout}\n${JSON.stringify(store.read(identity.repo, state.delivery_id).operations)}`);
  await waitFor(() => registry.readSession(identity.repo).operation?.kind === "command" && registry.readSession(identity.repo).operation?.phase === "effect"); const reserved = registry.readSession(identity.repo), ownerPid = reserved.owner_pid; assert.equal(ownerPid, worker.pid);
  const pause = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(reserved.revision), "--request-id", "pause_barrier_001", "--action", "pause"]); assert.equal(pause.status, 0, pause.stderr || pause.stdout);
  const pausing = registry.readSession(identity.repo); assert.equal(pausing.status, "pausing"); assert.equal(pausing.owner_pid, ownerPid); assert.equal(pausing.operation?.kind, "command");
  const stop = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(pausing.revision), "--request-id", "stop_barrier_001", "--action", "stop"]); assert.equal(stop.status, 0, stop.stderr || stop.stdout);
  const stopping = registry.readSession(identity.repo); assert.equal(stopping.status, "stopping"); assert.equal(stopping.owner_pid, ownerPid); assert.equal(stopping.operation?.kind, "command");
  releasePost(); const published = await publication; assert.equal(published.status, 0, published.stderr || published.stdout);
  await waitFor(() => registry.readSession(identity.repo).status === "stopped"); const acknowledged = registry.readSession(identity.repo); assert.equal(acknowledged.owner_pid, null); assert.equal(acknowledged.operation, undefined);
});

test("SIGKILL reserved command supports exact same-request CAS takeover and one completion", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-command-kill-"))), ready = join(root, "ready"), repositoryUrl = pathToFileURL(fileURLToPath(new URL("../src/repository.ts", import.meta.url))).href;
  const input = { action: "publish_plan", delivery_id: "delivery-one", request_id: "same_request_001", input_digest: "a".repeat(64), allow_stopped: true };
  const program = `import{writeFileSync}from'node:fs';import{RepositoryRegistry}from ${JSON.stringify(repositoryUrl)};const r=new RepositoryRegistry(${JSON.stringify(root)});const s=r.reserveCommand('owner/repo',${JSON.stringify(input)});writeFileSync(${JSON.stringify(ready)},s.operation.token);setInterval(()=>{},1000)`;
  const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: "ignore" }); context.after(() => { try { owner.kill("SIGKILL"); } catch {} });
  await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8").length > 0); owner.kill("SIGKILL"); await new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
  const registry = new RepositoryRegistry(root), taken = registry.reserveCommand("owner/repo", input), operation = taken.operation;
  assert.equal(operation?.kind, "command"); assert.equal(operation?.request_id, input.request_id); assert.notEqual(operation?.token, readFileSync(ready, "utf8"));
  assert.throws(() => registry.reserveCommand("owner/repo", { ...input, request_id: "different_request_001", input_digest: "b".repeat(64) }), /another repository operation|still live/);
  registry.finishReservation("owner/repo", operation!.token); assert.equal(registry.readSession("owner/repo").operation, undefined);
});

test("SIGKILL effect-phase command remains held for authoritative journal reconciliation", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-command-effect-kill-"))), ready = join(root, "ready"), repositoryUrl = pathToFileURL(fileURLToPath(new URL("../src/repository.ts", import.meta.url))).href;
  const input = { action: "publish_plan", delivery_id: "delivery-two", request_id: "effect_request_001", input_digest: "c".repeat(64), allow_stopped: true };
  const program = `import{writeFileSync}from'node:fs';import{RepositoryRegistry}from ${JSON.stringify(repositoryUrl)};const r=new RepositoryRegistry(${JSON.stringify(root)});const s=r.reserveCommand('owner/repo',${JSON.stringify(input)});r.markCommandEffect('owner/repo',s.operation.token,'operation-one');writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: "ignore" }); context.after(() => { try { owner.kill("SIGKILL"); } catch {} });
  await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8").length > 0); owner.kill("SIGKILL"); await new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
  const registry = new RepositoryRegistry(root); assert.throws(() => registry.reserveCommand("owner/repo", input), /authoritative journal reconciliation/);
  const held = registry.readSession("owner/repo").operation; assert.equal(held?.kind, "command"); assert.equal(held?.phase, "effect"); assert.equal(held?.operation_id, "operation-one");
});

test("dead effect-phase command is completed once through authoritative control reconciliation", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state); registry.bind(identity, value.profile, 0, "setup_command_reconcile_001");
  let active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "command-reconcile", policy: policy() }); active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.status = "plan_review"; return state; });
  const requestId = "correct_reconcile_001", inputDigest = digest({ repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, request_id: requestId, action: "correct", digest: null });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("live-runner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id; session.operation = { kind: "command", token: "dead-command-token", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-command-owner", action: "correct", delivery_id: active.delivery_id, request_id: requestId, input_digest: inputDigest, expected_revision: active.revision, phase: "effect", operation_id: requestId }; return session; });
  const reconciled = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "correct"], { DELIVERY_OPERATOR_GRANT: "reconcile-grant" });
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout); const final = store.read(identity.repo, active.delivery_id); assert.equal(final.status, "plan_required"); assert.equal(final.controls.requests[requestId]?.status, "completed"); assert.equal(registry.readSession(identity.repo).operation, undefined);
});

test("paused and stopped repositories read back a completed dead command without a new effect", async () => {
  for (const desired of ["paused", "stopped"] as const) {
    const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state); registry.bind(identity, value.profile, 0, `setup_command_${desired}_001`);
    const engine = new DeliveryEngine({ store, controlGrant: { token: "reconcile-grant", repositories: [identity.repo], actions: ["correct"] } }); let active = engine.start({ repo: identity.repo, issue: 17, deliveryId: `command-${desired}`, policy: policy() }); active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.status = "plan_review"; return state; });
    const requestId = `correct_${desired}_001`, inputDigest = digest({ repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, request_id: requestId, action: "correct", digest: null }); await engine.control({ repo: identity.repo, deliveryId: active.delivery_id, expectedRevision: active.revision, requestId, action: "correct", grant: "reconcile-grant" });
    registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = desired; session.desired_state = desired; session.owner_pid = desired === "paused" ? process.pid : null; if (desired === "paused") session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest(`${desired}-runner`); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id; session.operation = { kind: "command", token: `dead-${desired}-command`, started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-command-owner", action: "correct", delivery_id: active.delivery_id, request_id: requestId, input_digest: inputDigest, expected_revision: active.revision, phase: "effect", operation_id: requestId }; return session; });
    const reconciled = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "correct"], { DELIVERY_OPERATOR_GRANT: "reconcile-grant" });
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout); assert.equal(registry.readSession(identity.repo).operation, undefined); assert.equal(store.read(identity.repo, active.delivery_id).controls.requests[requestId]?.status, "completed");
  }
});

test("paused pre-intent dead command retires without effect and succeeds only after explicit Resume replay", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state); registry.bind(identity, value.profile, 0, "setup_command_preintent_001");
  let active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "command-preintent", policy: policy() }); active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.status = "plan_review"; return state; });
  const requestId = "correct_preintent_001", inputDigest = digest({ repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, request_id: requestId, action: "correct", digest: null }); registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "paused"; session.desired_state = "paused"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("paused-runner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id; session.operation = { kind: "command", token: "dead-preintent-command", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-command-owner", action: "correct", delivery_id: active.delivery_id, request_id: requestId, input_digest: inputDigest, expected_revision: active.revision, phase: "effect", operation_id: requestId }; return session; });
  const held = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "correct"], { DELIVERY_OPERATOR_GRANT: "reconcile-grant" }); assert.equal(held.status, 2, held.stdout); assert.match(held.json.error.message, /pre-effect|resume/i); assert.equal(registry.readSession(identity.repo).operation, undefined); assert.equal(store.read(identity.repo, active.delivery_id).controls.requests[requestId], undefined); assert.equal(store.read(identity.repo, active.delivery_id).status, "plan_review");
  const paused = registry.readSession(identity.repo), resumed = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(paused.revision), "--request-id", "resume_after_preintent_001", "--action", "resume"]); assert.equal(resumed.status, 0, resumed.stdout);
  const replayed = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "correct"], { DELIVERY_OPERATOR_GRANT: "reconcile-grant" }); assert.equal(replayed.status, 0, replayed.stdout); assert.equal(store.read(identity.repo, active.delivery_id).status, "plan_required"); assert.equal(store.read(identity.repo, active.delivery_id).controls.requests[requestId]?.status, "completed");
});

test("dead issue command reconciles the exact proposal journal without duplicate effects", async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state), issues: Record<string, unknown>[] = [], heldPostStarted = join(value.root, "held-post-started"), heldPost: { release?: () => void } = {}, releasePost = () => { const release: unknown = heldPost.release; if (typeof release === "function") release(); }; let posts = 0, holdPost = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"), json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "GET" && url.pathname === "/user") return json(200, { id: 7, login: "fixture", type: "User" });
    if (request.method === "GET" && url.pathname === "/repos/fixture/faults") return json(200, { id: 77, full_name: "fixture/faults", private: true });
    if (request.method === "GET" && url.pathname === "/repos/fixture/faults/issues") return json(200, issues);
    if (request.method === "POST" && url.pathname === "/repos/fixture/faults/issues") { posts += 1; let raw = ""; for await (const part of request) raw += part; const body = JSON.parse(raw), number = issues.length + 1, issue = { id: 100 + number, node_id: `issue-${number}`, number, title: body.title, body: body.body, state: "open", repository_url: "https://api.github.com/repos/fixture/faults", url: `https://api.github.com/repos/fixture/faults/issues/${number}`, html_url: `https://github.com/fixture/faults/issues/${number}`, user: { id: 7, login: "fixture", type: "User" }, performed_via_github_app: null }; issues.push(issue); if (holdPost) { writeFileSync(heldPostStarted, String(body.title)); await new Promise<void>((resolveHeld) => { heldPost.release = resolveHeld; }); } return json(201, issue); }
    const exact = /^\/repos\/fixture\/faults\/issues\/(\d+)$/.exec(url.pathname); if (request.method === "GET" && exact) return json(200, issues[Number(exact[1]) - 1]);
    return json(404, { message: "not found" });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen)); context.after(() => server.close()); const address = server.address(); assert(address && typeof address === "object");
  const profile = JSON.parse(readFileSync(value.profile, "utf8")), foreground = JSON.parse(readFileSync(profile.foreground_policy, "utf8")), publisherConfig = JSON.parse(readFileSync(profile.publisher_config, "utf8")); foreground.issue_publication = "explicit"; publisherConfig.testOnly = true; publisherConfig.transportBaseUrl = `http://127.0.0.1:${address.port}`; protectedJson(profile.foreground_policy, foreground); protectedJson(profile.publisher_config, publisherConfig);
  const bin = join(value.root, "proposal-bin"), gh = join(bin, "gh"); mkdirSync(bin, { mode: 0o700 }); writeFileSync(gh, "#!/bin/sh\nif [ \"$3\" = \"--help\" ] || [ \"$2\" = \"--help\" ]; then echo 'usage: gh auth token --hostname HOST --user LOGIN --no-refresh'; exit 0; fi\necho fixture-token\n", { mode: 0o700 }); chmodSync(gh, 0o700); const environment = { DELIVERY_OPERATOR_GRANT: "proposal-grant", PATH: `${bin}:${process.env.PATH ?? ""}` };
  registry.bind(identity, value.profile, 0, "setup_proposal_reconcile_001"); const spool = new ProposalSpool(store);
  const seedDead = (proposal: ReturnType<ProposalSpool["read"]>, action: "publish_issue" | "retry_issue" = "publish_issue") => { const requestId = `${action === "publish_issue" ? "publish" : "retry"}_${digest({ proposal_id: proposal.id, proposal_digest: proposal.content_digest }).slice(0, 24)}`, inputDigest = digest({ repo: identity.repo, action, proposal_id: proposal.id, proposal_digest: proposal.content_digest }), reserved = registry.reserveCommand(identity.repo, { action, delivery_id: proposal.id, request_id: requestId, input_digest: inputDigest, draft_digest: proposal.content_digest, allow_stopped: true }).operation!.token; registry.markCommandEffect(identity.repo, reserved, digest({ repo: identity.repo, id: proposal.id, content_digest: proposal.content_digest }).slice(0, 24)); registry.mutateSession(identity.repo, undefined, (session) => { if (session.operation) { session.operation.owner_pid = 99_999_999; session.operation.owner_process_identity = "dead-proposal-owner"; } return session; }); };
  const queued = spool.enqueue({ repo: identity.repo, repositoryId: 77, actorId: 7, title: "Queued recovery", body: "Publish once" }); seedDead(queued);
  const published = await invokeAsyncFrom(value, value.work, ["draft-publish", "--profile", value.profile, "--repo", identity.repo, "--digest", queued.content_digest, queued.id], environment); assert.equal(published.status, 0, `${published.stdout}\n${published.stderr}`); assert.equal(posts, 1); assert.equal(spool.read(identity.repo, queued.id).status, "published"); assert.equal(registry.readSession(identity.repo).operation, undefined);
  const uncertain = spool.enqueue({ repo: identity.repo, repositoryId: 77, actorId: 7, title: "Journal readback", body: "Do not duplicate" }); spool.authorize(identity.repo, uncertain.id, uncertain.content_digest); const operationId = digest({ repo: identity.repo, id: uncertain.id, content_digest: uncertain.content_digest }).slice(0, 24), request = { schema_version: 1, action: "publish_issue", repo: identity.repo, target_repo: identity.repo, delivery_id: uncertain.id, operation_id: operationId, expected_revision: 1, payload: { title: uncertain.title, body: uncertain.body } };
  await new Publisher({ ...publisherConfig, tokenResolver: async () => "fixture-token" }).execute({ ...request, authorized_digest: publicationAuthorizationDigest(request) }); assert.equal(posts, 2);
  const proposalPath = join(store.repoDir(identity.repo), "proposals", uncertain.id, "proposal.json"), retained = spool.read(identity.repo, uncertain.id); retained.status = "uncertain"; retained.operation = { id: operationId, request_digest: publicationAuthorizationDigest(request), error: "simulated response loss" }; store.writeProtected(proposalPath, retained); seedDead(retained);
  const retried = await invokeAsyncFrom(value, value.work, ["draft-retry", "--profile", value.profile, "--repo", identity.repo, "--publisher-config", profile.publisher_config, "--digest", retained.content_digest, retained.id], environment); assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`); assert.equal(posts, 2); assert.equal(spool.read(identity.repo, retained.id).status, "published"); assert.equal(registry.readSession(identity.repo).operation, undefined);
  const killed = spool.enqueue({ repo: identity.repo, repositoryId: 77, actorId: 7, title: "Killed after acceptance", body: "Read the journal" }); holdPost = true; const killedChild = spawn(process.execPath, ["--experimental-strip-types", cli, "draft-publish", "--profile", value.profile, "--repo", identity.repo, "--digest", killed.content_digest, killed.id], { cwd: value.work, env: cliEnv(value.registry, environment), stdio: "ignore" }); context.after(() => { if (killedChild.exitCode === null) killedChild.kill("SIGKILL"); }); await waitFor(() => existsSync(heldPostStarted) && readFileSync(heldPostStarted, "utf8") === killed.title); killedChild.kill("SIGKILL"); await new Promise<void>((resolveExit) => killedChild.once("exit", () => resolveExit())); releasePost(); holdPost = false; await waitFor(() => spool.read(identity.repo, killed.id).status === "publishing"); assert.equal(registry.readSession(identity.repo).operation?.phase, "effect"); const postsAfterKill = posts;
  const killedRecovered = await invokeAsyncFrom(value, value.work, ["draft-publish", "--profile", value.profile, "--repo", identity.repo, "--digest", killed.content_digest, killed.id], environment); assert.equal(killedRecovered.status, 0, `${killedRecovered.stdout}\n${killedRecovered.stderr}`); assert.equal(posts, postsAfterKill); assert.equal(spool.read(identity.repo, killed.id).status, "published"); assert.equal(registry.readSession(identity.repo).operation, undefined);
  const killedRetry = spool.enqueue({ repo: identity.repo, repositoryId: 77, actorId: 7, title: "Killed before retry", body: "Retry reads the journal" }); holdPost = true; delete heldPost.release; const killedRetryChild = spawn(process.execPath, ["--experimental-strip-types", cli, "draft-publish", "--profile", value.profile, "--repo", identity.repo, "--digest", killedRetry.content_digest, killedRetry.id], { cwd: value.work, env: cliEnv(value.registry, environment), stdio: "ignore" }); context.after(() => { if (killedRetryChild.exitCode === null) killedRetryChild.kill("SIGKILL"); }); await waitFor(() => readFileSync(heldPostStarted, "utf8") === killedRetry.title); killedRetryChild.kill("SIGKILL"); await new Promise<void>((resolveExit) => killedRetryChild.once("exit", () => resolveExit())); releasePost(); holdPost = false; await waitFor(() => spool.read(identity.repo, killedRetry.id).status === "publishing"); const postsBeforeRetryReadback = posts;
  const killedRetried = await invokeAsyncFrom(value, value.work, ["draft-retry", "--profile", value.profile, "--repo", identity.repo, "--publisher-config", profile.publisher_config, "--digest", killedRetry.content_digest, killedRetry.id], environment); assert.equal(killedRetried.status, 0, `${killedRetried.stdout}\n${killedRetried.stderr}`); assert.equal(posts, postsBeforeRetryReadback); assert.equal(spool.read(identity.repo, killedRetry.id).status, "published"); assert.equal(registry.readSession(identity.repo).operation, undefined);
  const paused = spool.enqueue({ repo: identity.repo, repositoryId: 77, actorId: 7, title: "Paused pre-intent", body: "No effect while paused" }); seedDead(paused); registry.mutateSession(identity.repo, undefined, (session) => { session.generation = 1; session.status = "paused"; session.desired_state = "paused"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("paused-proposal-runner"); session.heartbeat_at = new Date().toISOString(); return session; }); const beforePausedPosts = posts;
  const pausedReadback = await invokeAsyncFrom(value, value.work, ["draft-publish", "--profile", value.profile, "--repo", identity.repo, "--digest", paused.content_digest, paused.id], environment); assert.equal(pausedReadback.status, 2, `${pausedReadback.stdout}\n${pausedReadback.stderr}`); assert.match(pausedReadback.json.error.message, /resume|pre-effect/i); assert.equal(posts, beforePausedPosts); assert.equal(spool.read(identity.repo, paused.id).status, "queued"); assert.equal(registry.readSession(identity.repo).operation, undefined);
  const pausedSession = registry.readSession(identity.repo), resumed = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(pausedSession.revision), "--request-id", "resume_paused_proposal_001", "--action", "resume"]); assert.equal(resumed.status, 0, resumed.stdout); const pausedPublished = await invokeAsyncFrom(value, value.work, ["draft-publish", "--profile", value.profile, "--repo", identity.repo, "--digest", paused.content_digest, paused.id], environment); assert.equal(pausedPublished.status, 0, `${pausedPublished.stdout}\n${pausedPublished.stderr}`); assert.equal(posts, beforePausedPosts + 1); assert.equal(spool.read(identity.repo, paused.id).status, "published");
});

test("proposal readback mode uses the locked reservation state after a concurrent Pause", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_proposal_pause_race_001"); const proposalId = "proposal-pause-race", proposalDigest = "a".repeat(64), requestId = `publish_${digest({ proposal_id: proposalId, proposal_digest: proposalDigest }).slice(0, 24)}`, inputDigest = digest({ repo: identity.repo, action: "publish_issue", proposal_id: proposalId, proposal_digest: proposalDigest });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("proposal-pause-race-owner"); session.heartbeat_at = new Date().toISOString(); session.operation = { kind: "command", token: "dead-proposal-pause-token", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-proposal-owner", action: "publish_issue", delivery_id: proposalId, request_id: requestId, input_digest: inputDigest, draft_digest: proposalDigest, phase: "effect" }; return session; });
  const staleSnapshot = registry.readSession(identity.repo); assert.equal(staleSnapshot.desired_state, "running"); const paused = controlRunner({ identity, expectedRevision: staleSnapshot.revision, requestId: "pause_between_snapshot_reserve_001", action: "pause" }, registry); assert.equal(paused.desired_state, "paused");
  const reserved = reserveProposalCommand(registry, identity.repo, { action: "publish_issue", delivery_id: proposalId, request_id: requestId, input_digest: inputDigest, draft_digest: proposalDigest, reconcile_effect: true }); assert.equal(reserved.readbackOnly, true); assert.equal(reserved.session.desired_state, "paused"); registry.finishReservation(identity.repo, reserved.token);
});

for (const control of ["pause", "stop"] as const) test(`workspace readback mode uses the locked reservation state after concurrent ${control}`, () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, `setup_workspace_${control}_race_001`);
  const deliveryId = `workspace-${control}-race`, requestId = `publish_plan_${control}_race_001`, inputDigest = digest({ repo: identity.repo, delivery_id: deliveryId, expected_revision: 1, request_id: requestId, action: "publish_plan", digest: "a".repeat(64) });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest(`workspace-${control}-owner`); session.heartbeat_at = new Date().toISOString(); session.operation = { kind: "command", token: `dead-workspace-${control}-token`, started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-workspace-owner", action: "publish_plan", delivery_id: deliveryId, request_id: requestId, input_digest: inputDigest, expected_revision: 1, draft_digest: "a".repeat(64), phase: "effect" }; return session; });
  const staleSnapshot = registry.readSession(identity.repo); assert.equal(staleSnapshot.desired_state, "running"); const controlled = controlRunner({ identity, expectedRevision: staleSnapshot.revision, requestId: `${control}_between_snapshot_reserve_001`, action: control }, registry); assert.equal(controlled.desired_state, control === "pause" ? "paused" : "stopped");
  const reserved = reserveWorkspaceCommand(registry, identity.repo, { action: "publish_plan", delivery_id: deliveryId, request_id: requestId, input_digest: inputDigest, expected_revision: 1, draft_digest: "a".repeat(64), reconcile_effect: true }); assert.equal(reserved.readbackOnly, true); assert.equal(reserved.session.desired_state, control === "pause" ? "paused" : "stopped"); registry.finishReservation(identity.repo, reserved.token);
});

test("stale or unauthorized cancellation does not leave a repository barrier", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_cancel_rollback_001");
  const store = new FileStateStore(value.state), active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "cancel-rollback", policy: policy() }), before = registry.readSession(identity.repo);
  const stale = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision + 1), "--request-id", "cancel_stale_rollback_001", "--action", "cancel"], { DELIVERY_OPERATOR_GRANT: "cancel-grant" });
  assert.equal(stale.status, 2, stale.stderr || stale.stdout); assert.equal(stale.json.error.code, "STALE_REVISION"); const afterStale = registry.readSession(identity.repo); assert.equal(afterStale.cancellation, undefined); assert.equal(afterStale.status, before.status); assert.equal(afterStale.desired_state, before.desired_state); assert.deepEqual(afterStale.requests, before.requests);
  const unauthorized = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", "cancel_unauthorized_001", "--action", "cancel"]);
  assert.equal(unauthorized.status, 2, unauthorized.stderr || unauthorized.stdout); assert.equal(unauthorized.json.error.code, "UNAUTHORIZED"); const afterUnauthorized = registry.readSession(identity.repo); assert.equal(afterUnauthorized.cancellation, undefined); assert.equal(afterUnauthorized.status, before.status); assert.equal(afterUnauthorized.desired_state, before.desired_state); assert.deepEqual(afterUnauthorized.requests, before.requests);
});

test("failed cancellation begin preserves a Stop accepted before its atomic reservation", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_cancel_stop_race_001");
  const store = new FileStateStore(value.state), active = new DeliveryEngine({ store, controlGrant: { token: "right-grant", repositories: [identity.repo], actions: ["cancel"] } }).start({ repo: identity.repo, issue: 17, deliveryId: "cancel-stop-race", policy: policy() });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("runner-token"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id; return session; });
  const originalReserve = registry.reserveCancellation.bind(registry); let stopRevision = 0;
  registry.reserveCancellation = ((repo, input) => { const stopped = controlRunner({ identity, expectedRevision: 1, requestId: "stop_during_cancel_001", action: "stop" }, registry); stopRevision = stopped.revision; return originalReserve(repo, input); }) as typeof registry.reserveCancellation;
  assert.throws(() => beginCoordinatedCancellation({ registry, engine: new DeliveryEngine({ store, controlGrant: { token: "right-grant", repositories: [identity.repo], actions: ["cancel"] } }), repo: identity.repo, deliveryId: active.delivery_id, expectedRevision: active.revision, requestId: "cancel_wrong_grant_001", inputDigest: digest({ repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, action: "cancel", draft_digest: null }), grant: "wrong-grant" }), /unauthorized/i);
  const after = registry.readSession(identity.repo); assert.ok(after.revision > stopRevision); assert.equal(after.cancellation, undefined); assert.equal(after.desired_state, "stopped"); assert.equal(after.status, "stopping"); assert.equal(after.requests.stop_during_cancel_001?.action, "stop");
});

test("completed cancellation replay does not stop a successor generation", async () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_cancel_replay_001");
  const store = new FileStateStore(value.state), engine = new DeliveryEngine({ store, controlGrant: { token: "cancel-grant", repositories: [identity.repo], actions: ["cancel"] } }), old = engine.start({ repo: identity.repo, issue: 17, deliveryId: "cancelled-predecessor", policy: policy() });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("old-runner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = old.delivery_id; return session; });
  const requestId = "cancel_completed_replay_001", inputDigest = digest({ repo: identity.repo, delivery_id: old.delivery_id, expected_revision: old.revision, action: "cancel", draft_digest: null }), completed = beginCoordinatedCancellation({ registry, engine, repo: identity.repo, deliveryId: old.delivery_id, expectedRevision: old.revision, requestId, inputDigest, grant: "cancel-grant" });
  assert.equal(await reconcileCoordinatedCancellation({ registry, engine, coordinated: completed }), "complete");
  const successor = engine.start({ repo: identity.repo, issue: 18, deliveryId: "successor-generation", policy: policy() });
  registry.mutateSession(identity.repo, undefined, (session) => { (session.cancellation_history ??= []).push(structuredClone(session.cancellation!)); delete session.cancellation; delete session.stopped_drained_ack_digest; session.generation = 2; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("new-runner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = successor.delivery_id; return session; });
  const beforeReplay = registry.readSession(identity.repo), replay = beginCoordinatedCancellation({ registry, engine, repo: identity.repo, deliveryId: old.delivery_id, expectedRevision: old.revision, requestId, inputDigest, grant: "cancel-grant" });
  assert.equal(replay.reservation.phase, "complete"); assert.equal(await reconcileCoordinatedCancellation({ registry, engine, coordinated: replay }), "complete"); assert.deepEqual(registry.readSession(identity.repo), beforeReplay);
  assert.throws(() => beginCoordinatedCancellation({ registry, engine, repo: identity.repo, deliveryId: old.delivery_id, expectedRevision: old.revision, requestId, inputDigest: "f".repeat(64), grant: "cancel-grant" }), /different|conflict/i); assert.deepEqual(registry.readSession(identity.repo), beforeReplay);
});

test("same-epoch concurrent cancellation finalizers converge monotonically on complete", async () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry); registry.bind(identity, value.profile, 0, "setup_cancel_finalizer_barrier_001");
  const store = new FileStateStore(value.state), engine = new DeliveryEngine({ store, controlGrant: { token: "cancel-grant", repositories: [identity.repo], actions: ["cancel"] } }), active = engine.start({ repo: identity.repo, issue: 17, deliveryId: "cancel-finalizer-barrier", policy: policy() });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("cancel-finalizer-owner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id; return session; });
  const requestId = "cancel_finalizer_barrier_001", inputDigest = digest({ repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, action: "cancel", draft_digest: null }), coordinated = beginCoordinatedCancellation({ registry, engine, repo: identity.repo, deliveryId: active.delivery_id, expectedRevision: active.revision, requestId, inputDigest, grant: "cancel-grant" }), result = await engine.reconcileCancellation(coordinated.context, {});
  let arrivals = 0, release!: () => void; const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  engine.reconcileCancellation = (async () => { arrivals += 1; if (arrivals === 2) release(); await gate; return result; }) as typeof engine.reconcileCancellation;
  const completions = await Promise.all([reconcileCoordinatedCancellation({ registry, engine, coordinated }), reconcileCoordinatedCancellation({ registry, engine, coordinated })]); assert.deepEqual(completions, ["complete", "complete"]);
  const completed = registry.readSession(identity.repo), token = completed.cancellation!.token; assert.equal(completed.cancellation?.phase, "complete"); assert.equal(completed.status, "stopped");
  const staleFinalizer = registry.updateCancellationPhase(identity.repo, token, "draining"); assert.equal(staleFinalizer.cancellation?.phase, "complete"); assert.equal(staleFinalizer.revision, completed.revision);
});

test("dead cancellation observer takeover preserves the bound token and epoch", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-cancel-observer-"))), ready = join(root, "ready"), repositoryUrl = pathToFileURL(fileURLToPath(new URL("../src/repository.ts", import.meta.url))).href;
  const input = { delivery_id: "delivery-observer", request_id: "cancel_observer_001", input_digest: "a".repeat(64), expected_revision: 1, generation: 0, owner_token_digest: "b".repeat(64) }, epoch = "c".repeat(64);
  const program = `import{writeFileSync}from'node:fs';import{RepositoryRegistry}from ${JSON.stringify(repositoryUrl)};const r=new RepositoryRegistry(${JSON.stringify(root)}),s=r.reserveCancellation('owner/repo',${JSON.stringify(input)}),token=s.cancellation.token;r.bindCancellationEpoch('owner/repo',token,${JSON.stringify(epoch)});writeFileSync(${JSON.stringify(ready)},token);setInterval(()=>{},1000)`;
  const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: "ignore" }); context.after(() => { try { owner.kill("SIGKILL"); } catch {} });
  await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8").length > 0); owner.kill("SIGKILL"); await new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
  const originalToken = readFileSync(ready, "utf8"), taken = new RepositoryRegistry(root).reserveCancellation("owner/repo", input).cancellation!;
  assert.equal(taken.token, originalToken); assert.equal(taken.epoch, epoch); assert.equal(taken.phase, "reconciling"); assert.equal(taken.owner_pid, process.pid);
});

test("worker exit failure preserves exact cancellation ownership and diagnostics", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-worker-exit-failure-"))), repo = "owner/repo", registry = new RepositoryRegistry(root), ownerIdentity = processIdentity(process.pid)!;
  registry.mutateSession(repo, 0, (session) => {
    session.generation = 1; session.status = "stopping"; session.desired_state = "stopped"; session.owner_pid = process.pid; session.owner_process_identity = ownerIdentity; session.owner_token_digest = digest("exit-owner");
    session.operation = { kind: "worker", token: "worker_exit_operation", started_at: new Date().toISOString(), owner_pid: process.pid, owner_process_identity: ownerIdentity, generation: 1, owner_token_digest: session.owner_token_digest, phase: "effect", effect_admission: "stopping_drain", delivery_id: "delivery-exit", operation_id: "execution-exit" };
    session.cancellation = { kind: "cancellation", token: "cancellation_exit_token", started_at: new Date().toISOString(), owner_pid: process.pid, owner_process_identity: ownerIdentity, delivery_id: "delivery-exit", request_id: "cancel_exit_001", input_digest: "a".repeat(64), expected_revision: 7, epoch: "b".repeat(64), phase: "reconciling", generation: 1, owner_token_digest: session.owner_token_digest };
    return session;
  });
  const failed = registry.recordWorkerExitFailure(repo, 1, digest("exit-owner"), ownerIdentity, new Error("original\ntransition failure"))!;
  assert.equal(failed.status, "uncertain"); assert.equal(failed.desired_state, "stopped"); assert.equal(failed.owner_pid, process.pid); assert.equal(failed.owner_process_identity, ownerIdentity);
  assert.equal(failed.operation?.token, "worker_exit_operation"); assert.equal(failed.cancellation?.token, "cancellation_exit_token"); assert.equal(failed.reason, "original transition failure");
});

test("public Recover finalizes one exact dead terminal cancellation without launching a successor", { timeout: 30_000 }, async () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), profile = JSON.parse(readFileSync(value.profile, "utf8"));
  profile.executor.argv = [process.execPath, "-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({manifest:{schema_version:1,kind:'rank',repo:p.repo,delivery_id:p.delivery_id,result:{winner:17,shortlist:[17]}},implementer_identity:'dead-recovery-fixture'}))})"];
  protectedJson(value.profile, profile); registry.bind(identity, value.profile, 0, "setup_dead_cancel_recover_001");
  const store = new FileStateStore(value.state), adapter = new ExecutableJsonAdapter({ argv: profile.executor.argv, cwd: value.work, stateDir: join(value.state, "executor-processes") });
  const engine = new DeliveryEngine({ store, executor: adapter, controlGrant: { token: "dead-recover-grant", repositories: [identity.repo], actions: ["cancel"] } });
  let state = engine.start({ repo: identity.repo, issue: 17, deliveryId: "dead-cancel-recover", policy: policy() });
  state = store.mutate(identity.repo, state.delivery_id, state.revision, (current) => { current.rank_snapshot = { coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 }, issues: [{ number: 17, state: "open", pull_request: false, labels: [] }], open_prs: [], dependencies: [{ issue: 17, blocked_by: [], unresolved: [] }] }; return current; });
  state = await engine.dispatch(identity.repo, state.delivery_id, state.revision);
  await assert.rejects(engine.collect(identity.repo, state.delivery_id, state.revision), /rank manifest is out of order/);
  state = store.read(identity.repo, state.delivery_id); const execution = state.executions[0]!;
  assert.equal(execution.status, "completed"); assert.ok(execution.external_id); assert.ok(execution.proof_digest);
  const cancellationRequest = "cancel_dead_recover_001", inputDigest = digest({ repo: identity.repo, delivery_id: state.delivery_id, expected_revision: state.revision, action: "cancel", draft_digest: null });
  const cancellationContext = { repo: identity.repo, delivery_id: state.delivery_id, expected_revision: state.revision, request_id: cancellationRequest, input_digest: inputDigest, repository_generation: 1, grant: "dead-recover-grant" };
  const begun = engine.beginCancellation(cancellationContext);
  const workerOwner = dummyOwner(), cancellationOwner = dummyOwner(), workerIdentity = processIdentity(workerOwner.pid!)!, cancellationIdentity = processIdentity(cancellationOwner.pid!)!;
  workerOwner.kill("SIGKILL"); cancellationOwner.kill("SIGKILL"); await Promise.all([new Promise<void>((resolve) => workerOwner.once("exit", () => resolve())), new Promise<void>((resolve) => cancellationOwner.once("exit", () => resolve()))]);
  const ownerTokenDigest = digest("dead-recovery-owner");
  registry.mutateSession(identity.repo, 0, (session) => {
    session.generation = 1; session.status = "stopping"; session.desired_state = "stopped"; session.owner_pid = workerOwner.pid!; session.owner_process_identity = workerIdentity; session.owner_token_digest = ownerTokenDigest; session.delivery_id = state.delivery_id;
    session.operation = { kind: "worker", token: "dead_recovery_operation", started_at: new Date().toISOString(), owner_pid: workerOwner.pid!, owner_process_identity: workerIdentity, generation: 1, owner_token_digest: ownerTokenDigest, phase: "effect", effect_admission: "stopping_drain", delivery_id: state.delivery_id, operation_id: execution.id };
    session.cancellation = { kind: "cancellation", token: "dead_recovery_cancellation", started_at: new Date().toISOString(), owner_pid: cancellationOwner.pid!, owner_process_identity: cancellationIdentity, delivery_id: state.delivery_id, request_id: cancellationRequest, input_digest: inputDigest, expected_revision: state.revision, epoch: begun.epoch, phase: "reconciling", generation: 1, owner_token_digest: ownerTokenDigest };
    return session;
  });
  const wrongOperation = registry.mutateSession(identity.repo, 1, (session) => { session.operation!.operation_id = "wrong-terminal-execution"; return session; });
  const refused = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", "2", "--request-id", "recover_dead_cancel_refused", "--action", "recover"], { DELIVERY_OPERATOR_GRANT: "dead-recover-grant" });
  assert.equal(refused.status, 2, refused.stdout); const preserved = registry.readSession(identity.repo); assert.equal(preserved.operation?.operation_id, "wrong-terminal-execution"); assert.equal(preserved.owner_pid, workerOwner.pid); assert.equal(preserved.cancellation?.token, "dead_recovery_cancellation"); assert.equal(preserved.recovery, undefined);
  const restored = registry.mutateSession(identity.repo, preserved.revision, (session) => { session.operation!.operation_id = execution.id; return session; });
  const recovered = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(restored.revision), "--request-id", "recover_dead_cancel_001", "--action", "recover"], { DELIVERY_OPERATOR_GRANT: "dead-recover-grant" });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  const finalSession = registry.readSession(identity.repo), finalState = store.read(identity.repo, state.delivery_id);
  assert.equal(finalSession.generation, 1); assert.equal(finalSession.owner_pid, null); assert.equal(finalSession.status, "stopped"); assert.equal(finalSession.operation, undefined); assert.equal(finalSession.recovery, undefined);
  assert.equal(finalSession.cancellation?.phase, "complete"); assert.equal(finalSession.requests.recover_dead_cancel_001?.status, "completed"); assert.equal(finalState.claim_status, "released"); assert.equal(finalState.controls.cancellation?.phase, "complete"); assert.equal(finalState.executions.length, 1);
  registry.mutateSession(identity.repo, finalSession.revision, (session) => { session.requests.recover_dead_cancel_001!.status = "reconciled"; return session; });
  const replay = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(restored.revision), "--request-id", "recover_dead_cancel_001", "--action", "recover"], { DELIVERY_OPERATOR_GRANT: "dead-recover-grant" });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout); const replayed = registry.readSession(identity.repo); assert.equal(replayed.generation, 1); assert.equal(replayed.requests.recover_dead_cancel_001?.status, "completed");
});

test("standalone profile cancellation reconciles and finalizes through the shared coordinator", () => {
  const value = fixture(), identity = resolveRepository(value.work), store = new FileStateStore(value.state), active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "standalone-cancel", policy: policy() });
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "cancel", "--profile", value.profile, "--repo", identity.repo, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", "standalone_cancel_001"], { cwd: value.work, encoding: "utf8", env: cliEnv(value.registry, { DELIVERY_OPERATOR_GRANT: "standalone-grant" }), timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout); const final = store.read(identity.repo, active.delivery_id), session = new RepositoryRegistry(value.registry).readSession(identity.repo); assert.equal(final.claim_status, "released"); assert.equal(final.controls.cancellation?.phase, "complete"); assert.equal(session.cancellation?.phase, "complete");
});

test("Stop drain adopts an exact coordinated cancellation before release", { timeout: 60_000 }, async (context) => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), profile = JSON.parse(readFileSync(value.profile, "utf8")), publisherPath = profile.publisher_config, publisher = JSON.parse(readFileSync(publisherPath, "utf8")); publisher.testOnly = true; protectedJson(publisherPath, publisher); profile.executor.argv = [process.execPath, "-e", "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1000));setInterval(() => {}, 1000)"]; protectedJson(value.profile, profile); registry.bind(identity, value.profile, 0, "setup_live_cancel_001");
  const store = new FileStateStore(value.state), executable = new ExecutableJsonAdapter({ argv: profile.executor.argv, cwd: value.work, stateDir: join(value.state, "executor-processes") }), engine = new DeliveryEngine({ store, executor: executable, controlGrant: { token: "cancel-grant", repositories: [identity.repo], actions: ["cancel"] } });
  let seeded = engine.start({ repo: identity.repo, issue: 17, deliveryId: "live-cancel", policy: policy() });
  seeded = store.mutate(identity.repo, seeded.delivery_id, seeded.revision, (state) => { state.rank_snapshot = { coverage: { issues_complete: true, open_prs_complete: true, unresolved_count: 0 }, issues: [{ number: 17, state: "open", pull_request: false, labels: [] }], open_prs: [], dependencies: [{ issue: 17, blocked_by: [], unresolved: [] }] }; return state; });
  seeded = await engine.dispatch(identity.repo, seeded.delivery_id, seeded.revision); assert.equal(seeded.runner.status, "running");
  const environment = { DELIVERY_OPERATOR_GRANT: "cancel-grant", DELIVERY_RUNNER_POLL_MS: "2000" };
  const token = "live-cancel-owner-token", worker = spawn(process.execPath, ["--experimental-strip-types", cli, "runner-worker", "--directory", value.work, "--generation", "1", "--token", token], { env: cliEnv(value.registry, environment), stdio: "ignore" }); assert.ok(worker.pid); context.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "running"; session.desired_state = "running"; session.owner_pid = worker.pid!; session.owner_process_identity = processIdentity(worker.pid!); session.owner_token_digest = digest(token); session.owner_started_at = new Date().toISOString(); session.heartbeat_at = new Date().toISOString(); session.delivery_id = seeded.delivery_id; return session; });
  try { await waitFor(() => { const session = registry.readSession(identity.repo), active = store.list(identity.repo).find((state) => state.claim_status === "active"); return session.operation?.kind === "worker" && session.operation.phase === "effect" && active?.runner.status === "running"; }, 30_000); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)} session=${JSON.stringify(registry.readSession(identity.repo))} states=${JSON.stringify(store.list(identity.repo).map((state) => ({ status: state.status, claim: state.claim_status, runner: state.runner, executions: state.executions.map((execution) => ({ id: execution.id, kind: execution.kind, stage: execution.stage, status: execution.status, external_id: execution.external_id })) })))}`); }
  await waitFor(() => !registry.readSession(identity.repo).operation, 10_000); const running = registry.readSession(identity.repo), stopped = invoke(value, ["runner-control", "--directory", value.work, "--expected-revision", String(running.revision), "--request-id", "stop_before_cancel_001", "--action", "stop"], environment); assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  await waitFor(() => { const session = registry.readSession(identity.repo); return session.operation?.kind === "worker" && session.operation.phase === "effect" && session.operation.effect_admission === "stopping_drain"; }, 15_000);
  const active = store.list(identity.repo).find((state) => state.claim_status === "active")!;
  const requestId = "cancel_live_worker_001", inputDigest = digest({ repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, request_id: requestId, action: "cancel", digest: null });
  const beforePrepare = registry.readSession(identity.repo), prepared = registry.reserveCancellation(identity.repo, { delivery_id: active.delivery_id, request_id: requestId, input_digest: inputDigest, expected_revision: active.revision, generation: beforePrepare.generation, owner_token_digest: beforePrepare.owner_token_digest! });
  assert.match(prepared.reservation.epoch, /^pending:/); const retainedToken = prepared.operation?.token; assert.ok(retainedToken);
  await new Promise((resolve) => setTimeout(resolve, 350)); const duringPrepare = registry.readSession(identity.repo);
  assert.equal(duringPrepare.operation?.token, retainedToken, "pending cancellation preparation must retain the exact live worker reservation"); assert.equal(duringPrepare.owner_pid, worker.pid); assert.equal(worker.exitCode, null);
  const contextValue = { repo: identity.repo, delivery_id: active.delivery_id, expected_revision: active.revision, request_id: requestId, input_digest: inputDigest, repository_generation: beforePrepare.generation, grant: "cancel-grant" };
  const begun = engine.beginCancellation(contextValue); registry.bindCancellationEpoch(identity.repo, prepared.reservation.token, begun.epoch);
  await waitFor(() => registry.readSession(identity.repo).status === "stopped" && store.read(identity.repo, active.delivery_id).claim_status === "released", 30_000);
  const final = store.read(identity.repo, active.delivery_id), session = registry.readSession(identity.repo); assert.equal(final.status, "cancelled"); assert.equal(final.controls.cancellation?.phase, "complete"); assert.equal(session.cancellation?.phase, "complete"); assert.equal(session.operation, undefined); assert.equal(session.owner_pid, null);
});

test("review retry validation failure retires its stopped reservation without authorizing work", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state);
  registry.bind(identity, value.profile, 0, "setup_refused_review_retry_001");
  let active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "refused-review-retry", policy: policy() });
  active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.status = "blocked"; return state; });
  const requestId = "unproven_review_retry_001";
  const unauthorized = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "retry_review"], { DELIVERY_OPERATOR_GRANT: "" });
  assert.equal(unauthorized.status, 2, unauthorized.stdout); assert.equal(unauthorized.json.error?.code, "UNAUTHORIZED");
  assert.equal(registry.readSession(identity.repo).operation, undefined);
  const result = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "retry_review"], { DELIVERY_OPERATOR_GRANT: "retry-grant" });
  assert.equal(result.status, 2, result.stdout);
  assert.notEqual(result.json.error?.code, "INVALID_ARGUMENT", result.stdout);
  assert.equal(registry.readSession(identity.repo).operation, undefined, "a refused local authorization must not strand its reservation");
  assert.equal(registry.readSession(identity.repo).desired_state, "stopped");
  const after = store.read(identity.repo, active.delivery_id);
  assert.equal(after.revision, active.revision); assert.equal(after.controls.requests[requestId], undefined); assert.equal(after.executions.length, 0);
  const bypass = invoke(value, ["retry-review", "--profile", value.profile, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", "legacy_review_retry_001"], { DELIVERY_OPERATOR_GRANT: "retry-grant" });
  assert.equal(bypass.status, 2, bypass.stdout); assert.equal(bypass.json.error?.code, "RUNNER_BARRIER");
  assert.equal(store.read(identity.repo, active.delivery_id).revision, active.revision);
});

test("paused runner refuses new reviewer retry authorization before reserving a command", () => {
  const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state);
  registry.bind(identity, value.profile, 0, "setup_paused_review_retry_001");
  const active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: "paused-review-retry", policy: policy() });
  registry.mutateSession(identity.repo, 0, (session) => { session.generation = 1; session.status = "paused"; session.desired_state = "paused"; session.owner_pid = process.pid; session.owner_process_identity = processIdentity(process.pid); session.owner_token_digest = digest("paused-retry-runner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id; return session; });
  const result = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", "paused_review_retry_001", "--action", "retry_review"], { DELIVERY_OPERATOR_GRANT: "retry-grant" });
  assert.equal(result.status, 2, result.stdout); assert.equal(result.json.error?.code, "RUNNER_BARRIER");
  assert.equal(registry.readSession(identity.repo).operation, undefined); assert.equal(registry.readSession(identity.repo).desired_state, "paused");
  assert.equal(store.read(identity.repo, active.delivery_id).revision, active.revision);
});

test("dead reviewer retry readback retires absent authorization and never retries from readback", () => {
  for (const desired of ["running", "paused", "stopped"] as const) {
    const value = fixture(), identity = resolveRepository(value.work), registry = new RepositoryRegistry(value.registry), store = new FileStateStore(value.state);
    registry.bind(identity, value.profile, 0, `setup_dead_retry_${desired}_001`);
    const active = new DeliveryEngine({ store }).start({ repo: identity.repo, issue: 17, deliveryId: `dead-retry-${desired}`, policy: policy() });
    const requestId = `absent_review_retry_${desired}_001`, inputDigest = repositoryCommandInputDigest({ repo: identity.repo, deliveryId: active.delivery_id, expectedRevision: active.revision, requestId, action: "retry_review" });
    registry.mutateSession(identity.repo, 0, (session) => {
      session.generation = 1; session.status = desired; session.desired_state = desired;
      session.owner_pid = desired === "stopped" ? null : process.pid;
      if (desired !== "stopped") session.owner_process_identity = processIdentity(process.pid);
      session.owner_token_digest = digest("dead-retry-runner"); session.heartbeat_at = new Date().toISOString(); session.delivery_id = active.delivery_id;
      session.operation = { kind: "command", token: "dead-review-retry-command", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-command-owner", action: "retry_review", delivery_id: active.delivery_id, request_id: requestId, input_digest: inputDigest, expected_revision: active.revision, phase: "effect", operation_id: requestId };
      return session;
    });
    const result = invoke(value, ["workspace-command", "--directory", value.work, "--delivery-id", active.delivery_id, "--expected-revision", String(active.revision), "--request-id", requestId, "--action", "retry_review"], { DELIVERY_OPERATOR_GRANT: "retry-grant" });
    assert.equal(result.status, 2, result.stdout); assert.match(result.json.error?.message, /proven absent.*explicitly replay/i);
    assert.equal(registry.readSession(identity.repo).operation, undefined); assert.equal(registry.readSession(identity.repo).desired_state, desired);
    const after = store.read(identity.repo, active.delivery_id);
    assert.equal(after.revision, active.revision); assert.equal(after.controls.requests[requestId], undefined); assert.equal(after.executions.length, 0);
  }
});
