import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "../src/cli.ts";
import { DeliveryError } from "../src/core.ts";
import { DeliveryEngine, repositoryCommandInputDigest } from "../src/engine.ts";
import { processIdentity } from "../src/process-identity.ts";
import { RepositoryRegistry } from "../src/repository.ts";
import { acceptedReviewerWaitIdentity } from "../src/runner.ts";
import { reviewBody, reviewContext } from "../src/reviews.ts";
import { FileStateStore } from "../src/store.ts";

type Json = Record<string, any>;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(packageRoot, "src", "cli.ts");
const fixtureHost = join(packageRoot, "test", "fixtures", "repository-host.ts");

function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function processGroup(pid: number): number | undefined { try { return Number(execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).trim()); } catch { return undefined; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((accept, reject) => {
    const started = Date.now();
    const poll = () => {
      try { readFileSync(path); accept(); }
      catch { if (Date.now() - started >= timeoutMs) reject(new Error(`timed out waiting for ${path}`)); else setTimeout(poll, 25); }
    };
    poll();
  });
}

function command(cwd: string, environment: NodeJS.ProcessEnv, args: string[], input?: unknown): Json {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd, env: environment, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.signal, null, `CLI signal ${result.signal}: ${result.stderr}`);
  const envelope = JSON.parse(result.stdout.trim()) as Json;
  assert.equal(result.status, 0, `${JSON.stringify(envelope)}\n${result.stderr}`); assert.equal(envelope.ok, true, `${JSON.stringify(envelope)}\n${result.stderr}`);
  return envelope;
}

function rawCommand(cwd: string, environment: NodeJS.ProcessEnv, args: string[]): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; envelope?: Json } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  let envelope: Json | undefined; try { envelope = JSON.parse(result.stdout.trim()) as Json; } catch { /* retain raw diagnostics */ }
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, ...(envelope ? { envelope } : {}) };
}

async function drainOwnedRunner(worktree: string, repo: string, registryRoot: string, environment: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<void> {
  const registry = new RepositoryRegistry(registryRoot), deadline = Date.now() + timeoutMs; let last = "runner cleanup did not observe a session";
  while (Date.now() < deadline) {
    const session = registry.readSession(repo), observed = registry.observe(session), recordedIdentity = session.owner_process_identity, currentIdentity = session.owner_pid ? processIdentity(session.owner_pid) : undefined;
    last = JSON.stringify({ status: session.status, desired: session.desired_state, revision: session.revision, observed: observed.status, ownerPid: session.owner_pid, recordedIdentity, currentIdentity, inFlight: session.in_flight?.token });
    if (session.status === "stopped" && session.owner_pid === null && !session.in_flight) return;
    if (session.owner_pid !== null && recordedIdentity && currentIdentity === recordedIdentity && session.desired_state !== "stopped") {
      const stop = rawCommand(worktree, environment, ["runner-control", "--directory", worktree, "--expected-revision", String(session.revision), "--request-id", `cleanup_stop_${session.generation}`, "--action", "stop"]);
      if (stop.status !== 0 && !["STALE_REVISION", "REQUEST_CONFLICT"].includes(String(stop.envelope?.error?.code))) last = `${last} stop=${JSON.stringify(stop.envelope ?? { status: stop.status, signal: stop.signal, stderr: stop.stderr, stdout: stop.stdout })}`;
    } else if (session.owner_pid !== null && (!recordedIdentity || currentIdentity !== recordedIdentity)) {
      throw new Error(`runner cleanup retained evidence because exact owner identity is not live: ${last}`);
    }
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(`runner cleanup timed out before exact owner drain: ${last}`);
}

async function commandWhenBarrierClears(cwd: string, environment: NodeJS.ProcessEnv, args: string[], timeoutMs = 15_000): Promise<Json> {
  const started = Date.now(); args = [...args];
  while (true) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.signal, null, `CLI signal ${result.signal}: ${result.stderr}`); const envelope = JSON.parse(result.stdout.trim()) as Json;
    if (result.status === 0 && envelope.ok === true) return envelope;
    if (!["RUNNER_BARRIER", "STALE_REVISION"].includes(String(envelope.error?.code)) || Date.now() - started >= timeoutMs) assert.fail(`${JSON.stringify(envelope)}\n${result.stderr}`);
    if (envelope.error?.code === "STALE_REVISION") {
      const deliveryId = args[args.indexOf("--delivery-id") + 1];
      const run = command(cwd, environment, ["workspace-status", "--directory", cwd]).data.runs.find((item: Json) => item.deliveryId === deliveryId);
      assert.ok(run, "the exact delivery disappeared while waiting for its barrier");
      const digestIndex = args.indexOf("--digest");
      if (digestIndex >= 0) assert.equal(run.draft?.digest, args[digestIndex + 1], "the protected publication draft changed");
      const revisionIndex = args.indexOf("--expected-revision"); assert.ok(revisionIndex >= 0);
      args[revisionIndex + 1] = String(run.revision);
    }
    await new Promise((accept) => setTimeout(accept, 25));
  }
}

async function managedManualCommand(cwd: string, environment: NodeJS.ProcessEnv, repository: Json, deliveryId: string, commandName: "export-handoff" | "bind-manual-pr", stage: "plan" | "implementation", requestId: string, number?: number): Promise<Json> {
  const started = Date.now();
  while (true) {
    const run = command(cwd, environment, ["workspace-status", "--directory", cwd]).data.runs.find((item: Json) => item.deliveryId === deliveryId), args = [commandName, "--profile", repository.profile, "--repo", repository.repo, "--delivery-id", deliveryId, "--expected-revision", String(run.revision), "--stage", stage, "--request-id", requestId, ...(number === undefined ? [] : ["--number", String(number)])], result = rawCommand(cwd, environment, args);
    if (result.status === 0 && result.envelope?.ok === true) return result.envelope;
    if (!["RUNNER_BARRIER", "STALE_REVISION"].includes(String(result.envelope?.error?.code)) || Date.now() - started >= 15_000) {
      const registry = environment.DELIVERY_REGISTRY_DIR ? new RepositoryRegistry(environment.DELIVERY_REGISTRY_DIR).readSession(repository.repo) : undefined;
      assert.fail(`${JSON.stringify(result.envelope)}\n${result.stderr}\nregistry=${JSON.stringify(registry)}`);
    }
    await new Promise((accept) => setTimeout(accept, 25));
  }
}

async function eventuallyRejected(cwd: string, environment: NodeJS.ProcessEnv, args: string[], expectedCode: string): Promise<void> {
  const started = Date.now();
  while (true) { const result = rawCommand(cwd, environment, args); if (result.envelope?.error?.code === expectedCode) return; if (result.envelope?.error?.code !== "RUNNER_BARRIER" || Date.now() - started >= 15_000) assert.fail(JSON.stringify(result.envelope)); await new Promise((accept) => setTimeout(accept, 25)); }
}

async function eventually(operation: () => Json, predicate: (value: Json) => boolean, timeoutMs = 60_000): Promise<Json> {
  const started = Date.now(); let value = operation();
  while (!predicate(value)) { if (Date.now() - started >= timeoutMs) throw new Error(`timed out with ${JSON.stringify(value)}`); await new Promise((accept) => setTimeout(accept, 75)); value = operation(); }
  return value;
}

async function fixtureControl(url: string, path: string, payload: Json): Promise<void> {
  let response: Response;
  try { response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(payload) }); }
  catch (error) { const cause = error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined; throw new Error(`${path} fetch failed: ${error instanceof Error ? error.message : String(error)} cause=${cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause)}`); }
  assert.equal(response.ok, true, `${path}: ${response.status} ${await response.text()}`);
}

async function fixtureStatus(url: string, repo: string): Promise<Json> {
  const response = await fetch(`${url}/fixture/status`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ repo }) });
  const raw = await response.text(); assert.equal(response.ok, true, raw); return JSON.parse(raw) as Json;
}

async function publishManualPull(fixture: Json, repository: Json, handoff: Json): Promise<number> {
  const pushed = spawnSync("git", ["push", repository.remote, `${handoff.head_sha}:refs/heads/${handoff.head}`], { cwd: repository.worktree, encoding: "utf8" }); assert.equal(pushed.status, 0, pushed.stderr);
  const response = await fetch(`${fixture.url}/repos/${repository.repo}/pulls`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ title: handoff.title, body: handoff.body, head: handoff.head, base: handoff.base, draft: true }) });
  const body = await response.text(); assert.equal(response.status, 201, body); const pull = JSON.parse(body) as Json; assert.equal(pull.head.sha, handoff.head_sha); assert.equal(pull.base.sha, handoff.base_sha); return pull.number;
}

function exactReviewReceipt(stateDir: string, repo: string, deliveryId: string, stage: "plan" | "implementation"): string {
  const state = new FileStateStore(stateDir).read(repo, deliveryId), manifest = state.manifests[stage === "plan" ? "plan" : "implement"]!;
  const point = manifest.value.result[stage === "plan" ? "baseline" : "base"] as Json;
  const context = reviewContext({ stage, generation: manifest.generation, issue: state.issue!, material_hashes: { manifest: manifest.material_digest }, baseline_sha: point.sha, base_repo: point.repo, base_ref: point.ref, base_sha: point.sha, final_repo: state.repo, final_ref: state.policy_values.delivery.final_target, policy_digest: state.policy.digest });
  return reviewBody(stage, manifest.generation, context, "approve");
}

function publicApproveReceipt(run: Json, expected: string): string {
  const prefix = "Approve with this exact review body: ", instruction = run.review?.instructions?.find((value: unknown) => typeof value === "string" && value.startsWith(prefix));
  assert.equal(typeof instruction, "string", JSON.stringify(run.review)); const receipt = instruction.slice(prefix.length); assert.equal(receipt, expected); return receipt;
}

test("shipped CLI isolates repositories and drives one explicit delivery through exact gates", { timeout: 180_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-journey-"))), manifestPath = join(root, "manifest.json"), registry = join(root, "registry"); let host: ChildProcess | undefined, hostError = "", primaryError: unknown, cleanupError: unknown, cleanupContext: { repoA: Json; environment: NodeJS.ProcessEnv } | undefined;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] });
    host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repoA = fixture.repositories.a, repoB = fixture.repositories.b;
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registry, DELIVERY_OPERATOR_GRANT: "fixture-local-control-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanupContext = { repoA, environment };

    const emptyA = command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]);
    assert.equal(emptyA.data.identity.repo, repoA.repo); assert.equal(emptyA.data.setup.configured, false); assert.equal(emptyA.data.runs.length, 0);
    const setupA = command(repoA.worktree, environment, ["workspace-setup", "--directory", repoA.worktree, "--expected-revision", "0", "--request-id", "fixture-setup-a"], { mode: "import", profilePath: repoA.profile });
    const setupB = command(repoB.worktree, environment, ["workspace-setup", "--directory", repoB.worktree, "--expected-revision", "0", "--request-id", "fixture-setup-b"], { mode: "import", profilePath: repoB.profile });
    assert.equal(setupA.data.setup.configured, true); assert.equal(setupB.data.setup.configured, true); assert.notEqual(setupA.data.identity.repo, setupB.data.identity.repo);

    const related = command(repoA.secondWorktree, environment, ["workspace-status", "--directory", repoA.secondWorktree]);
    const clone = command(repoA.clone, environment, ["workspace-status", "--directory", repoA.clone]);
    assert.equal(related.data.setup.configured, true); assert.equal(clone.data.setup.configured, true); assert.equal(related.data.setup.revision, setupA.data.setup.revision); assert.equal(clone.data.setup.revision, setupA.data.setup.revision); assert.equal(related.data.identity.repo, repoA.repo); assert.equal(clone.data.identity.repo, repoA.repo);

    let snapshot = command(repoA.worktree, environment, ["runner-control", "--directory", repoA.worktree, "--expected-revision", "0", "--request-id", "fixture-start-a", "--action", "start", "--issue", String(repoA.issue)]).data;
    assert.ok(["starting", "running"].includes(snapshot.runner.status), JSON.stringify(snapshot));
    snapshot = await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.availableActions?.includes("publish_plan"));
    let run = snapshot.runs[0]; assert.ok(run.draft?.digest, JSON.stringify(run));
    await commandWhenBarrierClears(repoA.worktree, environment, ["workspace-command", "--directory", repoA.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "fixture-publish-plan", "--action", "publish_plan", "--digest", run.draft.digest]);

    snapshot = await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review");
    run = snapshot.runs[0]; assert.equal(run.review?.headSha, repoA.plan); const planPull = run.prUrl && Number(new URL(run.prUrl).pathname.split("/").pop()); assert.ok(planPull);
    assert.equal(host.exitCode, null, hostError);
    await fixtureControl(fixture.url, "/fixture/human/review", { repo: repoA.repo, number: planPull, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repoA.stateDir, repoA.repo, run.deliveryId, "plan")) });
    snapshot = await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.availableActions?.includes("publish_implementation"));
    run = snapshot.runs[0]; assert.ok(run.draft?.digest, JSON.stringify(run)); assert.equal(run.currentRevision, repoA.candidate);
    await commandWhenBarrierClears(repoA.worktree, environment, ["workspace-command", "--directory", repoA.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "fixture-publish-implementation", "--action", "publish_implementation", "--digest", run.draft.digest]);

    snapshot = await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.workflowStatus === "implementation_review"); run = snapshot.runs[0];
    const implementationPull = run.prUrl && Number(new URL(run.prUrl).pathname.split("/").pop()); assert.ok(implementationPull);
    assert.equal(host.exitCode, null, hostError);
    await fixtureControl(fixture.url, "/fixture/human/review", { repo: repoA.repo, number: implementationPull, stage: "implementation", body: publicApproveReceipt(run, exactReviewReceipt(repoA.stateDir, repoA.repo, run.deliveryId, "implementation")) });
    snapshot = await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.workflowStatus === "manual_ready_pending");
    await fixtureControl(fixture.url, "/fixture/human/ready", { repo: repoA.repo, number: implementationPull });
    await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.workflowStatus === "tracking_pending");
    await fixtureControl(fixture.url, "/fixture/human/tracking", { repo: repoA.repo, number: implementationPull });
    snapshot = await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runs[0]?.workflowStatus === "review_ready" && value.runner.status === "stopped");
    run = snapshot.runs[0]; assert.equal(run.currentRevision, repoA.candidate); assert.equal(run.review?.fresh, true);

    const proposalPath = join(root, "issue-proposal.json"); writeFileSync(proposalPath, JSON.stringify({ title: "Fixture follow-up", body: "A separately authorized local issue proposal." }), { mode: 0o600 });
    const proposal = command(repoA.worktree, environment, ["draft-issue", "--profile", repoA.profile, "--repo", repoA.repo, "--from", proposalPath, "--repository-id", String(repoA.repositoryId), "--actor-id", "17"]).data;
    await fixtureControl(fixture.url, "/fixture/fault", { repo: repoA.repo, effect: "issue-create-response-loss", count: 1 });
    const publishedIssue = command(repoA.worktree, environment, ["draft-publish", proposal.id, "--profile", repoA.profile, "--repo", repoA.repo, "--digest", proposal.content_digest]).data;
    assert.equal(publishedIssue.status, "published"); assert.equal(publishedIssue.content_digest, proposal.content_digest); assert.ok(publishedIssue.remote?.number);

    const isolatedB = command(repoB.worktree, environment, ["workspace-status", "--directory", repoB.worktree]).data; assert.equal(isolatedB.runs.length, 0); assert.equal(isolatedB.runner.status, "stopped");
    const effects = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(effects.some((item) => item.repo === repoA.repo && item.method === "POST" && item.path === "/pulls"));
    assert.equal(effects.filter((item) => item.repo === repoA.repo && item.method === "POST" && item.path === "/issues").length, 1);
    assert.equal(effects.some((item) => item.repo === repoB.repo && ["POST", "PATCH"].includes(item.method)), false); assert.equal(effects.some((item) => item.kind === "forbidden"), false);
  } catch (error) {
    await new Promise((accept) => setTimeout(accept, 50));
    primaryError = new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}\nfixtureHostExit=${String(host?.exitCode)} fixtureHostSignal=${String(host?.signalCode)}\n${hostError}`);
  } finally {
    if (cleanupContext) { try { await drainOwnedRunner(cleanupContext.repoA.worktree, cleanupContext.repoA.repo, registry, cleanupContext.environment); } catch (error) { cleanupError = error; } }
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (!cleanupError) for (let attempt = 0; attempt < 30; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); break; }
      catch (error) { cleanupError = error; await new Promise((accept) => setTimeout(accept, 100)); }
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], `journey failed and cleanup retained ${root}`);
  if (cleanupError) throw new Error(`journey cleanup retained ${root}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  if (primaryError) throw primaryError;
});

test("bound publication-off delivery exports and binds exact manual pull requests through normal gates", { timeout: 180_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-manual-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"); let host: ChildProcess | undefined, hostError = "", cleanup: { repo: Json; environment: NodeJS.ProcessEnv } | undefined;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a, profile = JSON.parse(readFileSync(repository.profile, "utf8")) as Json, foreground = JSON.parse(readFileSync(profile.foreground_policy, "utf8")) as Json; foreground.pr_publication = "off"; writeFileSync(profile.foreground_policy, JSON.stringify(foreground), { mode: 0o600 });
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-manual-control-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repo: repository, environment };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "manual-setup"], { mode: "import", profilePath: repository.profile });
    let snapshot = command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "manual-start", "--action", "start", "--issue", String(repository.issue)]).data;
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !new RepositoryRegistry(registryRoot).readSession(repository.repo).operation); let run = snapshot.runs[0]; assert.equal(run.draft.publicationMode, "off");
    await commandWhenBarrierClears(repository.worktree, environment, ["bind-manual-pr", "--profile", repository.profile, "--repo", repository.repo, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--stage", "plan", "--number", "1", "--request-id", "manual-bind-before-export"]); const afterPremature = new RepositoryRegistry(registryRoot).readSession(repository.repo).operation; assert.equal(afterPremature?.kind === "command" && afterPremature.request_id === "manual-bind-before-export", false); assert.equal(new FileStateStore(repository.stateDir).read(repository.repo, run.deliveryId).controls.requests["manual-bind-before-export"]?.status, "failed");
    run = command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data.runs[0];
    const exportPlan = ["export-handoff", "--profile", repository.profile, "--repo", repository.repo, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--stage", "plan", "--request-id", "manual-export-plan"];
    const noGrant = rawCommand(repository.worktree, { ...environment, DELIVERY_OPERATOR_GRANT: undefined }, exportPlan); assert.equal(noGrant.status, 2); assert.equal(noGrant.envelope?.error?.code, "UNAUTHORIZED");
    await commandWhenBarrierClears(repository.worktree, environment, exportPlan); const publisher = JSON.parse(readFileSync(profile.publisher_config, "utf8")) as Json, handoffPath = join(publisher.stateRoot, "manual-handoffs", `${run.deliveryId}.json`); assert.equal(lstatSync(handoffPath).mode & 0o077, 0); const planHandoff = JSON.parse(readFileSync(handoffPath, "utf8")) as Json;
    const replayedExport = rawCommand(repository.worktree, environment, exportPlan); assert.equal(replayedExport.status, 0, `${replayedExport.stdout}\n${replayedExport.stderr}`);
    const changedRequest = rawCommand(repository.worktree, environment, ["bind-manual-pr", "--profile", repository.profile, "--repo", repository.repo, "--delivery-id", run.deliveryId, "--expected-revision", String(command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data.runs[0].revision), "--stage", "plan", "--number", "1", "--request-id", "manual-export-plan"]); assert.equal(changedRequest.envelope?.error?.code, "REQUEST_CONFLICT", JSON.stringify(changedRequest.envelope)); const afterConflict = new RepositoryRegistry(environment.DELIVERY_REGISTRY_DIR).readSession(repository.repo).operation; assert.equal(afterConflict?.kind === "command" && afterConflict.request_id === "manual-export-plan", false);
    const planNumber = await publishManualPull(fixture, repository, planHandoff), effectsBeforePlanBind = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length;
    await eventuallyRejected(repository.worktree, environment, ["bind-manual-pr", "--profile", repository.profile, "--repo", repository.repo, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--stage", "plan", "--number", String(planNumber), "--request-id", "manual-bind-plan-stale"], "STALE_REVISION");
    run = command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data.runs[0]; const bindPlanRevision = run.revision, bindPlanArgs = ["bind-manual-pr", "--profile", repository.profile, "--repo", repository.repo, "--delivery-id", run.deliveryId, "--expected-revision", String(bindPlanRevision), "--stage", "plan", "--number", String(planNumber), "--request-id", "manual-bind-plan"]; await commandWhenBarrierClears(repository.worktree, environment, bindPlanArgs);
    const planBindEffects = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).slice(effectsBeforePlanBind).map((line) => JSON.parse(line)); assert.equal(planBindEffects.some((effect) => ["POST", "PATCH"].includes(effect.method)), false, JSON.stringify(planBindEffects));
    const stateStore = new FileStateStore(repository.stateDir); let boundState = stateStore.read(repository.repo, run.deliveryId), boundRequest = boundState.controls.requests["manual-bind-plan"]!, boundOperation = boundState.operations.find((operation) => operation.id === boundRequest.operation_id); assert.ok(boundOperation); const operationId = boundOperation.id;
    boundState = stateStore.mutate(repository.repo, run.deliveryId, boundState.revision, (state) => { const request = state.controls.requests["manual-bind-plan"]!, operation = state.operations.find((item) => item.id === operationId)!; request.status = "uncertain"; delete request.completed_at; delete request.result_revision; operation.status = "uncertain"; delete operation.completed_at; delete operation.receipt; state.status = "blocked"; if (!state.unresolved_effects.includes("manual-bind-plan")) state.unresolved_effects.push("manual-bind-plan"); return state; });
    const registry = new RepositoryRegistry(registryRoot), manualInputDigest = repositoryCommandInputDigest({ repo: repository.repo, deliveryId: run.deliveryId, expectedRevision: bindPlanRevision, requestId: "manual-bind-plan", action: "bind_manual_pr", stage: "plan", number: planNumber }); let seededRevision: number | undefined;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && seededRevision === undefined;) {
      const session = registry.readSession(repository.repo); if (session.operation) { await new Promise((accept) => setTimeout(accept, 10)); continue; }
      try { seededRevision = registry.mutateSession(repository.repo, session.revision, (next) => { next.operation = { kind: "command", token: "dead-manual-bind-token", started_at: new Date(0).toISOString(), owner_pid: 99_999_999, owner_process_identity: "dead-manual-bind-owner", action: "bind_manual_pr", delivery_id: run.deliveryId, request_id: "manual-bind-plan", input_digest: manualInputDigest, expected_revision: bindPlanRevision, phase: "effect", operation_id: operationId }; return next; }).revision; }
      catch { await new Promise((accept) => setTimeout(accept, 10)); }
    }
    assert.ok(seededRevision); const pausedForReadback = command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(seededRevision), "--request-id", "pause_for_manual_readback", "--action", "pause"]); assert.equal(pausedForReadback.data.runner.status, "pausing");
    const remoteRefsBefore = git(repository.worktree, "--git-dir", repository.remote, "for-each-ref", "--format=%(refname):%(objectname)"), ledgerLengthBeforeReadback = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length;
    const recoveredBind = rawCommand(repository.worktree, environment, bindPlanArgs); assert.equal(recoveredBind.status, 0, `${recoveredBind.stdout}\n${recoveredBind.stderr}`); assert.equal(registry.readSession(repository.repo).operation, undefined); boundState = stateStore.read(repository.repo, run.deliveryId); assert.equal(boundState.controls.requests["manual-bind-plan"]?.status, "completed"); assert.equal(boundState.operations.find((operation) => operation.id === operationId)?.status, "completed");
    const readbackEffects = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).slice(ledgerLengthBeforeReadback).map((line) => JSON.parse(line)); assert.equal(readbackEffects.some((effect) => ["POST", "PATCH"].includes(effect.method)), false, JSON.stringify(readbackEffects)); assert.equal(readbackEffects.some((effect) => effect.method === "GET"), true, JSON.stringify(readbackEffects)); assert.equal(git(repository.worktree, "--git-dir", repository.remote, "for-each-ref", "--format=%(refname):%(objectname)"), remoteRefsBefore);
    await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runner.status === "paused"); const pausedSession = registry.readSession(repository.repo); command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(pausedSession.revision), "--request-id", "resume_after_manual_readback", "--action", "resume"]);
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review"); run = snapshot.runs[0]; await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: planNumber, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "plan")) });
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "implementation_pr"); run = snapshot.runs[0]; assert.equal(run.draft.publicationMode, "off");
    await managedManualCommand(repository.worktree, environment, repository, run.deliveryId, "export-handoff", "implementation", "manual-export-implementation"); const implementationHandoff = JSON.parse(readFileSync(handoffPath, "utf8")) as Json, implementationNumber = await publishManualPull(fixture, repository, implementationHandoff), effectsBeforeImplementationBind = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length;
    run = command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data.runs[0]; await managedManualCommand(repository.worktree, environment, repository, run.deliveryId, "bind-manual-pr", "implementation", "manual-bind-implementation", implementationNumber);
    const implementationBindEffects = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).slice(effectsBeforeImplementationBind).map((line) => JSON.parse(line)); assert.equal(implementationBindEffects.some((effect) => ["POST", "PATCH"].includes(effect.method)), false, JSON.stringify(implementationBindEffects));
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "implementation_review"); run = snapshot.runs[0]; await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: implementationNumber, stage: "implementation", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "implementation")) });
    await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "manual_ready_pending"); await fixtureControl(fixture.url, "/fixture/human/ready", { repo: repository.repo, number: implementationNumber }); await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "tracking_pending"); await fixtureControl(fixture.url, "/fixture/human/tracking", { repo: repository.repo, number: implementationNumber });
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "review_ready" && value.runner.status === "stopped"); assert.equal(snapshot.runs[0].review.fresh, true); assert.equal(snapshot.runs[0].currentRevision, repository.candidate);
  } finally {
    if (cleanup) await drainOwnedRunner(cleanup.repo.worktree, cleanup.repo.repo, registryRoot, cleanup.environment).catch(() => undefined); if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); } rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("journey cleanup drains its exact detached runner before removing fixture state", { timeout: 60_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-cleanup-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"); let host: ChildProcess | undefined, drained = false, cleanup: { repo: Json; environment: NodeJS.ProcessEnv } | undefined;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] });
    let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repoA = fixture.repositories.a;
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-cleanup-control-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repo: repoA, environment };
    const registry = new RepositoryRegistry(registryRoot);
    command(repoA.worktree, environment, ["workspace-setup", "--directory", repoA.worktree, "--expected-revision", "0", "--request-id", "cleanup-setup-a"], { mode: "import", profilePath: repoA.profile });
    command(repoA.worktree, environment, ["runner-control", "--directory", repoA.worktree, "--expected-revision", "0", "--request-id", "cleanup-start-a", "--action", "start", "--issue", String(repoA.issue)]);
    await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runner.status === "running" && value.runs[0]?.workflowStatus === "plan_review" && !registry.readSession(repoA.repo).operation);
    const idle = registry.readSession(repoA.repo); await new Promise((accept) => setTimeout(accept, 300)); const idleAfter = registry.readSession(repoA.repo);
    assert.equal(idleAfter.revision, idle.revision, "an idle unpublished review must not churn the lifecycle revision"); assert.equal(idleAfter.heartbeat_at, idle.heartbeat_at, "idle control polling must not durably rewrite the heartbeat four times per second");
    command(repoA.worktree, environment, ["runner-control", "--directory", repoA.worktree, "--expected-revision", String(idle.revision), "--request-id", "cleanup_pause_a", "--action", "pause"]);
    await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runner.status === "paused");
    const paused = registry.readSession(repoA.repo); command(repoA.worktree, environment, ["runner-control", "--directory", repoA.worktree, "--expected-revision", String(paused.revision), "--request-id", "cleanup_resume_a", "--action", "resume"]);
    await eventually(() => command(repoA.worktree, environment, ["workspace-status", "--directory", repoA.worktree]).data, (value) => value.runner.status === "running");
    const resumed = registry.readSession(repoA.repo); await new Promise((accept) => setTimeout(accept, 300)); assert.equal(registry.readSession(repoA.repo).revision, resumed.revision);
    command(repoA.worktree, environment, ["runner-control", "--directory", repoA.worktree, "--expected-revision", String(resumed.revision), "--request-id", "cleanup_stop_a", "--action", "stop"]);
    await drainOwnedRunner(repoA.worktree, repoA.repo, registryRoot, environment); drained = true;
    const session = new RepositoryRegistry(registryRoot).readSession(repoA.repo); assert.equal(session.status, "stopped"); assert.equal(session.owner_pid, null); assert.equal(session.in_flight, undefined);
  } finally {
    if (!drained && cleanup) await drainOwnedRunner(cleanup.repo.worktree, cleanup.repo.repo, registryRoot, cleanup.environment).catch(() => undefined);
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("stale pre-effect workspace publication retires its repository reservation before an exact retry", { timeout: 90_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-stale-command-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"); let host: ChildProcess | undefined, repository: Json | undefined, environment: NodeJS.ProcessEnv | undefined, staleContext: { deliveryId: string; expectedRevision: number; requestId: string; inputDigest: string; effectsBefore: number; ledger: string } | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] });
    let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repo = fixture.repositories.a as Json; repository = repo;
    environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-stale-command-grant", DELIVERY_RUNNER_POLL_MS: "5000", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` };
    const registry = new RepositoryRegistry(registryRoot), store = new FileStateStore(repo.stateDir);
    command(repo.worktree, environment, ["workspace-setup", "--directory", repo.worktree, "--expected-revision", "0", "--request-id", "stale-command-setup"], { mode: "import", profilePath: repo.profile });
    command(repo.worktree, environment, ["runner-control", "--directory", repo.worktree, "--expected-revision", "0", "--request-id", "stale-command-start", "--action", "start", "--issue", String(repo.issue)]);
    const snapshot = await eventually(() => command(repo.worktree, environment!, ["workspace-status", "--directory", repo.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !registry.readSession(repo.repo).operation), displayed = snapshot.runs[0];
    store.mutate(repo.repo, displayed.deliveryId, displayed.revision, (state) => state);
    const effectsBefore = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length;
    staleContext = { deliveryId: displayed.deliveryId, expectedRevision: displayed.revision, requestId: "stale-command-publish-plan", inputDigest: repositoryCommandInputDigest({ repo: repo.repo, deliveryId: displayed.deliveryId, expectedRevision: displayed.revision, requestId: "stale-command-publish-plan", action: "publish_plan", draftDigest: displayed.draft.digest }), effectsBefore, ledger: fixture.ledger };
    const stale = rawCommand(repo.worktree, environment, ["workspace-command", "--directory", repo.worktree, "--delivery-id", displayed.deliveryId, "--expected-revision", String(displayed.revision), "--request-id", "stale-command-publish-plan", "--action", "publish_plan", "--digest", displayed.draft.digest]);
    assert.equal(stale.envelope?.error?.code, "STALE_REVISION", `${stale.stdout}\n${stale.stderr}`);
    assert.equal(registry.readSession(repo.repo).operation, undefined, "a certified pre-effect stale command must not retain an effect reservation");
    const afterStale = store.read(repo.repo, displayed.deliveryId); assert.equal(afterStale.controls.requests["stale-command-publish-plan"], undefined); assert.deepEqual(afterStale.operations, []);
    assert.equal(readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length, effectsBefore, "the stale command must remain pre-effect");
    const refreshed = command(repo.worktree, environment, ["workspace-status", "--directory", repo.worktree]).data.runs[0];
    const published = rawCommand(repo.worktree, environment, ["workspace-command", "--directory", repo.worktree, "--delivery-id", refreshed.deliveryId, "--expected-revision", String(refreshed.revision), "--request-id", "stale-command-publish-plan", "--action", "publish_plan", "--digest", refreshed.draft.digest]);
    assert.equal(published.status, 0, `${published.stdout}\n${published.stderr}`); assert.equal(published.envelope?.ok, true); assert.equal(registry.readSession(repo.repo).operation, undefined);
    const originalControl = DeliveryEngine.prototype.control, originalLog = console.log, previousRegistry = process.env.DELIVERY_REGISTRY_DIR, previousGrant = process.env.DELIVERY_OPERATOR_GRANT, previousPath = process.env.PATH; let afterEffectOutput = "";
    try {
      process.env.DELIVERY_REGISTRY_DIR = registryRoot; process.env.DELIVERY_OPERATOR_GRANT = "fixture-stale-command-grant"; process.env.PATH = environment.PATH;
      DeliveryEngine.prototype.control = async function (input) { await originalControl.call(this, input); throw new DeliveryError("post-effect completion CAS became stale", "STALE_REVISION"); };
      console.log = (value?: unknown) => { afterEffectOutput = String(value); };
      const code = await main(["workspace-command", "--directory", repo.worktree, "--delivery-id", refreshed.deliveryId, "--expected-revision", String(refreshed.revision), "--request-id", "stale-command-publish-plan", "--action", "publish_plan", "--digest", refreshed.draft.digest]);
      assert.equal(code, 2); assert.equal(JSON.parse(afterEffectOutput).error.code, "STALE_REVISION");
    } finally {
      DeliveryEngine.prototype.control = originalControl; console.log = originalLog;
      if (previousRegistry === undefined) delete process.env.DELIVERY_REGISTRY_DIR; else process.env.DELIVERY_REGISTRY_DIR = previousRegistry;
      if (previousGrant === undefined) delete process.env.DELIVERY_OPERATOR_GRANT; else process.env.DELIVERY_OPERATOR_GRANT = previousGrant;
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
    const retainedAfterEffect = registry.readSession(repo.repo).operation, publishedState = store.read(repo.repo, refreshed.deliveryId);
    assert.equal(retainedAfterEffect?.kind, "command"); assert.equal(retainedAfterEffect?.request_id, "stale-command-publish-plan"); assert.equal(retainedAfterEffect?.phase, "effect");
    assert.equal(publishedState.controls.requests["stale-command-publish-plan"]?.status, "completed"); assert.equal(publishedState.operations.find((operation) => operation.action === "publish_plan")?.status, "completed");
    registry.finishReservation(repo.repo, retainedAfterEffect!.token);
    await drainOwnedRunner(repo.worktree, repo.repo, registryRoot, environment); drained = true;
  } finally {
    if (!drained && repository && environment) {
      const registry = new RepositoryRegistry(registryRoot), retained = registry.readSession(repository.repo).operation;
      if (retained?.kind === "command" && staleContext) {
        const state = new FileStateStore(repository.stateDir).read(repository.repo, staleContext.deliveryId), effects = readFileSync(staleContext.ledger, "utf8").trim().split("\n").filter(Boolean).length;
        const certified = retained.delivery_id === staleContext.deliveryId && retained.request_id === staleContext.requestId && retained.input_digest === staleContext.inputDigest && retained.expected_revision === staleContext.expectedRevision
          && retained.phase === "effect" && state.controls.requests[staleContext.requestId] === undefined && state.operations.length === 0 && effects === staleContext.effectsBefore;
        if (certified) registry.finishReservation(repository.repo, retained.token);
      }
      await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment).catch(() => undefined);
    }
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("repository worker honors a read-only server deadline while lifecycle controls remain responsive", { timeout: 90_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-read-backoff-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"); let host: ChildProcess | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] });
    let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a;
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-read-backoff-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "read-backoff-setup"], { mode: "import", profilePath: repository.profile });
    let snapshot = command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "read-backoff-start", "--action", "start", "--issue", String(repository.issue)]).data;
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr");
    const run = snapshot.runs[0], ledgerStart = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length;
    await fixtureControl(fixture.url, "/fixture/fault", { repo: repository.repo, effect: "review-read-unavailable", count: 1 });
    await commandWhenBarrierClears(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "read-backoff-publish-plan", "--action", "publish_plan", "--digest", run.draft.digest]);
    const registry = new RepositoryRegistry(registryRoot), deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const remote = await fixtureStatus(fixture.url, repository.repo), session = registry.readSession(repository.repo);
      if (remote.faults["review-read-unavailable"] === 0 && !session.operation) break;
      await new Promise((accept) => setTimeout(accept, 25));
    }
    assert.equal((await fixtureStatus(fixture.url, repository.repo)).faults["review-read-unavailable"], 0);
    const reads = () => readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).slice(ledgerStart).map((line) => JSON.parse(line)).filter((effect) => effect.kind === "github" && effect.method === "GET");
    const waiting = registry.readSession(repository.repo), readsAtDeadline = reads(); assert.equal(waiting.status, "running"); assert.equal(waiting.desired_state, "running"); assert.equal(waiting.operation, undefined); assert.ok(readsAtDeadline.some((effect) => /\/pulls\/\d+\/reviews$/.test(effect.path)), JSON.stringify(readsAtDeadline));
    await new Promise((accept) => setTimeout(accept, 350)); assert.equal(registry.readSession(repository.repo).revision, waiting.revision); assert.equal(reads().length, readsAtDeadline.length, "server deadline must prevent an early HTTP retry");
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(waiting.revision), "--request-id", "read-backoff-pause", "--action", "pause"]);
    await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runner.status === "paused");
    const paused = registry.readSession(repository.repo); command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(paused.revision), "--request-id", "read-backoff-resume", "--action", "resume"]);
    await new Promise((accept) => setTimeout(accept, 350)); const resumed = registry.readSession(repository.repo); assert.equal(resumed.status, "running"); assert.equal(reads().length, readsAtDeadline.length, "Resume must retain the unexpired server deadline");
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(resumed.revision), "--request-id", "read-backoff-stop", "--action", "stop"]);
    await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment); drained = true;
  } finally {
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("repository worker safely backs off pre-effect 503 and 429 rank reads", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-rank-backoff-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"); let host: ChildProcess | undefined, repositories: Json[] = [], environment: NodeJS.ProcessEnv | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] });
    let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json; repositories = [fixture.repositories.a, fixture.repositories.b];
    environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-rank-backoff-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` };
    const exercise = async (repository: Json, fault: "rank-read-unavailable" | "rank-read-rate-limited", prefix: string): Promise<void> => {
      command(repository.worktree, environment!, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", `${prefix}_setup`], { mode: "import", profilePath: repository.profile });
      const ledgerStart = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length; await fixtureControl(fixture.url, "/fixture/fault", { repo: repository.repo, effect: fault, count: 1 });
      command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", `${prefix}_start`, "--action", "start", "--issue", String(repository.issue)]);
      const registry = new RepositoryRegistry(registryRoot), deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const remote = await fixtureStatus(fixture.url, repository.repo), session = registry.readSession(repository.repo);
        if (remote.faults[fault] === 0 && session.delivery_id && !session.operation) break;
        await new Promise((accept) => setTimeout(accept, 25));
      }
      assert.equal((await fixtureStatus(fixture.url, repository.repo)).faults[fault], 0);
      const waiting = registry.readSession(repository.repo); assert.ok(waiting.delivery_id); assert.equal(waiting.status, "running"); assert.equal(waiting.desired_state, "running"); assert.equal(waiting.operation, undefined);
      const delivery = new FileStateStore(repository.stateDir).read(repository.repo, waiting.delivery_id!); assert.equal(delivery.status, "plan_required"); assert.equal(delivery.executions.length, 0); assert.deepEqual(delivery.unresolved_effects, []);
      const reads = () => readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).slice(ledgerStart).map((line) => JSON.parse(line)).filter((effect) => effect.kind === "github" && effect.method === "GET");
      const readsAtDeadline = reads(); assert.ok(readsAtDeadline.some((effect) => effect.path === "/issues"), JSON.stringify(readsAtDeadline));
      await new Promise((accept) => setTimeout(accept, 350)); assert.equal(registry.readSession(repository.repo).revision, waiting.revision); assert.equal(reads().length, readsAtDeadline.length);
      command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(waiting.revision), "--request-id", `${prefix}_pause`, "--action", "pause"]);
      await eventually(() => command(repository.worktree, environment!, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runner.status === "paused");
      const paused = registry.readSession(repository.repo); command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(paused.revision), "--request-id", `${prefix}_resume`, "--action", "resume"]);
      await new Promise((accept) => setTimeout(accept, 350)); const resumed = registry.readSession(repository.repo); assert.equal(resumed.status, "running"); assert.equal(reads().length, readsAtDeadline.length);
      command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(resumed.revision), "--request-id", `${prefix}_stop`, "--action", "stop"]); await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment!);
    };
    await exercise(repositories[0]!, "rank-read-unavailable", "rank_503"); await exercise(repositories[1]!, "rank-read-rate-limited", "rank_429"); drained = true;
  } finally {
    if (environment) for (const repository of repositories) await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment).catch(() => undefined);
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("repository worker safely backs off authenticated readiness 503 and 429 reads", { timeout: 180_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-readiness-backoff-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"); let host: ChildProcess | undefined, repositories: Json[] = [], environment: NodeJS.ProcessEnv | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json; repositories = [fixture.repositories.a, fixture.repositories.b]; environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-readiness-backoff-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` };
    const exercise = async (repository: Json, fault: "readiness-read-unavailable" | "readiness-read-rate-limited", prefix: string): Promise<void> => {
      command(repository.worktree, environment!, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", `${prefix}_setup`], { mode: "import", profilePath: repository.profile }); let snapshot = command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", `${prefix}_start`, "--action", "start", "--issue", String(repository.issue)]).data;
      snapshot = await eventually(() => command(repository.worktree, environment!, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !new RepositoryRegistry(registryRoot).readSession(repository.repo).operation); let run = snapshot.runs[0]; await commandWhenBarrierClears(repository.worktree, environment!, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", `${prefix}_publish_plan`, "--action", "publish_plan", "--digest", run.draft.digest]);
      snapshot = await eventually(() => command(repository.worktree, environment!, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review"); run = snapshot.runs[0]; const planNumber = Number(new URL(run.prUrl).pathname.split("/").pop()); await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: planNumber, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "plan")) });
      snapshot = await eventually(() => command(repository.worktree, environment!, ["workspace-status", "--directory", repository.worktree]).data, (value) => { const candidate = value.runs[0]; return candidate?.draft?.kind === "implementation_pr" && Boolean(new FileStateStore(repository.stateDir).read(repository.repo, candidate.deliveryId).receipts.engineering); }); run = snapshot.runs[0]; await commandWhenBarrierClears(repository.worktree, environment!, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", `${prefix}_publish_implementation`, "--action", "publish_implementation", "--digest", run.draft.digest]);
      snapshot = await eventually(() => command(repository.worktree, environment!, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "implementation_review"); run = snapshot.runs[0]; const implementationNumber = Number(new URL(run.prUrl).pathname.split("/").pop()), ledgerStart = readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).length; await fixtureControl(fixture.url, "/fixture/fault", { repo: repository.repo, effect: fault, count: 1 }); await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: implementationNumber, stage: "implementation", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "implementation")) });
      const registry = new RepositoryRegistry(registryRoot), deadline = Date.now() + 20_000; while (Date.now() < deadline) { const remote = await fixtureStatus(fixture.url, repository.repo), session = registry.readSession(repository.repo); if (remote.faults[fault] === 0 && !session.operation) break; await new Promise((accept) => setTimeout(accept, 25)); }
      assert.equal((await fixtureStatus(fixture.url, repository.repo)).faults[fault], 0); const waiting = registry.readSession(repository.repo), delivery = new FileStateStore(repository.stateDir).read(repository.repo, run.deliveryId); assert.equal(waiting.status, "running"); assert.equal(waiting.operation, undefined); assert.equal(delivery.status, "publication_pending"); assert.equal(delivery.operations.some((operation) => ["intent", "uncertain"].includes(operation.status)), false); assert.deepEqual(delivery.unresolved_effects, []);
      const reads = () => readFileSync(fixture.ledger, "utf8").trim().split("\n").filter(Boolean).slice(ledgerStart).map((line) => JSON.parse(line)).filter((effect) => effect.kind === "github" && effect.method === "GET"); const readsAtDeadline = reads(); assert.ok(readsAtDeadline.some((effect) => /\/check-runs$/.test(effect.path)), JSON.stringify(readsAtDeadline)); await new Promise((accept) => setTimeout(accept, 350)); assert.equal(registry.readSession(repository.repo).revision, waiting.revision); assert.equal(reads().length, readsAtDeadline.length);
      command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(waiting.revision), "--request-id", `${prefix}_pause`, "--action", "pause"]); await eventually(() => command(repository.worktree, environment!, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runner.status === "paused"); const paused = registry.readSession(repository.repo); command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(paused.revision), "--request-id", `${prefix}_resume`, "--action", "resume"]); await new Promise((accept) => setTimeout(accept, 350)); const resumed = registry.readSession(repository.repo); assert.equal(reads().length, readsAtDeadline.length); command(repository.worktree, environment!, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(resumed.revision), "--request-id", `${prefix}_stop`, "--action", "stop"]); await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment!, 30_000);
    };
    await exercise(repositories[0]!, "readiness-read-unavailable", "ready_503"); await exercise(repositories[1]!, "readiness-read-rate-limited", "ready_429"); drained = true;
  } finally {
    if (environment) for (const repository of repositories) await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment, 30_000).catch(() => undefined);
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("slow owned checker keeps the shipped worker live and drains after Pause and Stop", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-slow-checker-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"), marker = join(root, "checker.json"), release = join(root, "checker.release"), checker = join(root, "slow-checker.mjs"); let host: ChildProcess | undefined, cleanup: { repository: Json; environment: NodeJS.ProcessEnv } | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a, profile = JSON.parse(readFileSync(repository.profile, "utf8")) as Json;
    writeFileSync(checker, `import{execFileSync}from'node:child_process';import{existsSync,writeFileSync}from'node:fs';let raw='';for await(const chunk of process.stdin)raw+=chunk;const packet=JSON.parse(raw),pgid=Number(execFileSync('ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,pgid})+'\\n',{mode:0o600});while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,25));process.stdout.write(JSON.stringify({status:'success',candidate_sha:packet.candidate_sha})+'\\n');`, { mode: 0o600 }); chmodSync(checker, 0o600); profile.checker = { argv: [process.execPath, checker], cwd: repository.worktree }; writeFileSync(repository.profile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-slow-checker-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repository, environment };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "slow_checker_setup"], { mode: "import", profilePath: repository.profile });
    let snapshot = command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "slow_checker_start", "--action", "start", "--issue", String(repository.issue)]).data;
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !new RepositoryRegistry(registryRoot).readSession(repository.repo).operation); let run = snapshot.runs[0];
    await commandWhenBarrierClears(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "slow_checker_publish_plan", "--action", "publish_plan", "--digest", run.draft.digest]);
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review"); run = snapshot.runs[0]; const planNumber = Number(new URL(run.prUrl).pathname.split("/").pop());
    await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: planNumber, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "plan")) });
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "implementation_pr"); run = snapshot.runs[0];
    await waitForFile(marker); const checkerProcess = JSON.parse(readFileSync(marker, "utf8")) as Json, registry = new RepositoryRegistry(registryRoot);
    await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.operation?.kind === "worker" && value.operation?.phase === "effect"); const held = registry.readSession(repository.repo); assert.ok(held.owner_pid); assert.notEqual(processGroup(held.owner_pid!), checkerProcess.pgid); assert.equal(processAlive(checkerProcess.pid), true);
    const aged = registry.mutateSession(repository.repo, held.revision, (session) => { session.heartbeat_at = new Date(Date.now() - 46_000).toISOString(); return session; });
    await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => Date.parse(value.heartbeat_at ?? "") > Date.parse(aged.heartbeat_at ?? ""), 15_000); const live = registry.readSession(repository.repo); assert.equal(registry.observe(live).observedState, "alive");
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(live.revision), "--request-id", "slow_checker_pause", "--action", "pause"]); const pausing = registry.readSession(repository.repo);
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(pausing.revision), "--request-id", "slow_checker_stop", "--action", "stop"]); assert.equal(processAlive(checkerProcess.pid), true, "normal Stop must not abort the admitted checker");
    writeFileSync(release, "release", { mode: 0o600 }); await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment, 30_000); drained = true; assert.equal(processAlive(checkerProcess.pid), false);
  } finally {
    if (!drained && cleanup) await drainOwnedRunner(cleanup.repository.worktree, cleanup.repository.repo, registryRoot, cleanup.environment, 30_000).catch(() => undefined);
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Cancel retains the owned checker barrier until terminal exit and claim release", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-checker-cancel-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"), marker = join(root, "checker.json"), release = join(root, "checker.release"), checker = join(root, "slow-checker.mjs"); let host: ChildProcess | undefined, cleanup: { repository: Json; environment: NodeJS.ProcessEnv } | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a, profile = JSON.parse(readFileSync(repository.profile, "utf8")) as Json;
    writeFileSync(checker, `import{execFileSync}from'node:child_process';import{existsSync,writeFileSync}from'node:fs';let raw='';for await(const chunk of process.stdin)raw+=chunk;const packet=JSON.parse(raw),pgid=Number(execFileSync('ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,pgid})+'\\n',{mode:0o600});while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,25));process.stdout.write(JSON.stringify({status:'success',candidate_sha:packet.candidate_sha})+'\\n');`, { mode: 0o600 }); profile.checker = { argv: [process.execPath, checker], cwd: repository.worktree }; writeFileSync(repository.profile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-checker-cancel-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repository, environment };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "checker_cancel_setup"], { mode: "import", profilePath: repository.profile });
    let snapshot = command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "checker_cancel_start", "--action", "start", "--issue", String(repository.issue)]).data;
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !new RepositoryRegistry(registryRoot).readSession(repository.repo).operation); let run = snapshot.runs[0]; await commandWhenBarrierClears(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "checker_cancel_publish_plan", "--action", "publish_plan", "--digest", run.draft.digest]);
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review"); run = snapshot.runs[0]; const planNumber = Number(new URL(run.prUrl).pathname.split("/").pop()); await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: planNumber, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "plan")) });
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "implementation_pr"); run = snapshot.runs[0]; await waitForFile(marker); const checkerProcess = JSON.parse(readFileSync(marker, "utf8")) as Json, registry = new RepositoryRegistry(registryRoot);
    await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.operation?.kind === "worker" && value.operation?.phase === "effect");
    await commandWhenBarrierClears(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "checker_cancel_request", "--action", "cancel"]); assert.equal(processAlive(checkerProcess.pid), true);
    const during = registry.readSession(repository.repo), successor = rawCommand(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(during.revision), "--request-id", "checker_cancel_successor_start", "--action", "start", "--issue", String(repository.issue)]); assert.notEqual(successor.status, 0); assert.equal(processAlive(checkerProcess.pid), true);
    writeFileSync(release, "release", { mode: 0o600 }); await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment, 30_000); drained = true; const released = new FileStateStore(repository.stateDir).read(repository.repo, run.deliveryId); assert.equal(released.claim_status, "released"); assert.equal(released.controls.cancelled, true); assert.equal(processAlive(checkerProcess.pid), false);
    await new Promise((accept) => setTimeout(accept, 300)); assert.equal(new FileStateStore(repository.stateDir).read(repository.repo, run.deliveryId).revision, released.revision, "released cancellation must reject late checker state writes");
  } finally {
    if (!drained && cleanup) await drainOwnedRunner(cleanup.repository.worktree, cleanup.repository.repo, registryRoot, cleanup.environment, 30_000).catch(() => undefined);
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("shipped runner signals request owned Stop while a Pi reviewer drains", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-runner-signal-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"), marker = join(root, "reviewer.json"), promptMarker = join(root, "reviewer-prompt.json"), release = join(root, "reviewer.release"), settledMarker = join(root, "reviewer-settled.json"), fakePi = join(root, "fake-pi.mjs"), wrapper = join(root, "pi"), sessionDir = join(root, "pi-sessions"); let host: ChildProcess | undefined, cleanup: { repository: Json; environment: NodeJS.ProcessEnv } | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a, profile = JSON.parse(readFileSync(repository.profile, "utf8")) as Json; mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(fakePi, `import{execFileSync}from'node:child_process';import{createInterface}from'node:readline';import{existsSync,mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';const args=process.argv.slice(2),scope=args[args.indexOf('--session-dir')+1],sessionFile=join(scope,'session.jsonl');mkdirSync(scope,{recursive:true,mode:0o700});writeFileSync(sessionFile,'',{mode:0o600});const pgid=Number(execFileSync('ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,pgid})+'\\n',{mode:0o600});let packet,settled=false;const input=createInterface({input:process.stdin});input.on('line',line=>{const value=JSON.parse(line);if(value.type==='get_state')process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{sessionFile}})+'\\n');else if(value.type==='get_available_models')process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{models:[{provider:'openai',id:'gpt-6.1-sol'}]}})+'\\n');else if(value.type==='prompt'){packet=JSON.parse(value.message);writeFileSync(${JSON.stringify(promptMarker)},JSON.stringify({task_id:packet.task_id})+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{disposition:'started'}})+'\\n')}else if(value.type==='abort'){process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{}})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled',aborted:true})+'\\n')}});input.on('close',()=>process.exit(0));setInterval(()=>{if(!settled&&packet&&existsSync(${JSON.stringify(release)})){settled=true;const result={status:'approved',candidate_sha:packet.candidate_sha,delivery_id:packet.delivery_id,task_id:packet.task_id,criteria_digest:packet.criteria.criteria_digest};writeFileSync(${JSON.stringify(settledMarker)},JSON.stringify({task_id:packet.task_id})+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(result)}]}})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled',aborted:false})+'\\n')}},25);`, { mode: 0o600 });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${process.execPath}" "${fakePi}" "$@"\n`, { mode: 0o700 }); chmodSync(wrapper, 0o700); profile.reviewer = { kind: "pi", executable: wrapper, cwd: repository.worktree, provider: "openai", model: "gpt-6.1-sol", session_dir: sessionDir }; writeFileSync(repository.profile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-runner-signal-grant", DELIVERY_RUNNER_POLL_MS: "50", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repository, environment };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "runner_signal_setup"], { mode: "import", profilePath: repository.profile });
    let snapshot = command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "runner_signal_start", "--action", "start", "--issue", String(repository.issue)]).data;
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !new RepositoryRegistry(registryRoot).readSession(repository.repo).operation); let run = snapshot.runs[0]; await commandWhenBarrierClears(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "runner_signal_publish_plan", "--action", "publish_plan", "--digest", run.draft.digest]);
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review"); run = snapshot.runs[0]; const planNumber = Number(new URL(run.prUrl).pathname.split("/").pop()); await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: planNumber, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "plan")) });
    await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "implementation_pr"); await waitForFile(promptMarker); const reviewerProcess = JSON.parse(readFileSync(marker, "utf8")) as Json, registry = new RepositoryRegistry(registryRoot);
    await eventually(() => {
      const session = registry.readSession(repository.repo), state = new FileStateStore(repository.stateDir).list(repository.repo).find((item) => item.claim_status === "active");
      const acceptedWait = acceptedReviewerWaitIdentity(state);
      return { session: session as unknown as Json, acceptedWait };
    }, (value) => Boolean(value.acceptedWait) && value.session.operation?.kind === "worker" && value.session.operation?.phase === "effect");
    await new Promise((accept) => setTimeout(accept, 150));
    await eventually(() => {
      const session = registry.readSession(repository.repo), state = new FileStateStore(repository.stateDir).list(repository.repo).find((item) => item.claim_status === "active");
      return { session: session as unknown as Json, acceptedWait: acceptedReviewerWaitIdentity(state) };
    }, (value) => Boolean(value.acceptedWait) && value.session.operation?.kind === "worker" && value.session.operation?.phase === "effect"); let held = registry.readSession(repository.repo); assert.ok(held.owner_pid); const runnerPid = held.owner_pid!, runnerPgid = processGroup(runnerPid); assert.ok(runnerPgid); assert.notEqual(runnerPgid, reviewerProcess.pgid); assert.equal(processAlive(reviewerProcess.pid), true);
    await new Promise((accept) => setTimeout(accept, 350)); assert.equal(registry.readSession(repository.repo).revision, held.revision, "accepted nonterminal reviewer wait must retain one reservation without lifecycle revision churn");
    const paused = rawCommand(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(held.revision), "--request-id", "runner_wait_pause", "--action", "pause"]); assert.equal(paused.status, 0, `${paused.stdout}\n${paused.stderr}`);
    const pausedSession = await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.status === "paused" && value.desired_state === "paused" && !value.operation); assert.equal(processAlive(reviewerProcess.pid), true);
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(pausedSession.revision), "--request-id", "runner_wait_resume", "--action", "resume"]);
    await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.status === "running" && value.operation?.kind === "worker" && value.operation?.phase === "effect"); held = registry.readSession(repository.repo);
    const aged = registry.mutateSession(repository.repo, held.revision, (session) => { session.heartbeat_at = new Date(Date.now() - 46_000).toISOString(); return session; }); await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => Date.parse(value.heartbeat_at ?? "") > Date.parse(aged.heartbeat_at ?? ""), 15_000);
    process.kill(runnerPid, "SIGINT"); await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.desired_state === "stopped" && value.status === "stopping"); assert.equal(processAlive(runnerPid), true); assert.equal(processAlive(reviewerProcess.pid), true);
    const draining = await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.operation?.kind === "worker" && value.operation?.phase === "effect" && value.operation?.effect_admission === "stopping_drain"); const stoppingRevision = draining.revision; process.kill(runnerPid, "SIGTERM"); await new Promise((accept) => setTimeout(accept, 350)); assert.equal(registry.readSession(repository.repo).revision, stoppingRevision, "nonterminal accepted drain must retain one reservation without lifecycle revision churn"); assert.equal(processAlive(runnerPid), true, "repeated signals must not terminate the draining controller"); assert.equal(processAlive(reviewerProcess.pid), true);
    writeFileSync(release, "release", { mode: 0o600 }); await waitForFile(settledMarker); await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment, 30_000); const exited = await eventually(() => ({ runnerAlive: processAlive(runnerPid), reviewerAlive: processAlive(reviewerProcess.pid) }), (value) => !value.runnerAlive && !value.reviewerAlive, 5_000); assert.equal(exited.runnerAlive, false); assert.equal(exited.reviewerAlive, false); let stopped = registry.readSession(repository.repo); assert.equal(stopped.status, "stopped"); assert.equal(stopped.owner_pid, null); assert.equal(stopped.operation, undefined);
    const originalReviewerMarker = readFileSync(marker, "utf8"), originalPromptMarker = readFileSync(promptMarker, "utf8");
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(stopped.revision), "--request-id", "runner_idle_resume", "--action", "resume"]);
    await eventually(() => ({ session: registry.readSession(repository.repo) as unknown as Json, state: new FileStateStore(repository.stateDir).read(repository.repo, run.deliveryId) as unknown as Json }), (value) => value.session.status === "running" && value.session.desired_state === "running" && value.session.owner_pid !== null && !value.session.operation && Boolean(value.state.receipts?.engineering), 5_000); const ready = registry.readSession(repository.repo);
    await new Promise((accept) => setTimeout(accept, 350)); assert.equal(registry.readSession(repository.repo).revision, ready.revision, "an acknowledged no-transition runner must remain lifecycle-revision neutral while idle"); assert.equal(readFileSync(marker, "utf8"), originalReviewerMarker); assert.equal(readFileSync(promptMarker, "utf8"), originalPromptMarker);
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(ready.revision), "--request-id", "runner_idle_stop", "--action", "stop"]); await drainOwnedRunner(repository.worktree, repository.repo, registryRoot, environment, 15_000); drained = true;
  } finally {
    if (!drained && cleanup) { if (existsSync(promptMarker) && !existsSync(release)) writeFileSync(release, "release", { mode: 0o600 }); await drainOwnedRunner(cleanup.repository.worktree, cleanup.repository.repo, registryRoot, cleanup.environment, 30_000).catch(() => undefined); }
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("shipped worker Stop then Cancel uses its original Pi reviewer once and drains exact ownership", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-pi-cancel-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"), marker = join(root, "reviewer.json"), promptMarker = join(root, "reviewer-prompt.json"), abortMarker = join(root, "reviewer-abort.json"), fakePi = join(root, "fake-pi.mjs"), wrapper = join(root, "pi"), sessionDir = join(root, "pi-sessions");
  let host: ChildProcess | undefined, cleanup: { repository: Json; environment: NodeJS.ProcessEnv } | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a, profile = JSON.parse(readFileSync(repository.profile, "utf8")) as Json; mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(fakePi, `import{execFileSync}from'node:child_process';import{createInterface}from'node:readline';import{mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';const args=process.argv.slice(2),scope=args[args.indexOf('--session-dir')+1],sessionFile=join(scope,'session.jsonl');mkdirSync(scope,{recursive:true,mode:0o700});writeFileSync(sessionFile,'',{mode:0o600});const pgid=Number(execFileSync('ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,pgid})+'\\n',{mode:0o600});let packet,aborts=0;const input=createInterface({input:process.stdin});input.on('line',line=>{const value=JSON.parse(line);if(value.type==='get_state')process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{sessionFile}})+'\\n');else if(value.type==='get_available_models')process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{models:[{provider:'openai',id:'gpt-6.1-sol'}]}})+'\\n');else if(value.type==='prompt'){packet=JSON.parse(value.message);writeFileSync(${JSON.stringify(promptMarker)},JSON.stringify({task_id:packet.task_id})+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{disposition:'started'}})+'\\n')}else if(value.type==='abort'){aborts++;writeFileSync(${JSON.stringify(abortMarker)},JSON.stringify({aborts,task_id:packet.task_id})+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{}})+'\\n');process.stdout.write(JSON.stringify({type:'agent_settled',aborted:true})+'\\n')}});input.on('close',()=>process.exit(0));`, { mode: 0o600 });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${process.execPath}" "${fakePi}" "$@"\n`, { mode: 0o700 }); chmodSync(wrapper, 0o700); profile.reviewer = { kind: "pi", executable: wrapper, cwd: repository.worktree, provider: "openai", model: "gpt-6.1-sol", session_dir: sessionDir }; writeFileSync(repository.profile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-pi-cancel-grant", DELIVERY_RUNNER_POLL_MS: "50", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repository, environment };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "pi_cancel_setup"], { mode: "import", profilePath: repository.profile });
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "pi_cancel_start", "--action", "start", "--issue", String(repository.issue)]);
    let snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "plan_pr" && !new RepositoryRegistry(registryRoot).readSession(repository.repo).operation), run = snapshot.runs[0];
    await commandWhenBarrierClears(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "pi_cancel_publish_plan", "--action", "publish_plan", "--digest", run.draft.digest]);
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.workflowStatus === "plan_review"); run = snapshot.runs[0]; const planNumber = Number(new URL(run.prUrl).pathname.split("/").pop()); await fixtureControl(fixture.url, "/fixture/human/review", { repo: repository.repo, number: planNumber, stage: "plan", body: publicApproveReceipt(run, exactReviewReceipt(repository.stateDir, repository.repo, run.deliveryId, "plan")) });
    await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => value.runs[0]?.draft?.kind === "implementation_pr"); await waitForFile(promptMarker); const reviewerProcess = JSON.parse(readFileSync(marker, "utf8")) as Json, registry = new RepositoryRegistry(registryRoot);
    snapshot = await eventually(() => command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data, (value) => Boolean(acceptedReviewerWaitIdentity(new FileStateStore(repository.stateDir).list(repository.repo).find((item) => item.claim_status === "active"))) && value.runner.status === "running"); run = snapshot.runs[0]; const live = registry.readSession(repository.repo); assert.ok(live.owner_pid); const runnerPid = live.owner_pid!;
    const stopDeadline = Date.now() + 10_000;
    while (true) {
      const current = registry.readSession(repository.repo);
      const stop = rawCommand(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(current.revision), "--request-id", "pi_cancel_stop", "--action", "stop"]);
      if (stop.status === 0) { assert.equal(stop.envelope?.ok, true); break; }
      assert.equal(stop.envelope?.error?.code, "STALE_REVISION", stop.stdout + stop.stderr);
      assert.ok(Date.now() < stopDeadline, "Stop could not obtain a fresh runner revision");
      await new Promise((accept) => setTimeout(accept, 25));
    }
    await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.operation?.kind === "worker" && value.operation?.phase === "effect" && value.operation?.effect_admission === "stopping_drain");
    const cancel = rawCommand(repository.worktree, environment, ["workspace-command", "--directory", repository.worktree, "--delivery-id", run.deliveryId, "--expected-revision", String(run.revision), "--request-id", "pi_cancel_request", "--action", "cancel"]); assert.equal(cancel.status, 0, `${cancel.stdout}\n${cancel.stderr}`);
    await waitForFile(abortMarker); const completed = await eventually(() => ({ session: registry.readSession(repository.repo) as unknown as Json, state: new FileStateStore(repository.stateDir).read(repository.repo, run.deliveryId) as unknown as Json, runnerAlive: processAlive(runnerPid), reviewerAlive: processAlive(reviewerProcess.pid) }), (value) => value.session.status === "stopped" && value.session.owner_pid === null && value.state.claim_status === "released" && !value.runnerAlive && !value.reviewerAlive, 30_000);
    assert.equal(completed.state.controls.cancellation.phase, "complete"); assert.equal(completed.session.cancellation.phase, "complete"); assert.equal(completed.session.operation, undefined); assert.deepEqual(JSON.parse(readFileSync(abortMarker, "utf8")), { aborts: 1, task_id: JSON.parse(readFileSync(promptMarker, "utf8")).task_id }); drained = true;
  } finally {
    if (!drained && cleanup) await drainOwnedRunner(cleanup.repository.worktree, cleanup.repository.repo, registryRoot, cleanup.environment, 30_000).catch(() => undefined);
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("shipped worker Stop exits after one authenticated handled Pi prompt without releasing the claim", { timeout: 60_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repository-delivery-handled-stop-"))), manifestPath = join(root, "manifest.json"), registryRoot = join(root, "registry"), promptLedger = join(root, "handled-prompts.jsonl"), fakePi = join(root, "handled-pi.mjs"), wrapper = join(root, "pi"), sessionDir = join(root, "pi-sessions");
  let host: ChildProcess | undefined, cleanup: { repository: Json; environment: NodeJS.ProcessEnv } | undefined, runnerPid: number | undefined, drained = false;
  try {
    host = spawn(process.execPath, ["--experimental-strip-types", fixtureHost, "serve", "--root", root, "--output", manifestPath], { cwd: packageRoot, stdio: ["ignore", "ignore", "pipe"] }); let hostError = ""; host.stderr?.on("data", (chunk) => { hostError += chunk.toString("utf8"); }); await waitForFile(manifestPath); assert.equal(host.exitCode, null, hostError);
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as Json, repository = fixture.repositories.a, profile = JSON.parse(readFileSync(repository.profile, "utf8")) as Json; mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(fakePi, `import{appendFileSync,mkdirSync,writeFileSync}from'node:fs';import{createInterface}from'node:readline';import{join}from'node:path';const args=process.argv.slice(2),scope=args[args.indexOf('--session-dir')+1],sessionFile=join(scope,'session.jsonl');mkdirSync(scope,{recursive:true,mode:0o700});writeFileSync(sessionFile,'',{mode:0o600});const input=createInterface({input:process.stdin});input.on('line',line=>{const value=JSON.parse(line);if(value.type==='get_state')process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{sessionFile}})+'\\n');else if(value.type==='get_available_models')process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{models:[{provider:'openai',id:'gpt-6.1-sol'}]}})+'\\n');else if(value.type==='prompt'){const packet=JSON.parse(value.message);appendFileSync(${JSON.stringify(promptLedger)},JSON.stringify({task_id:packet.task_id})+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({id:value.id,type:'response',success:true,data:{disposition:'handled'}})+'\\n')}});input.on('close',()=>process.exit(0));`, { mode: 0o600 });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${process.execPath}" "${fakePi}" "$@"\n`, { mode: 0o700 }); chmodSync(wrapper, 0o700);
    profile.executor = { kind: "pi", executable: wrapper, cwd: repository.worktree, provider: "openai", model: "gpt-6.1-sol", session_dir: sessionDir }; writeFileSync(repository.profile, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    const environment = { ...process.env, DELIVERY_REGISTRY_DIR: registryRoot, DELIVERY_OPERATOR_GRANT: "fixture-handled-stop-grant", DELIVERY_RUNNER_POLL_MS: "25", PATH: `${fixture.bin}:${process.env.PATH ?? ""}` }; cleanup = { repository, environment };
    command(repository.worktree, environment, ["workspace-setup", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "handled_stop_setup"], { mode: "import", profilePath: repository.profile });
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", "0", "--request-id", "handled_stop_start", "--action", "start", "--issue", String(repository.issue)]);
    const registry = new RepositoryRegistry(registryRoot), blocked = await eventually(() => {
      const session = registry.readSession(repository.repo), state = new FileStateStore(repository.stateDir).list(repository.repo).find((item) => item.claim_status === "active");
      return { session: session as unknown as Json, state: state as unknown as Json };
    }, (value) => value.state?.status === "blocked" && value.state?.executions?.[0]?.proof?.kind === "no_ordinary_run" && !value.session.operation);
    runnerPid = blocked.session.owner_pid; assert.equal(typeof runnerPid, "number"); assert.equal(processAlive(runnerPid!), true); assert.equal(blocked.state.claim_status, "active"); assert.deepEqual(blocked.state.unresolved_effects, [blocked.state.executions[0].id]); assert.equal(blocked.state.executions[0].status, "uncertain"); assert.equal(blocked.state.executions[0].terminal, "failed"); assert.equal(blocked.state.executions[0].effect, "unknown"); assert.match(blocked.state.executions[0].proof_digest, /^[0-9a-f]{64}$/);
    const visibleBlocked = command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data; assert.equal(visibleBlocked.runner.status, "blocked"); assert.equal(visibleBlocked.runner.observedState, "alive"); assert.equal(visibleBlocked.runner.desiredState, "running");
    const promptBeforeStop = readFileSync(promptLedger, "utf8").trim().split("\n").filter(Boolean); assert.equal(promptBeforeStop.length, 1);
    command(repository.worktree, environment, ["runner-control", "--directory", repository.worktree, "--expected-revision", String(blocked.session.revision), "--request-id", "handled_stop_request", "--action", "stop"]);
    const stopped = await eventually(() => registry.readSession(repository.repo) as unknown as Json, (value) => value.status === "stopped" && value.owner_pid === null && !value.operation, 5_000); assert.equal(stopped.desired_state, "stopped");
    await eventually(() => ({ alive: processAlive(runnerPid!) }), (value) => !value.alive, 5_000);
    const visibleStopped = command(repository.worktree, environment, ["workspace-status", "--directory", repository.worktree]).data; assert.equal(visibleStopped.runner.status, "stopped"); assert.equal(visibleStopped.runner.observedState, "not_running"); assert.equal(visibleStopped.runner.desiredState, "stopped");
    const retained = new FileStateStore(repository.stateDir).list(repository.repo).find((item) => item.claim_status === "active")!; assert.equal(retained.status, "blocked"); assert.equal(retained.claim_status, "active"); assert.deepEqual(retained.unresolved_effects, [retained.executions[0]!.id]); assert.equal(readFileSync(promptLedger, "utf8").trim().split("\n").filter(Boolean).length, 1, "Stop must not prompt Pi again"); drained = true;
  } finally {
    if (!drained && cleanup) {
      await drainOwnedRunner(cleanup.repository.worktree, cleanup.repository.repo, registryRoot, cleanup.environment, 6_000).catch(() => undefined);
      const session = new RepositoryRegistry(registryRoot).readSession(cleanup.repository.repo), identity = session.owner_pid ? processIdentity(session.owner_pid) : undefined;
      if (session.owner_pid && identity && identity === session.owner_process_identity) { try { process.kill(session.owner_pid, "SIGKILL"); } catch { /* exact owned fixture runner already exited */ } }
    }
    if (host && host.exitCode === null) { host.kill("SIGTERM"); await new Promise((accept) => host!.once("exit", accept)); }
    if (drained) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
