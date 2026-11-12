import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { foregroundStatusReporter } from "../src/cli.ts";
import { DeliveryEngine } from "../src/engine.ts";
import { ForegroundSupervisor } from "../src/foreground.ts";
import { ProposalSpool } from "../src/proposals.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";

test("offline list does not connect a configured Paseo executor and profile scope cannot cross repositories", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-offline-")));
  const skills = join(root, "skills"), cwd = join(root, "repo"); mkdirSync(skills); mkdirSync(cwd);
  const profilePath = join(root, "profile.json");
  for (const name of ["policy.json", "foreground.json", "publisher.json"]) writeFileSync(join(root, name), "{}\n", { mode: 0o600 });
  writeFileSync(profilePath, JSON.stringify({
    schema_version: 1, repository: "owner/repo", state_dir: root, skills_root: skills,
    policy: { path: join(root, "policy.json"), ref: "main", sha: "a".repeat(40), digest: "b".repeat(64), fetched_at: new Date().toISOString() },
    foreground_policy: join(root, "foreground.json"), publisher_config: join(root, "publisher.json"),
    executor: { kind: "paseo", url: "ws://127.0.0.1:1", host_id: "offline", repository_path: cwd, base_ref: "main", base_sha: "a".repeat(40), provider: "codex", model: "test", modeId: "auto", featureValues: { plan_mode: false }, options: { approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } },
  })); chmodSync(profilePath, 0o600);
  const engine = new DeliveryEngine({ store: new FileStateStore(root) }); engine.start({ repo: "owner/repo", issue: 1, deliveryId: "offline-read", policy: policy() });
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const listed = spawnSync(process.execPath, ["--experimental-strip-types", cli, "list", "--profile", profilePath], { encoding: "utf8", timeout: 3_000 });
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout).data.runs[0].deliveryId, "offline-read");
  const crossed = spawnSync(process.execPath, ["--experimental-strip-types", cli, "status", "--profile", profilePath, "--repo", "other/repo", "--delivery-id", "offline-read"], { encoding: "utf8", timeout: 3_000 });
  assert.equal(crossed.status, 64); assert.match(JSON.parse(crossed.stdout).error.message, /does not match/);
});

test("uncertain proposals require an explicit exact-digest retry and removal is retained", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-proposal-recovery-"))), spool = new ProposalSpool(store);
  const uncertain = spool.enqueue({ repo: "owner/repo", repositoryId: 1, actorId: 2, title: "Retry", body: "Body" });
  await assert.rejects(() => spool.publish("owner/repo", uncertain.id, { async execute() { throw new Error("lost response"); } }, "automatic"), /lost response/);
  assert.equal(spool.read("owner/repo", uncertain.id).status, "uncertain");
  assert.throws(() => spool.retry("owner/repo", uncertain.id, "0".repeat(64)), /exact authorized digest/);
  assert.equal(spool.retry("owner/repo", uncertain.id, uncertain.content_digest).status, "authorized");
  const removable = spool.enqueue({ repo: "owner/repo", repositoryId: 1, actorId: 2, title: "Remove", body: "Body" });
  assert.equal(spool.remove("owner/repo", removable.id, removable.content_digest).status, "removed");
  assert.equal(spool.list("owner/repo").find((item) => item.id === removable.id)?.status, "removed");
});

test("foreground holds and remains attached when verification setup is incomplete", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-hold-"))), engine = new DeliveryEngine({ store });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "hold-verification", policy: policy(), safeguards: { publication: { pr: "explicit", issue: "off" } } });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "publication_pending"; return next; });
  const statuses: Array<{ status: string; message?: string }> = [];
  const supervisor = new ForegroundSupervisor({ engine, repo: state.repo, policy: policy(), policyConfig: { schema_version: 1, repository: state.repo, repository_id: 1, auto_schedule: false, pr_publication: "explicit", issue_publication: "off" }, onStatus(status, _state, message) { statuses.push({ status, ...(message ? { message } : {}) }); } });
  const observed = await supervisor.tick();
  assert.equal(observed?.status, "publication_pending");
  assert.equal(statuses.at(-1)?.status, "operator_hold");
  assert.match(statuses.at(-1)?.message ?? "", /trusted checker and independent reviewer/);
});

test("foreground requires independent verification before automatic implementation publication", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-order-"))); let publisherCalls = 0;
  const engine = new DeliveryEngine({ store, publisher: { async execute() { publisherCalls += 1; return {}; } } });
  let state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "verification-before-pr", policy: policy(), safeguards: { publication: { pr: "automatic", issue: "off" } } });
  state = store.mutate(state.repo, state.delivery_id, state.revision, (next) => { next.status = "implementation_review"; return next; });
  const supervisor = new ForegroundSupervisor({ engine, repo: state.repo, policy: policy(), policyConfig: { schema_version: 1, repository: state.repo, repository_id: 1, auto_schedule: false, pr_publication: "automatic", issue_publication: "off" } });
  assert.equal((await supervisor.tick())?.status, "implementation_review");
  assert.equal(publisherCalls, 0, "publication cannot precede checker and independent reviewer evidence");
});

test("foreground CLI logs each status, revision, and guidance identity once", () => {
  const lines: string[] = [], report = foregroundStatusReporter((line) => lines.push(line), () => new Date("2026-01-02T03:04:05.000Z"));
  report("idle"); report("idle");
  report("operator_hold", { repo: "owner/repository", revision: 7 }, "provider unavailable");
  report("operator_hold", { repo: "owner/repository", revision: 7 }, "provider unavailable");
  report("operator_hold", { repo: "owner/repository", revision: 7 }, "permission required");
  report("cancelled", { repo: "owner/repository", revision: 8 }); report("cancelled", { repo: "owner/repository", revision: 8 });
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /foreground repository idle$/);
  assert.match(lines[1]!, /owner\/repository operator_hold revision=7 guidance="provider unavailable"$/);
  assert.match(lines[2]!, /guidance="permission required"$/);
  assert.match(lines[3]!, /owner\/repository cancelled revision=8$/);
});

test("only one foreground supervisor owns a repository session", async () => {
  const store = new FileStateStore(mkdtempSync(join(tmpdir(), "delivery-singleton-"))), engine = new DeliveryEngine({ store });
  const options = { engine, repo: "owner/repo", policy: policy(), policyConfig: { schema_version: 1 as const, repository: "owner/repo", repository_id: 1, auto_schedule: false, pr_publication: "off" as const, issue_publication: "off" as const }, sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 10)) };
  const controller = new AbortController(), first = new ForegroundSupervisor(options), second = new ForegroundSupervisor(options);
  const running = first.run(controller.signal); await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => second.run(), /foreground session already running/);
  controller.abort(); await running;
});
