import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine } from "../src/engine.ts";
import { ExecutableJsonAdapter } from "../src/executors.ts";
import { ForegroundSupervisor } from "../src/foreground.ts";
import { Publisher } from "../src/publisher.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

test("foreground journey uses real Git, HTTP and detached executor processes before human ready checkpoints", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-foreground-journey-")), work = join(root, "work"), remote = join(root, "remote.git");
  mkdirSync(work); git(root, "init", "--bare", remote); git(work, "init", "-b", "main");
  writeFileSync(join(work, "README.md"), "Fixture repository\n"); git(work, "add", "."); git(work, "commit", "-m", "baseline"); const base = git(work, "rev-parse", "HEAD"); git(work, "remote", "add", "origin", remote); git(work, "push", "origin", "main");
  git(work, "checkout", "-b", "plan"); writeFileSync(join(work, "plan.md"), "Acceptance: verified fixture delivery\n"); git(work, "add", "."); git(work, "commit", "-m", "plan"); const plan = git(work, "rev-parse", "HEAD"), planBundle = join(root, "plan.bundle"); git(work, "bundle", "create", planBundle, "plan"); chmodSync(planBundle, 0o600);
  git(work, "checkout", "-b", "implementation", base); writeFileSync(join(work, "change.txt"), "verified change\n"); git(work, "add", "."); git(work, "commit", "-m", "implementation"); const candidate = git(work, "rev-parse", "HEAD"), implementationBundle = join(root, "implementation.bundle"); git(work, "bundle", "create", implementationBundle, "implementation"); chmodSync(implementationBundle, 0o600);
  const repo = "example/toolkit", pulls: Record<string, any>[] = [], events: string[] = [], holds: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); response.setHeader("content-type", "application/json");
    const send = (value: unknown) => response.end(JSON.stringify(value));
    if (url.pathname === "/user") return send({ id: 7, login: "developer", type: "User" });
    if (url.pathname === `/repos/${repo}`) return send({ id: 42, full_name: repo, private: false, default_branch: "main" });
    if (url.pathname === `/repos/${repo}/issues`) return send([{ number: 42, id: 142, node_id: "I_142", state: "open", title: "Fixture objective", body: "Acceptance: verified fixture delivery", labels: [], user: { id: 7, login: "developer", type: "User" } }]);
    if (url.pathname === `/repos/${repo}/pulls` && request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      const number = pulls.length + 1; const sha = git(root, "--git-dir", remote, "rev-parse", `refs/heads/${body.head}`);
      events.push(`publish:${number}`);
      const pull = { number, id: 200 + number, node_id: `PR_${number}`, html_url: `https://github.com/${repo}/pull/${number}`, state: "open", draft: body.draft, title: body.title, body: body.body, labels: [], user: { id: 7, login: "developer" }, head: { ref: body.head, sha, repo: { id: 42 } }, base: { ref: body.base, sha: base, repo: { id: 42 } } };
      pulls.push(pull); return send(pull);
    }
    if (url.pathname === `/repos/${repo}/pulls`) { const head = url.searchParams.get("head")?.split(":").slice(1).join(":"); return send(head ? pulls.filter(p => p.head.ref === head) : pulls); }
    const pull = /^\/repos\/example\/toolkit\/pulls\/(\d+)$/.exec(url.pathname); if (pull) return send(pulls[Number(pull[1]) - 1]);
    if (url.pathname.endsWith("/check-runs")) return send({ total_count: 1, check_runs: [{ id: 1, name: "fixture-ci", status: "completed", conclusion: "success", head_sha: candidate }] });
    if (url.pathname.endsWith("/status")) return send({ state: "success", statuses: [{ id: 1 }] });
    response.statusCode = 404; return send({ message: url.pathname });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const script = join(root, "executor.mjs");
  const fixtures = { base, plan, candidate, planBundle, implementationBundle, planHash: "" };
  // The plan checkout is no longer selected. Hash the exact committed artifact.
  fixtures.planHash = createHash("sha256").update(git(work, "show", `${plan}:plan.md`) + "\n").digest("hex");
  writeFileSync(script, `let raw='';for await(const part of process.stdin)raw+=part;const p=JSON.parse(raw),f=${JSON.stringify(fixtures)};if(p.kind==='review'){console.log(JSON.stringify({status:'approved',candidate_sha:f.candidate,delivery_id:p.delivery_id,task_id:p.task_id,criteria_digest:p.criteria.criteria_digest}));}else{const kind=p.kind;const result=kind==='rank'?{winner:42,shortlist:[42]}:kind==='plan'?{issue:42,plan_revision:f.plan,baseline:{repo:p.repo,ref:'main',sha:f.base},artifact_paths:['plan.md'],artifact_hashes:{'plan.md':f.planHash}}:{issue:42,candidate_sha:f.candidate,base:{repo:p.repo,ref:'main',sha:f.base},artifact_paths:['change.txt'],verification:['agent report is not trusted verification']};const manifest={schema_version:1,kind,repo:p.repo,delivery_id:p.delivery_id,result};const handoff=kind==='rank'?undefined:{expected:{head:kind==='plan'?'delivery/plan':'delivery/implementation',base:'main',head_sha:kind==='plan'?f.plan:f.candidate,base_sha:f.base,previous_sha:null},payload:{title:kind==='plan'?'Fixture plan':'Fixture implementation',body:'Fixture body',bundle:kind==='plan'?f.planBundle:f.implementationBundle,allowed_paths:[kind==='plan'?'plan.md':'change.txt']}};console.log(JSON.stringify({manifest,...(handoff?{handoff}:{}),implementer_identity:'fixture-implementation-session'}));}`);
  const store = new FileStateStore(join(root, "state"));
  const executor = new ExecutableJsonAdapter({ argv: [process.execPath, script], cwd: work, stateDir: join(root, "executor-jobs") });
  const reviewer = new ExecutableJsonAdapter({ argv: [process.execPath, script], cwd: work, stateDir: join(root, "reviewer-jobs") });
  const publisher = new Publisher({ repo, repositoryId: 42, actorId: 7, login: "developer", stateRoot: join(root, "publisher"), remoteUrl: remote, allowLocalRemote: true, testOnly: true, transportBaseUrl: `http://127.0.0.1:${address.port}`, tokenResolver: async () => "fixture-token" });
  const checker = { async verify() { assert.equal(git(work, "show", `${candidate}:change.txt`), "verified change"); events.push("check"); return { status: "success", candidate_sha: candidate }; } };
  const p = policy(); p.delivery.require_github_actions = true;
  try {
    let current;
    for (let tick = 0; tick < 150; tick++) {
      // Recreate the controller from durable state between every tick.
      const engine = new DeliveryEngine({ store, executor, reviewer, publisher, checker });
      const supervisor = new ForegroundSupervisor({ engine, repo, policy: p, onStatus: (status, state, message) => { if (message) holds.push(message); }, policyConfig: { schema_version: 1, repository: repo, repository_id: 42, auto_schedule: true, pr_publication: "automatic", issue_publication: "off", allowed_paths: { plan: ["plan.md"], implementation: ["change.txt"] } } });
      current = await supervisor.tick();
      if (current?.status === "manual_ready_pending") { assert.ok(current.receipts.engineering); pulls[1]!.draft = false; }
      if (current?.status === "tracking_pending") pulls[1]!.labels = [{ name: "delivery-review" }];
      if (current?.status === "review_ready") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(current?.status, "review_ready", JSON.stringify(current && { status: current.status, runner: current.runner, history: current.history.slice(-3), operations:current.operations.map(o=>({action:o.action,status:o.status,error:o.error})), holds:holds.slice(-3) }));
    assert.equal(pulls.length, 2); assert.ok(events.indexOf("check") < events.indexOf("publish:2"));
    assert.equal(git(root, "--git-dir", remote, "rev-parse", "refs/heads/delivery/implementation"), candidate);
    assert.equal(current?.claim_status, "released");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
