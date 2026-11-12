import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryCommandOutcomeUncertainError, resolveSourceCli, runWorkspaceCli, runnerControl, workspaceCommand, workspaceSetup, workspaceStatus } from "../server/backend.ts";
import { operatorRequestKey, runSchema, setupRequestSchema, workspaceSnapshotSchema } from "../shared/rpc.ts";
import { parseAllowedPaths, requestIdFor, setupFailureIsUncertain, setupFeedback, setupRequestKey, setupUncertaintyActive } from "../client/setup.ts";

const REPO = "owner/repository";
const SHA = "a".repeat(40);
const SCOPE = "e".repeat(64);

function projectedRun(revision = 1) {
  return {
    repo: REPO, deliveryId: "run-1", status: "waiting", revision, updatedAt: new Date().toISOString(), stale: false,
    evidenceStale: true, objective: "Deliver issue #1", sourceRevision: "b".repeat(40), currentRevision: SHA,
    issueUrl: `https://github.com/${REPO}/issues/1`, prUrl: `https://github.com/${REPO}/pull/2`,
    stages: [], blockers: [], evidence: [], history: [], unresolvedEffects: ["publication:request-1"], availableActions: ["pause"], checks: { local: [], actions: [] },
  };
}

function snapshot(revision = 1) {
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), scopeDigest: SCOPE,
    identity: { repo: REPO, gitRoot: "/fixture/repo", commonDir: "/fixture/repo/.git", worktree: "/fixture/repo", branch: "main", head: SHA },
    setup: { configured: true, revision, defaultProfilePath: "/fixture/profile.json", problems: [] },
    runner: { revision, status: "running", desiredState: "running", observedState: "alive", deliveryId: "run-1", generation: 2 },
    runs: [projectedRun(revision)], operatorActions: ["pause"], warnings: [],
  };
}

test("workspace projection retains exact evidence and separates runner state", () => {
  const parsed = workspaceSnapshotSchema.parse(snapshot(2));
  assert.equal(parsed.runner.status, "running"); assert.equal(parsed.runs[0]!.currentRevision, SHA);
  assert.equal(runSchema.parse(projectedRun()).evidenceStale, true);
  assert.throws(() => runSchema.parse({ ...projectedRun(), prUrl: "https://example.invalid/pull/2" }), /link must be an HTTPS github.com URL/);
  const base = { repo: REPO, deliveryId: "run-1", revision: 7, action: "publish_plan" as const, draftDigest: "c".repeat(64) };
  assert.equal(operatorRequestKey(base), operatorRequestKey(base)); assert.notEqual(operatorRequestKey(base), operatorRequestKey({ ...base, draftDigest: "d".repeat(64) }));
});

test("source bootstrap resolves only from the trusted plugin module ancestor", () => {
  assert.equal(resolveSourceCli(new URL("../server/backend.ts", import.meta.url).href), realpathSync(join(import.meta.dirname, "../../../packages/delivery/src/cli.ts")));
  assert.throws(() => resolveSourceCli(undefined), /owner-only dashboard cliArgv/);
});

test("no-config bootstrap never discovers or executes a planted cwd engine", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "toolkit-delivery-malicious-cwd-")), packageRoot = join(root, "packages", "delivery"), sourceRoot = join(packageRoot, "src"), marker = join(root, "executed"), cli = join(sourceRoot, "cli.ts");
  mkdirSync(sourceRoot, { recursive: true }); writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@codex-toolkit/delivery" })); writeFileSync(cli, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
  const priorDirectory = process.cwd(), priorConfig = process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; process.chdir(root); process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = join(root, "absent-dashboard.json");
  try { await assert.rejects(() => runWorkspaceCli("workspace-status", root)); assert.equal(existsSync(marker), false); }
  finally { process.chdir(priorDirectory); if (priorConfig === undefined) delete process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; else process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = priorConfig; await rm(root, { recursive: true, force: true }); }
});

test("create setup requires narrow planning and implementation allowlists", () => {
  const base = { mode: "create" as const, policyPath: "/protected/policy.json", policy: { ref: "refs/heads/main", sha: SHA, digest: "d".repeat(64), fetched_at: new Date().toISOString() }, skillsRoot: "/protected/skills", publisherConfigPath: "/protected/publisher.json", executorConfigPath: "/protected/executor.json" };
  assert.equal(setupRequestSchema.safeParse({ ...base, allowedPaths: { plan: ["docs/plan.md"], implementation: ["src/delivery.ts"] } }).success, true);
  assert.equal(setupRequestSchema.safeParse({ ...base, allowedPaths: { plan: [], implementation: ["src/**"] } }).success, false);
  assert.deepEqual(parseAllowedPaths("docs/plan.md\ndocs/plan.md\ndocs/review.md", "planning allowlist"), { paths: ["docs/plan.md", "docs/review.md"] });
  assert.match(parseAllowedPaths("../outside", "implementation allowlist").error ?? "", /repository-relative/);
  const setup = { mode: "import", profilePath: "/protected/profile.json" };
  const exactKey = setupRequestKey("host:workspace", REPO, 2, setup), correctedKey = setupRequestKey("host:workspace", REPO, 2, { ...setup, profilePath: "/protected/corrected.json" });
  const cache = new Map<string, string>(); let sequence = 0;
  assert.equal(requestIdFor(cache, exactKey, () => `request-${++sequence}`), requestIdFor(cache, exactKey, () => `request-${++sequence}`));
  assert.notEqual(requestIdFor(cache, exactKey, () => `request-${++sequence}`), requestIdFor(cache, correctedKey, () => `request-${++sequence}`));
  assert.equal(setupFailureIsUncertain("DAEMON_REQUEST_TIMEOUT: request lost"), true);
  assert.equal(setupFailureIsUncertain("PROFILE_INVALID: policy mismatch"), false);
  assert.equal(setupUncertaintyActive("setup:response"), true);
  assert.match(setupFeedback(undefined, undefined, setupUncertaintyActive("setup:response")) ?? "", /Reconcile before retrying/);
});

test("backend resolves the live workspace and forwards only fixed commands", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "toolkit-delivery-plugin-"));
  const configDir = join(root, "config"), configPath = join(configDir, "dashboard.json"), recordPath = join(root, "records.jsonl");
  mkdirSync(configDir, { mode: 0o700 });
  const fixture = join(root, "fixture.mjs");
  writeFileSync(fixture, `import{appendFileSync}from'node:fs';let input='';for await(const part of process.stdin)input+=part;const args=process.argv.slice(2);appendFileSync(${JSON.stringify(recordPath)},JSON.stringify({args,input,grant:process.env.DELIVERY_OPERATOR_GRANT,ghConfigDir:process.env.GH_CONFIG_DIR,xdgConfigHome:process.env.XDG_CONFIG_HOME,ghToken:process.env.GH_TOKEN,githubToken:process.env.GITHUB_TOKEN})+'\\n');console.log(JSON.stringify({ok:true,data:${JSON.stringify(snapshot(3))}}));\n`);
  chmodSync(fixture, 0o700);
  writeFileSync(configPath, JSON.stringify({ cliArgv: [process.execPath, fixture], workspaceOperatorGrant: "fixture-explicit-grant" }), { mode: 0o600 });
  const prior = process.env.PASEO_DELIVERY_DASHBOARD_CONFIG, priorGhConfig = process.env.GH_CONFIG_DIR, priorXdgConfig = process.env.XDG_CONFIG_HOME, priorGhToken = process.env.GH_TOKEN, priorGithubToken = process.env.GITHUB_TOKEN;
  process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = configPath; process.env.GH_CONFIG_DIR = "/trusted-host/gh-config"; process.env.XDG_CONFIG_HOME = "/trusted-host/xdg-config"; process.env.GH_TOKEN = "ambient-gh-token-must-be-scrubbed"; process.env.GITHUB_TOKEN = "ambient-github-token-must-be-scrubbed";
  const context = { paseo: { workspaces: { ref(id: string) { assert.equal(id, "workspace-a"); return { directory: root, async refresh() { return { workspaceDirectory: "/forged/not-used", archivingAt: null }; } }; } } } } as any;
  try {
    await workspaceStatus({ workspaceId: "workspace-a" }, context);
    await workspaceSetup({ workspaceId: "workspace-a", expectedRevision: 3, expectedScope: SCOPE, requestId: "setup-request-1", setup: { mode: "import", profilePath: "/fixture/profile.json" } }, context);
    await runnerControl({ workspaceId: "workspace-a", expectedRevision: 3, expectedScope: SCOPE, requestId: "runner-request-1", action: "pause" }, context);
    await workspaceCommand({ workspaceId: "workspace-a", deliveryId: "run-1", expectedRevision: 3, expectedScope: SCOPE, requestId: "run-request-1", action: "pause" }, context);
    await workspaceCommand({ workspaceId: "workspace-a", deliveryId: "run-1", expectedRevision: 3, expectedScope: SCOPE, requestId: "review-retry-request-1", action: "retry_review" }, context);
    const records = readFileSync(recordPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; input: string; grant?: string; ghConfigDir?: string; xdgConfigHome?: string; ghToken?: string; githubToken?: string });
    assert.deepEqual(records.map((record) => record.args[0]), ["workspace-status", "workspace-setup", "runner-control", "workspace-command", "workspace-command"]);
    assert.equal(records[4]!.args[records[4]!.args.indexOf("--action") + 1], "retry_review");
    for (const record of records) { assert.deepEqual(record.args.slice(1, 3), ["--directory", root]); assert.equal(record.grant, "fixture-explicit-grant"); assert.equal(record.ghConfigDir, "/trusted-host/gh-config"); assert.equal(record.xdgConfigHome, "/trusted-host/xdg-config"); assert.equal(record.ghToken, undefined); assert.equal(record.githubToken, undefined); }
    for (const record of records.slice(1)) { const index = record.args.indexOf("--expected-scope"); assert.equal(record.args[index + 1], SCOPE); }
    assert.deepEqual(JSON.parse(records[1]!.input), { mode: "import", profilePath: "/fixture/profile.json" });
    assert.equal(records.some((record) => record.args.includes("/forged/not-used")), false);
    writeFileSync(configPath, JSON.stringify({ cliArgv: [process.execPath, fixture], operatorGrant: "legacy-grant-must-not-migrate" }), { mode: 0o600 });
    await workspaceStatus({ workspaceId: "workspace-a" }, context);
    const last = JSON.parse(readFileSync(recordPath, "utf8").trim().split("\n").at(-1)!) as { grant?: string };
    assert.equal(last.grant, undefined);
  } finally {
    if (prior === undefined) delete process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; else process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = prior;
    for (const [key, value] of [["GH_CONFIG_DIR", priorGhConfig], ["XDG_CONFIG_HOME", priorXdgConfig], ["GH_TOKEN", priorGhToken], ["GITHUB_TOKEN", priorGithubToken]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test("successful setup returns its mutation snapshot without a fallible status read", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "toolkit-delivery-setup-snapshot-"));
  const configDir = join(root, "config"), configPath = join(configDir, "dashboard.json"), recordPath = join(root, "commands.jsonl"), fixture = join(root, "fixture.mjs");
  mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(fixture, `import{appendFileSync}from'node:fs';const command=process.argv[2];appendFileSync(${JSON.stringify(recordPath)},command+'\\n');if(command==='workspace-status'){console.log(JSON.stringify({ok:false,error:{code:'STATUS_FAILED',message:'second read must not run'}}));process.exitCode=2}else if(process.argv.includes('malformed-request'))console.log(JSON.stringify({ok:true,data:{}}));else console.log(JSON.stringify({ok:true,data:${JSON.stringify(snapshot(9))}}));`);
  chmodSync(fixture, 0o700); writeFileSync(configPath, JSON.stringify({ cliArgv: [process.execPath, fixture] }), { mode: 0o600 });
  const prior = process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = configPath;
  const context = { paseo: { workspaces: { ref() { return { directory: root, async refresh() { return { workspaceDirectory: root, archivingAt: null }; } }; } } } } as any;
  try {
    const result = await workspaceSetup({ workspaceId: "workspace-a", expectedRevision: 8, expectedScope: SCOPE, requestId: "stable-setup-request", setup: { mode: "import", profilePath: "/fixture/profile.json" } }, context);
    assert.equal(result.setup.revision, 9);
    assert.deepEqual(readFileSync(recordPath, "utf8").trim().split("\n"), ["workspace-setup"]);
    await assert.rejects(() => workspaceSetup({ workspaceId: "workspace-a", expectedRevision: 8, expectedScope: SCOPE, requestId: "malformed-request", setup: { mode: "import", profilePath: "/fixture/profile.json" } }, context), DeliveryCommandOutcomeUncertainError);
  } finally { if (prior === undefined) delete process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; else process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = prior; await rm(root, { recursive: true, force: true }); }
});

test("timed-out mutating commands remain uncertain and are not killed", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "toolkit-delivery-timeout-")); const configDir = join(root, "config"), configPath = join(configDir, "dashboard.json"), completionPath = join(root, "completed"), readyPath = join(root, "ready"), releasePath = join(root, "release");
  mkdirSync(configDir, { mode: 0o700 }); const fixture = join(root, "fixture.mjs");
  writeFileSync(fixture, `import{existsSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(readyPath)},'ready');const watchdog=setTimeout(()=>{clearInterval(poll);process.exitCode=1;},5000);const poll=setInterval(()=>{if(!existsSync(${JSON.stringify(releasePath)}))return;clearInterval(poll);clearTimeout(watchdog);writeFileSync(${JSON.stringify(completionPath)},'complete');console.log(JSON.stringify({ok:true,data:{}}));},10);`); chmodSync(fixture, 0o700);
  writeFileSync(configPath, JSON.stringify({ cliArgv: [process.execPath, fixture] }), { mode: 0o600 }); const prior = process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = configPath;
  const waitForFile = async (path: string, expected?: string) => {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path) || expected !== undefined && readFileSync(path, "utf8") !== expected) {
      assert.ok(Date.now() < deadline, `fixture did not create ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let completed = false;
  try {
    await assert.rejects(() => runWorkspaceCli("runner-control", root, [], undefined, 20), DeliveryCommandOutcomeUncertainError);
    await waitForFile(readyPath);
    assert.equal(existsSync(completionPath), false);
    writeFileSync(releasePath, "release");
    await waitForFile(completionPath, "complete"); completed = true;
    assert.equal(readFileSync(completionPath, "utf8"), "complete");
  } finally {
    if (prior === undefined) delete process.env.PASEO_DELIVERY_DASHBOARD_CONFIG; else process.env.PASEO_DELIVERY_DASHBOARD_CONFIG = prior;
    writeFileSync(releasePath, "release");
    if (!completed) { try { await waitForFile(completionPath, "complete"); completed = true; } catch { /* Preserve the primary assertion and the incomplete fixture. */ } }
    if (completed) await rm(root, { recursive: true, force: true });
    else console.error(`Incomplete timeout fixture retained at ${root}`);
  }
});
