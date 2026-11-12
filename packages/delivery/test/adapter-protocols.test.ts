import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { PaseoExecutorAdapter, PiRpcExecutorAdapter, executorInternals } from "../src/executors.ts";
import { digest } from "../src/core.ts";
import { AdapterReceiptStore, type AdapterReceipt } from "../src/adapter-receipts.ts";
import { acquireDirectoryLockSync } from "../src/locks.ts";
import { processIdentity, processOwnership } from "../src/process-identity.ts";

const node = process.execPath;
const currentSha = execFileSync("git", ["rev-parse", "main"], { encoding: "utf8" }).trim();
const commonDir = realpathSync(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
const codexSettings = { modeId: "auto", featureValues: { plan_mode: false }, options: { approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } } as const;
const paseoSnapshot = { currentModeId: "auto", features: [{ type: "toggle" as const, id: "plan_mode", value: false }] };
const paseoDiscovery = (provider = "codex") => ({
  async listModes() { return { provider, modes: [{ id: "auto" }], fetchedAt: "2026-11-12T00:00:00.000Z" }; },
  async listFeatures() { return { provider, features: paseoSnapshot.features, fetchedAt: "2026-11-12T00:00:00.000Z" }; },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function waitForEvidence(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function piReceipt(stateDir: string): Promise<{ path: string; value: Record<string, any> }> {
  const name = (await readdir(stateDir)).find((entry) => /^ar_[0-9a-f]{32}\.json$/.test(entry));
  assert.ok(name, "protected Pi receipt exists");
  const path = join(stateDir, name);
  return { path, value: JSON.parse(await readFile(path, "utf8")) };
}

async function piFixture(name: string) {
  const fixture = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
  const root = await mkdtemp(join(tmpdir(), `delivery-pi-protocol-${name}-`));
  const wrapper = join(root, "pi");
  const sessionRoot = join(root, "sessions");
  const starts = join(root, "starts");
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${node}" "${fixture}" "$@"\n`, { mode: 0o700 });
  const options = {
    executable: wrapper,
    cwd: root,
    timeoutMs: 2_000,
    stateDir: join(root, "agent-receipts"),
    sessionOwnersDir: join(root, "owners"),
    sessionDir: sessionRoot,
    role: "agent" as const,
    environment: { FAKE_PI_START_MARKER: starts },
  };
  return { root, sessionRoot, starts, options, adapter: new PiRpcExecutorAdapter(options) };
}

async function protectedSessionFile(stateDir: string): Promise<string> {
  const name = (await readdir(stateDir)).find((entry) => /^ar_[0-9a-f]{32}\.json$/.test(entry));
  assert.ok(name, "protected Pi receipt exists");
  const receipt = JSON.parse(await readFile(join(stateDir, name), "utf8"));
  assert.equal(typeof receipt.private?.session_file, "string");
  return receipt.private.session_file;
}

function packet(taskId: string, extra: Record<string, unknown> = {}) {
  return { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: taskId, scenario: "hold", ...extra };
}

function processGroup(pid: number): number | undefined {
  try { return Number(execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { return undefined; }
}

test("Pi child is isolated from its controller process group and settles after explicit release", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-pi-process-group-")), wrapper = join(root, "pi"), ready = join(root, "pi.ready"), release = join(root, "pi.release"), processMarker = join(root, "pi-process.json");
  const fakePi = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname, executorUrl = new URL("../src/executors.ts", import.meta.url).href;
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${node}" "${fakePi}" "$@"\n`, { mode: 0o700 });
  const options = { executable: wrapper, cwd: root, timeoutMs: 4_000, stateDir: join(root, "receipts"), sessionOwnersDir: join(root, "owners"), sessionDir: join(root, "sessions"), role: "agent", environment: { FAKE_PI_GROUP_READY: ready, FAKE_PI_GROUP_RELEASE: release, FAKE_PI_PROCESS_MARKER: processMarker } };
  const request = packet("task_process_group", { scenario: "process-group-release" });
  const program = `import{PiRpcExecutorAdapter}from ${JSON.stringify(executorUrl)};const adapter=new PiRpcExecutorAdapter(${JSON.stringify(options)}),request=${JSON.stringify(request)};let started;process.on("SIGINT",()=>process.send({kind:"signal",pid:process.pid}));process.on("message",message=>{if(message==="exit")process.exit(0)});process.send({kind:"controller-ready",pid:process.pid});started=await adapter.dispatch(request);process.send({kind:"started",result:started});const collected=await adapter.collect(String(started.execution_id));process.send({kind:"collected",result:collected});`;
  const controller = spawn(node, ["--experimental-strip-types", "--input-type=module", "-e", program], { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  assert.ok(controller.pid);
  const controllerIdentity = processIdentity(controller.pid);
  let piProcess: { pid: number; pgid: number; identity?: string } | undefined;
  const messages: Array<{ kind: string; result?: Record<string, unknown> }> = [];
  const next = (kind: string) => new Promise<{ kind: string; result?: Record<string, unknown> }>((accept, reject) => {
    const handler = (message: { kind: string; result?: Record<string, unknown> }) => { messages.push(message); if (message.kind === kind) { controller.off("message", handler); accept(message); } };
    controller.on("message", handler); controller.once("error", reject);
  });
  try {
    const controllerReady = await next("controller-ready"); assert.equal(controllerReady.kind, "controller-ready");
    const started = await next("started"); assert.equal(started.result?.status, "running");
    const processValue = JSON.parse(await readFile(processMarker, "utf8")) as { pid: number; pgid: number };
    piProcess = { ...processValue, identity: processIdentity(processValue.pid) };
    const controllerPgid = processGroup(controller.pid);
    assert.equal(controllerPgid, controller.pid, "controller must own the exact disposable process group");
    assert.equal(processGroup(processValue.pid), processValue.pgid, "Pi process-group observation must be current before signalling");
    const signal = next("signal"); process.kill(-controllerPgid, "SIGINT"); await signal;
    assert.doesNotThrow(() => process.kill(controller.pid!, 0), "controller signal handler must survive terminal-group SIGINT");
    const survivingPiPgid = processGroup(processValue.pid);
    assert.equal(survivingPiPgid, processValue.pgid, "owned Pi child must survive controller terminal-group SIGINT");
    assert.notEqual(survivingPiPgid, controllerPgid, "owned Pi child must run in a distinct process group");
    await writeFile(release, "release\n", { mode: 0o600 });
    const collected = await next("collected"); assert.equal(collected.result?.status, "completed"); assert.equal(collected.result?.effect, "accepted");
    controller.send("exit"); await new Promise<void>((accept) => controller.once("exit", () => accept()));
  } finally {
    try { if (controller.connected) controller.send("exit"); } catch { /* exact controller already exited */ }
    try { if (piProcess?.identity && processIdentity(piProcess.pid) === piProcess.identity && processGroup(piProcess.pid) === piProcess.pgid) process.kill(piProcess.pid, "SIGKILL"); } catch { /* exact Pi child already exited */ }
    try { if (controllerIdentity && processIdentity(controller.pid!) === controllerIdentity && processGroup(controller.pid!) === controller.pid) process.kill(-controller.pid!, "SIGKILL"); } catch { /* exact disposable controller group already exited */ }
  }
});

test("Pi explicit resume checks the canonical session owner before spawning another RPC runtime", async () => {
  const fixture = await piFixture("resume-owner");
  const started = await fixture.adapter.dispatch(packet("task_owner_agent"));
  try {
    assert.equal(started.status, "running");
    assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);

    const sessionFile = await protectedSessionFile(fixture.options.stateDir);
    const reviewer = new PiRpcExecutorAdapter({
      ...fixture.options,
      role: "reviewer",
      stateDir: join(dirname(fixture.options.stateDir), "reviewer-receipts"),
    });
    const refused = await reviewer.resume(sessionFile, packet("task_owner_reviewer", { kind: "review" }));
    assert.equal(refused.status, "failed");
    assert.equal(refused.effect, "none");
    assert.equal((await readFile(fixture.starts, "utf8")).trim().split("\n").length, 1);
  } finally {
    assert.equal((await fixture.adapter.cancel(String(started.execution_id))).status, "cancelled");
  }
});

test("Pi binds an early settlement only after a started or queued prompt acknowledgement", async () => {
  for (const scenario of ["early-handled", "early-reject"] as const) {
    const fixture = await piFixture(scenario);
    const result = await fixture.adapter.dispatch(packet(`task_${scenario.replace("-", "_")}`, { scenario }));
    assert.equal(result.status, "failed", scenario);
    assert.equal(result.effect, "unknown", scenario);
    assert.equal(result.terminal, "failed", scenario);
    assert.equal(result.result, undefined, scenario);
  }
});

test("Pi concurrent and replayed cancellation sends one abort and waits for settlement", async () => {
  const fixture = await piFixture("cancel-latch"), aborts = join(fixture.root, "aborts");
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_ABORT_MARKER: aborts, FAKE_PI_ABORT_ACK_DELAY_MS: "40", FAKE_PI_ABORT_SETTLE_DELAY_MS: "80" } });
  const started = await adapter.dispatch(packet("task_cancel_latch")); assert.equal(started.status, "running");
  const results = await Promise.all([adapter.cancel(String(started.execution_id)), adapter.cancel(String(started.execution_id)), adapter.cancel(String(started.execution_id))]);
  assert.deepEqual(results.map((result) => result.status), ["cancelled", "cancelled", "cancelled"]);
  assert.equal((await readFile(aborts, "utf8")).trim().split("\n").length, 1);
  assert.equal((await adapter.cancel(String(started.execution_id))).status, "cancelled");
  assert.equal((await readFile(aborts, "utf8")).trim().split("\n").length, 1);
});

test("Pi negative acknowledgement and response timeout are sticky and never resend abort", async () => {
  for (const mode of ["reject", "timeout"] as const) {
    const fixture = await piFixture(`cancel-${mode}`), aborts = join(fixture.root, "aborts"), response = join(fixture.root, "abort-response"), exitRelease = join(fixture.root, "exit-release"), processMarker = join(fixture.root, "process.json");
    const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_ABORT_MARKER: aborts, FAKE_PI_ABORT_RESPONSE_MARKER: response, FAKE_PI_ABORT_MODE: mode, FAKE_PI_ABORT_EXIT_RELEASE: exitRelease, FAKE_PI_PROCESS_MARKER: processMarker } });
    const started = await adapter.dispatch(packet(`task_cancel_${mode}`));
    assert.equal(started.status, "running"); assert.equal(started.effect, "accepted");
    const first = await adapter.cancel(String(started.execution_id)), replay = await adapter.cancel(String(started.execution_id));
    assert.equal(first.status, "uncertain"); assert.equal(first.effect, "accepted"); assert.equal(first.terminal, "nonterminal");
    assert.equal(replay.status, "uncertain"); assert.equal(replay.effect, "accepted"); assert.equal(replay.terminal, "nonterminal");
    assert.equal((await readFile(aborts, "utf8")).trim().split("\n").length, 1);
    if (mode === "reject") await waitForEvidence(() => existsSync(response), "negative abort response");
    else assert.equal(existsSync(response), false, "timeout fixture must not acknowledge abort");
    const child = JSON.parse(await readFile(processMarker, "utf8")) as { pid: number }, identity = processIdentity(child.pid); assert.ok(identity);
    await writeFile(exitRelease, "exit\n", { mode: 0o600 });
    await waitForEvidence(() => processOwnership(child.pid, identity) === "lost", "negative-ack fixture child exit");
  }
});

test("Pi accepted abort progresses after settlement timeout without resending", async () => {
  const fixture = await piFixture("cancel-eventual"), aborts = join(fixture.root, "aborts"), response = join(fixture.root, "abort-response"), settlementRelease = join(fixture.root, "settlement-release"), settled = join(fixture.root, "settled");
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_ABORT_MARKER: aborts, FAKE_PI_ABORT_RESPONSE_MARKER: response, FAKE_PI_ABORT_SETTLE_RELEASE: settlementRelease, FAKE_PI_ABORT_SETTLED_MARKER: settled } });
  const started = await adapter.dispatch(packet("task_cancel_eventual"));
  assert.equal(started.status, "running"); assert.equal(started.effect, "accepted");
  const first = await adapter.cancel(String(started.execution_id)); assert.equal(first.status, "uncertain"); assert.equal(first.effect, "accepted"); assert.equal(first.terminal, "nonterminal");
  await waitForEvidence(() => existsSync(response), "accepted abort acknowledgement");
  assert.equal(existsSync(settled), false, "settlement must remain behind its explicit release barrier");
  await writeFile(settlementRelease, "release\n", { mode: 0o600 });
  await waitForEvidence(() => existsSync(settled), "released abort settlement");
  assert.equal((await adapter.cancel(String(started.execution_id))).status, "cancelled");
  assert.equal((await readFile(aborts, "utf8")).trim().split("\n").length, 1);
  const receipt = (await piReceipt(fixture.options.stateDir)).value;
  assert.equal(receipt.state, "terminal"); assert.equal(receipt.outcome?.status, "cancelled"); assert.equal(receipt.private?.pi_quiescence?.exit?.kind, "observed_exit");
});

test("Pi detached settlement requires actual exact-child exit, not live same-birth argv drift", { skip: process.platform === "win32" }, async () => {
  const fixture = await piFixture("cancel-detached"), aborts = join(fixture.root, "aborts"), response = join(fixture.root, "abort-response"), settlementRelease = join(fixture.root, "settlement-release"), settled = join(fixture.root, "settled"), processMarker = join(fixture.root, "process.json");
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_ABORT_MARKER: aborts, FAKE_PI_ABORT_RESPONSE_MARKER: response, FAKE_PI_ABORT_SETTLE_RELEASE: settlementRelease, FAKE_PI_ABORT_SETTLED_MARKER: settled, FAKE_PI_CHANGE_TITLE: "pi-title-drift", FAKE_PI_PROCESS_MARKER: processMarker } });
  const request = packet("task_cancel_detached"), started = await adapter.dispatch(request);
  assert.equal(started.status, "running"); assert.equal(started.effect, "accepted");
  const first = await adapter.cancel(String(started.execution_id)); assert.equal(first.status, "uncertain"); assert.equal(first.effect, "accepted"); assert.equal(first.terminal, "nonterminal");
  await waitForEvidence(() => existsSync(response), "detached abort acknowledgement");
  assert.equal(existsSync(settled), false, "detached settlement must remain behind its explicit release barrier");
  await writeFile(settlementRelease, "release\n", { mode: 0o600 });
  await waitForEvidence(() => existsSync(settled), "detached released settlement");
  await waitForEvidence(async () => Boolean((await piReceipt(fixture.options.stateDir)).value.private?.pi_settlement_digest), "persisted detached settlement");
  const detached = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_ABORT_MARKER: aborts } });
  assert.equal((await detached.cancel(String(started.execution_id))).status, "uncertain", "live child remains nonterminal even if argv identity drifts");
  const child = JSON.parse(await readFile(processMarker, "utf8")) as { pid: number };
  const protectedReceipt = (await piReceipt(fixture.options.stateDir)).value, childIdentity = protectedReceipt.private.pi_child.process_identity as string;
  assert.notEqual(processOwnership(child.pid, childIdentity), "lost", "same-birth argv drift alone must not prove child exit");
  process.kill(child.pid, "SIGKILL");
  await waitForEvidence(() => processOwnership(child.pid, childIdentity) === "lost", "exact detached child exit");
  const terminal = await detached.cancel(String(started.execution_id)); assert.equal(terminal.status, "cancelled");
  assert.equal((await readFile(aborts, "utf8")).trim().split("\n").length, 1, "detached replay never sends abort");
  const { path: receiptPath, value: receipt } = await piReceipt(fixture.options.stateDir);
  const expected = { repo: "github.com/fixture/protocol", delivery_id: request.delivery_id, role: "agent" as const, task_id: request.task_id, packet_digest: digest(request), execution_id: String(started.execution_id) };
  const store = new AdapterReceiptStore(fixture.options.stateDir, "agent"); assert.equal(store.resolve(terminal as never, expected).trusted, true);
  receipt.private.pi_quiescence.child_process_identity = `${receipt.private.pi_quiescence.child_process_identity}-tampered`; await writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal(store.resolve(terminal as never, expected).trusted, false, "tampered quiescence cannot authorize terminal cancellation");
});

test("Pi provisions durable session storage when sessionDir is omitted", async () => {
  const fixture = await piFixture("default-session-root");
  const adapter = new PiRpcExecutorAdapter({
    ...fixture.options,
    stateDir: join(fixture.root, "default-receipts"),
    environment: { FAKE_PI_START_MARKER: fixture.starts },
    sessionDir: undefined,
  });
  const started = await adapter.dispatch(packet("task_default_session"));
  try { assert.equal(started.status, "running"); }
  finally { if (started.status === "running") await adapter.cancel(String(started.execution_id)); }
});

test("Pi rejects a provider-selected session outside the configured protected root", async () => {
  const fixture = await piFixture("foreign-session");
  const protectedRoot = join(fixture.root, "protected-sessions");
  const foreign = join(fixture.root, "foreign.jsonl");
  await writeFile(foreign, "", { mode: 0o600 });
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, sessionDir: protectedRoot, environment: { ...fixture.options.environment, FAKE_PI_SESSION_FILE: foreign } });
  const result = await adapter.dispatch(packet("task_foreign_session"));
  try {
    assert.equal(result.status, "failed");
    assert.equal(result.effect, "none");
    assert.match(String(result.error), /session root|outside/i);
  } finally { if (result.status === "running") await adapter.cancel(String(result.execution_id)); }
});

test("Pi exact terminal replay does not execute the configured binary", async () => {
  const fixture = await piFixture("offline-replay");
  const request = { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_offline_replay" };
  const started = await fixture.adapter.dispatch(request);
  const sessionFile = await protectedSessionFile(fixture.options.stateDir);
  const completed = await fixture.adapter.collect(String(started.execution_id));
  assert.equal(completed.status, "completed");
  await rename(fixture.options.executable, `${fixture.options.executable}.offline`);
  await unlink(sessionFile);
  const replay = await new PiRpcExecutorAdapter(fixture.options).dispatch(request);
  assert.equal(replay.status, "completed");
  assert.equal(replay.execution_id, completed.execution_id);
});

test("Pi detached inspection rejects a live owner whose protected run context changed", async () => {
  const fixture = await piFixture("owner-context");
  const started = await fixture.adapter.dispatch(packet("task_owner_context"));
  try {
    assert.equal(started.status, "running");
    const sessionFile = await protectedSessionFile(fixture.options.stateDir);
    const ownerPath = join(fixture.options.sessionOwnersDir, digest(realpathSync(sessionFile)), "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    owner.context.role = "reviewer";
    await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    const detached = new PiRpcExecutorAdapter(fixture.options);
    const observed = await detached.inspect(String(started.execution_id));
    assert.equal(observed.status, "uncertain");
    assert.match(String(observed.error), /context/i);
  } finally { await fixture.adapter.cancel(String(started.execution_id)); }
});

test("Pi refuses explicit resume without protected receipt provenance before spawning", async () => {
  const fixture = await piFixture("resume-provenance");
  const imported = join(fixture.sessionRoot, "unproven-session.jsonl");
  await writeFile(imported, "", { mode: 0o600 });
  await chmod(imported, 0o644);
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_SESSION_FILE: imported } });
  const result = await adapter.resume(imported, packet("task_unproven_resume"));
  try {
    assert.equal(result.status, "failed");
    assert.equal(result.effect, "none");
    assert.match(String(result.error), /provenance|protected receipt/i);
    assert.equal((await lstat(imported)).mode & 0o777, 0o644, "unproven files are neither adopted nor chmodded");
    await assert.rejects(readFile(fixture.starts, "utf8"), /ENOENT/);
  } finally { if (result.status === "running") await adapter.cancel(String(result.execution_id)); }
});

test("Pi resumes a protected terminal session for a distinct subsequent prompt", async () => {
  const fixture = await piFixture("resume-next-prompt");
  const first = await fixture.adapter.dispatch(packet("task_resume_previous"));
  assert.equal(first.status, "running");
  const sessionFile = await protectedSessionFile(fixture.options.stateDir);
  const oldReceiptName = (await readdir(fixture.options.stateDir)).find((entry) => /^ar_[0-9a-f]{32}\.json$/.test(entry));
  assert.ok(oldReceiptName);
  assert.equal((await fixture.adapter.cancel(String(first.execution_id))).status, "cancelled");
  const oldReceiptBytes = await readFile(join(fixture.options.stateDir, oldReceiptName));

  const resumed = await fixture.adapter.resume(sessionFile, { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_resume_next", scenario: "ordinary" });
  assert.equal(resumed.status, "running");
  assert.notEqual(resumed.execution_id, first.execution_id);
  assert.equal((await fixture.adapter.collect(String(resumed.execution_id))).status, "completed");
  const third = await fixture.adapter.resume(sessionFile, { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_resume_third", scenario: "ordinary" });
  assert.equal(third.status, "running");
  assert.notEqual(third.execution_id, resumed.execution_id);
  assert.equal((await fixture.adapter.collect(String(third.execution_id))).status, "completed");
  assert.deepEqual(await readFile(join(fixture.options.stateDir, oldReceiptName)), oldReceiptBytes, "prior terminal receipt remains byte-identical");
});

test("Pi refuses explicit resume when the protected session file is missing before spawning", async () => {
  const fixture = await piFixture("resume-missing-session");
  const prompts = join(fixture.root, "prompts");
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_PROMPT_MARKER: prompts } });
  const first = await adapter.dispatch(packet("task_resume_missing_source"));
  assert.equal(first.status, "running");
  const sessionFile = await protectedSessionFile(fixture.options.stateDir);
  assert.equal((await adapter.cancel(String(first.execution_id))).status, "cancelled");
  const startsBefore = await readFile(fixture.starts, "utf8"), promptsBefore = await readFile(prompts, "utf8");
  await unlink(sessionFile);

  const refused = await adapter.resume(sessionFile, { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_resume_missing_next", scenario: "ordinary" });
  try {
    assert.equal(refused.status, "failed");
    assert.equal(refused.effect, "none");
    assert.match(String(refused.error), /session file.*missing|does not exist/i);
    assert.deepEqual(await readFile(fixture.starts, "utf8"), startsBefore, "missing-session resume does not start another RPC child");
    assert.deepEqual(await readFile(prompts, "utf8"), promptsBefore, "missing-session resume does not send another prompt");
  } finally { if (refused.status === "running") await adapter.cancel(String(refused.execution_id)); }
});

test("Pi refuses explicit resume when the protected session file is replaced between validation and launch", async () => {
  const fixture = await piFixture("resume-replaced-session");
  const prompts = join(fixture.root, "prompts");
  const source = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_PROMPT_MARKER: prompts } });
  const first = await source.dispatch(packet("task_resume_replaced_source"));
  assert.equal(first.status, "running");
  const sessionFile = await protectedSessionFile(fixture.options.stateDir);
  assert.equal((await source.cancel(String(first.execution_id))).status, "cancelled");
  const startsBefore = await readFile(fixture.starts, "utf8"), promptsBefore = await readFile(prompts, "utf8");
  const replacement = join(fixture.root, "replacement-session.jsonl");
  await writeFile(replacement, "replacement\n", { mode: 0o600 });
  const fakePi = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
  await writeFile(fixture.options.executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then mv "${replacement}" "${sessionFile}"; echo 1.5.2; exit 0; fi\nexec "${node}" "${fakePi}" "$@"\n`, { mode: 0o700 });

  const resumeAdapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_PROMPT_MARKER: prompts } });
  const resumed = await resumeAdapter.resume(sessionFile, { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_resume_replaced_next", scenario: "ordinary" });
  try {
    assert.equal(resumed.status, "failed");
    assert.equal(resumed.effect, "none");
    assert.match(String(resumed.error), /changed during.*resume|changed during validation/i);
    assert.deepEqual(await readFile(fixture.starts, "utf8"), startsBefore, "replaced-session resume does not start another RPC child");
    assert.deepEqual(await readFile(prompts, "utf8"), promptsBefore, "replaced-session resume does not send another prompt");
  } finally { if (resumed.status === "running") await resumeAdapter.cancel(String(resumed.execution_id)); }
});

test("Pi creates default-mode provider sessions privately and safely resumes proven legacy mode", async () => {
  const fixture = await piFixture("default-provider-mode");
  const originalUmask = process.umask();
  const adapter = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_DEFAULT_SESSION_MODE: "1" } });
  const first = await adapter.dispatch(packet("task_default_provider_mode"));
  assert.equal(first.status, "running");
  const sessionFile = await protectedSessionFile(fixture.options.stateDir);
  assert.equal((await lstat(sessionFile)).mode & 0o777, 0o600);
  assert.equal(process.umask(), originalUmask);
  assert.equal((await adapter.cancel(String(first.execution_id))).status, "cancelled");
  await chmod(sessionFile, 0o644);
  const resumed = await adapter.resume(sessionFile, { repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_legacy_mode_resume", scenario: "ordinary" });
  assert.equal(resumed.status, "running");
  assert.equal((await lstat(sessionFile)).mode & 0o777, 0o600);
  assert.equal((await adapter.collect(String(resumed.execution_id))).status, "completed");
  assert.equal(process.umask(), originalUmask);
});

test("Pi refuses cross-role resume provenance from the same receipt root before another child or prompt", async () => {
  const fixture = await piFixture("resume-cross-role");
  const prompts = join(fixture.root, "prompts");
  const agent = new PiRpcExecutorAdapter({ ...fixture.options, environment: { ...fixture.options.environment, FAKE_PI_PROMPT_MARKER: prompts } });
  const first = await agent.dispatch(packet("task_cross_role_source"));
  assert.equal(first.status, "running");
  const sessionFile = await protectedSessionFile(fixture.options.stateDir);
  assert.equal((await agent.cancel(String(first.execution_id))).status, "cancelled");
  const startsBefore = await readFile(fixture.starts, "utf8"), promptsBefore = await readFile(prompts, "utf8");
  const reviewer = new PiRpcExecutorAdapter({ ...fixture.options, role: "reviewer", environment: { ...fixture.options.environment, FAKE_PI_PROMPT_MARKER: prompts } });
  await assert.rejects(reviewer.resume(sessionFile, packet("task_cross_role_reviewer", { kind: "review" })), /role differs/i);
  assert.deepEqual(await readFile(fixture.starts, "utf8"), startsBefore);
  assert.deepEqual(await readFile(prompts, "utf8"), promptsBefore);
});

test("Pi inspection of an already-settled owned session shuts down the child and publishes terminal proof", async () => {
  const fixture = await piFixture("terminal-cancel-cleanup");
  const childPidPath = join(fixture.root, "child.pid");
  await writeFile(fixture.options.executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\necho $$ > "${childPidPath}"\nexec "${node}" "${new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname}" "$@"\n`, { mode: 0o700 });
  const started = await fixture.adapter.dispatch({ repo: "fixture/protocol", delivery_id: "delivery-protocol", task_id: "task_terminal_cancel_cleanup", scenario: "ordinary" });
  assert.equal(started.status, "running");
  await new Promise((accept) => setTimeout(accept, 120));
  const childPid = Number((await readFile(childPidPath, "utf8")).trim());
  try {
    assert.equal((await fixture.adapter.inspect(String(started.execution_id))).status, "completed");
    assert.deepEqual((await readdir(fixture.options.sessionOwnersDir)).filter((name) => !name.startsWith(".")), []);
    assert.throws(() => process.kill(childPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally { try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ } }
});

test("two Pi controller processes reserve one exact packet context and launch one prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-pi-context-race-")), wrapper = join(root, "pi"), starts = join(root, "starts"), prompts = join(root, "prompts");
  const fixturePath = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${node}" "${fixturePath}" "$@"\n`, { mode: 0o700 });
  const options = { executable: wrapper, cwd: root, stateDir: join(root, "receipts"), sessionOwnersDir: join(root, "owners"), sessionDir: join(root, "sessions"), role: "agent", timeoutMs: 2_000, environment: { FAKE_PI_START_MARKER: starts, FAKE_PI_PROMPT_MARKER: prompts } };
  const request = { repo: "fixture/protocol", delivery_id: "delivery-context-race", task_id: "task_context_race", scenario: "hold" };
  const executorUrl = new URL("../src/executors.ts", import.meta.url).href;
  const program = `import{PiRpcExecutorAdapter}from ${JSON.stringify(executorUrl)};const adapter=new PiRpcExecutorAdapter(${JSON.stringify(options)}),packet=${JSON.stringify(request)};let result;process.send({kind:"ready"});process.on("message",async message=>{if(message==="go"){result=await adapter.dispatch(packet);process.send({kind:"result",result});}if(message==="stop"){if(result?.status==="running")await adapter.cancel(result.execution_id);process.send({kind:"done"});process.exit(0);}});`;
  const children = [0, 1].map(() => spawn(node, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: ["ignore", "ignore", "inherit", "ipc"] }));
  const messages: Array<{ kind: string; result?: Record<string, unknown> }> = [];
  await Promise.all(children.map((child) => new Promise<void>((accept, reject) => { const handler = (message: { kind: string; result?: Record<string, unknown> }) => { messages.push(message); if (message.kind === "ready") { child.off("message", handler); accept(); } }; child.on("message", handler); child.once("error", reject); })));
  for (const child of children) child.send("go");
  for (const child of children) await new Promise<void>((accept, reject) => { const handler = (message: { kind: string; result?: Record<string, unknown> }) => { messages.push(message); if (message.kind === "result") { child.off("message", handler); accept(); } }; child.on("message", handler); child.once("error", reject); });
  const results = messages.filter((message) => message.kind === "result").map((message) => message.result!);
  assert.equal(results.filter((result) => result.status === "running").length, 1);
  assert.equal((await readdir(options.stateDir)).filter((name) => /^ar_[0-9a-f]{32}\.json$/.test(name)).length, 1);
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1);
  assert.equal((await readFile(prompts, "utf8")).trim().split("\n").length, 1);
  for (const child of children) child.send("stop");
  await Promise.all(children.map((child) => new Promise<void>((accept) => child.once("exit", () => accept()))));
});

test("Pi fails closed on historical duplicate receipts for one exact packet context", async () => {
  const fixture = await piFixture("historical-context-duplicates"), request = packet("task_historical_duplicates"), context = { repo: "github.com/fixture/protocol", delivery_id: "delivery-protocol", task_id: String(request.task_id), packet_digest: digest(request) };
  const store = new AdapterReceiptStore(fixture.options.stateDir, "agent"), now = new Date().toISOString();
  for (let index = 0; index < 2; index += 1) {
    const reference = store.newReference();
    store.write({ schema_version: 1, adapter: "pi", reference, role: "agent", ...context, execution_id: `pi:v1:${reference}`, state: "intent", created_at: now, updated_at: now, private: { provider: null, model: null } });
  }
  await assert.rejects(fixture.adapter.dispatch(request), /multiple protected adapter receipts/);
  await assert.rejects(readFile(fixture.starts, "utf8"), /ENOENT/);
});

test("adapter terminal receipt bytes are immutable after the first terminal transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-adapter-receipt-cas-"));
  const store = new AdapterReceiptStore(root, "agent");
  const reference = store.newReference(), now = new Date().toISOString();
  const base: AdapterReceipt = {
    schema_version: 1,
    adapter: "paseo",
    reference,
    role: "agent",
    repo: "github.com/fixture/protocol",
    delivery_id: "delivery-protocol",
    task_id: "task_receipt_cas",
    packet_digest: digest({ task: "receipt-cas" }),
    execution_id: `paseo:v1:${reference}`,
    state: "accepted",
    created_at: now,
    updated_at: now,
  };
  store.write(base);
  const completed = {
    ...base,
    state: "terminal" as const,
    proof_kind: "run_receipt" as const,
    outcome: { execution_id: base.execution_id, status: "completed" as const, effect: "accepted" as const, terminal: "completed" as const, proof: { kind: "run_receipt" as const, reference }, provider: "paseo" },
  };
  store.write(completed);
  const cancelled = {
    ...base,
    state: "terminal" as const,
    proof_kind: "archive_ack" as const,
    outcome: { execution_id: base.execution_id, status: "cancelled" as const, effect: "accepted" as const, terminal: "cancelled" as const, proof: { kind: "archive_ack" as const, reference }, provider: "paseo" },
  };
  assert.throws(() => store.write(cancelled), /terminal|immutable|transition/i);
  assert.deepEqual(store.read(reference), completed);
});

test("adapter receipt transition recovers only a proven-dead exact lock owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-adapter-receipt-dead-owner-"));
  const store = new AdapterReceiptStore(root, "agent"), reference = store.newReference(), now = new Date().toISOString();
  const intent: AdapterReceipt = { schema_version: 1, adapter: "pi", reference, role: "agent", repo: "github.com/fixture/protocol", delivery_id: "delivery-dead-owner", task_id: "task_dead_owner", packet_digest: digest("dead-owner"), execution_id: `pi:v1:${reference}`, state: "intent", created_at: now, updated_at: now };
  store.write(intent);
  const lockPath = join(root, `.transition-${reference}`), locksUrl = new URL("../src/locks.ts", import.meta.url).href;
  const child = spawn(node, ["--experimental-strip-types", "--input-type=module", "-e", `import {acquireDirectoryLockSync} from ${JSON.stringify(locksUrl)};acquireDirectoryLockSync(${JSON.stringify(lockPath)},{test:"dead-owner"});`], { stdio: "ignore" });
  await new Promise<void>((accept, reject) => { child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`lock child exited ${code}`))); child.once("error", reject); });
  const accepted = store.write({ ...intent, state: "accepted", updated_at: new Date().toISOString() });
  assert.equal(accepted.state, "accepted");
});

test("adapter receipt transition waits for a live writer and converges on its terminal winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-adapter-receipt-live-winner-"));
  const store = new AdapterReceiptStore(root, "agent"), reference = store.newReference(), now = new Date().toISOString();
  const accepted: AdapterReceipt = { schema_version: 1, adapter: "paseo", reference, role: "agent", repo: "github.com/fixture/protocol", delivery_id: "delivery-live-winner", task_id: "task_live_winner", packet_digest: digest("live-winner"), execution_id: `paseo:v1:${reference}`, state: "accepted", created_at: now, updated_at: now };
  store.write(accepted);
  const completed: AdapterReceipt = { ...accepted, state: "terminal", proof_kind: "run_receipt", outcome: { execution_id: accepted.execution_id, status: "completed", effect: "accepted", terminal: "completed", proof: { kind: "run_receipt", reference }, provider: "paseo" }, updated_at: new Date().toISOString() };
  const cancelled: AdapterReceipt = { ...accepted, state: "terminal", proof_kind: "archive_ack", outcome: { execution_id: accepted.execution_id, status: "cancelled", effect: "accepted", terminal: "cancelled", proof: { kind: "archive_ack", reference }, provider: "paseo" }, updated_at: new Date().toISOString() };
  const lockPath = join(root, `.transition-${reference}`), receiptPath = store.path(reference), locksUrl = new URL("../src/locks.ts", import.meta.url).href;
  const program = `import{writeFileSync,renameSync}from"node:fs";import{acquireDirectoryLockSync,releaseDirectoryLockSync}from ${JSON.stringify(locksUrl)};const lock=${JSON.stringify(lockPath)},path=${JSON.stringify(receiptPath)},value=${JSON.stringify(JSON.stringify(completed))};const owner=acquireDirectoryLockSync(lock,{test:"live-winner"});process.send("ready");setTimeout(()=>{const temp=path+".winner";writeFileSync(temp,value,{mode:0o600});renameSync(temp,path);releaseDirectoryLockSync(lock,owner);process.send("done");},150);`;
  const child = spawn(node, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let ready!: () => void, done!: () => void;
  const readyPromise = new Promise<void>((accept) => { ready = accept; }), donePromise = new Promise<void>((accept) => { done = accept; });
  child.on("message", (message) => { if (message === "ready") ready(); if (message === "done") done(); });
  await readyPromise;
  const winner = store.write(cancelled);
  assert.equal(winner.outcome?.status, "completed");
  await donePromise;
  child.disconnect();
});

test("concurrent Paseo collect and cancel converge on the first immutable terminal receipt", async () => {
  const collectGate = deferred(), cancelGate = deferred();
  const taskId = "task_paseo_terminal_race";
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`);
  const labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": "delivery-terminal-race", "codex-toolkit.role": "agent" };
  const agent = {
    id: agentId, status: "running", pendingPermissions: null, lastError: null,
    async refresh() {},
    current() { return { workspaceId: "workspace-terminal-race", provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; },
    async send() {},
    async waitForFinish() { await collectGate.promise; return { status: "idle" as const, error: null, lastMessage: JSON.stringify({ schema_version: 1, result: { ok: true } }) }; },
    async reload() {},
    async archive() { await cancelGate.promise; },
  };
  const workspace = { id: "workspace-terminal-race", directory: process.cwd(), agents: { async create() { return agent; } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  const paseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
    workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } },
    agents: { async list() { return { entries: [] }; }, ref() { return agent; } },
  };
  const stateDir = await mkdtemp(join(tmpdir(), "delivery-paseo-terminal-race-"));
  const options = {
    hostId: "host-terminal-race",
    stateDir,
    role: "agent" as const,
    repositoryRepo: "kasparsj/codex-toolkit",
    repositoryPath: process.cwd(),
    repositoryCommonDir: commonDir,
    baseRef: "main",
    baseSha: currentSha,
    provider: "codex",
    model: "gpt-5.6",
    ...codexSettings,
    branchName: () => "main",
    prompt: JSON.stringify,
  };
  const request = { repo: "kasparsj/codex-toolkit", delivery_id: "delivery-terminal-race", task_id: taskId };
  const adapter = new PaseoExecutorAdapter({ ...options, paseo });
  const started = await adapter.dispatch(request);
  const collecting = adapter.collect(String(started.execution_id));
  const cancelling = adapter.cancel(String(started.execution_id));
  collectGate.resolve();
  const completed = await collecting;
  assert.equal(completed.status, "completed");
  cancelGate.resolve();
  const loser = await cancelling;
  assert.equal(loser.status, "completed");
  assert.equal((await adapter.inspect(String(started.execution_id))).status, "completed");
  const unavailable = {
    providers: { ...paseoDiscovery(), async listAvailable() { throw new Error("offline"); }, async listModels() { throw new Error("offline"); } },
    workspaces: { async list() { throw new Error("offline"); }, async create() { throw new Error("offline"); }, ref() { throw new Error("offline"); } },
    agents: { async list() { throw new Error("offline"); }, ref() { throw new Error("offline"); } },
  };
  const offline = new PaseoExecutorAdapter({ ...options, paseo: unavailable, repositoryPath: join(stateDir, "missing-source"), repositoryCommonDir: join(stateDir, "missing-common") });
  assert.equal((await offline.inspect(String(started.execution_id))).status, "completed");
  assert.equal((await offline.dispatch(request)).status, "completed");
});

test("Paseo recovery never downgrades a prior possible create effect to a no-effect refusal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "delivery-paseo-prior-effect-"));
  const taskId = "task_paseo_prior_effect";
  const packet = { repo: "kasparsj/codex-toolkit", delivery_id: "delivery-prior-effect", task_id: taskId };
  const initialPaseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
    workspaces: { async list() { return { entries: [] }; }, async create() { throw new Error("workspace create response lost"); }, ref() { throw new Error("unused"); } },
    agents: { async list() { return { entries: [] }; }, ref() { throw new Error("unused"); } },
  };
  const options = {
    hostId: "host-prior-effect",
    stateDir,
    role: "agent" as const,
    repositoryRepo: "kasparsj/codex-toolkit",
    repositoryPath: process.cwd(),
    repositoryCommonDir: commonDir,
    baseRef: "main",
    baseSha: currentSha,
    provider: "codex",
    model: "gpt-5.6",
    ...codexSettings,
    branchName: () => "main",
    prompt: JSON.stringify,
  };
  const first = await new PaseoExecutorAdapter({ ...options, paseo: initialPaseo }).dispatch(packet);
  assert.equal(first.status, "uncertain");
  assert.match(String(first.error), /disposition is unknown/);

  const unavailablePaseo = {
    ...initialPaseo,
    providers: { ...paseoDiscovery(), async listAvailable() { throw new Error("host disconnected"); }, async listModels() { throw new Error("must not reach model lookup"); } },
  };
  const recovered = await new PaseoExecutorAdapter({ ...options, paseo: unavailablePaseo }).dispatch(packet);
  assert.equal(recovered.status, "uncertain");
  assert.equal(recovered.effect, "unknown");
  assert.equal(recovered.terminal, "nonterminal");
  assert.match(String(recovered.error), /prior|possible|reconcil/i);
});

test("Paseo inspect collect and cancel revalidate exact protected role and Git context before observation or mutation", async () => {
  const taskId = "task_paseo_reconnect_context";
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`);
  let waitCalls = 0, archiveCalls = 0;
  const labels = {
    "codex-toolkit.task-id": taskId,
    "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit",
    "codex-toolkit.delivery": "delivery-reconnect-context",
    "codex-toolkit.role": "reviewer",
  };
  const agent = {
    id: agentId, status: "running", pendingPermissions: null, lastError: null,
    async refresh() {},
    current() { return { workspaceId: "workspace-reconnect-context", provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; },
    async send() {},
    async waitForFinish() { waitCalls += 1; return { status: "idle" as const, error: null, lastMessage: "{}" }; },
    async reload() {},
    async archive() { archiveCalls += 1; },
  };
  const workspace = {
    id: "workspace-reconnect-context", directory: process.cwd(), agents: { async create() { return agent; } },
    async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {},
  };
  const paseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
    workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } },
    agents: { async list() { return { entries: [] }; }, ref() { return agent; } },
  };
  const adapter = new PaseoExecutorAdapter({
    paseo,
    hostId: "host-reconnect-context",
    stateDir: await mkdtemp(join(tmpdir(), "delivery-paseo-reconnect-context-")),
    role: "agent",
    repositoryRepo: "kasparsj/codex-toolkit",
    repositoryPath: process.cwd(),
    repositoryCommonDir: commonDir,
    baseRef: "main",
    baseSha: currentSha,
    provider: "codex",
    model: "gpt-5.6",
    ...codexSettings,
    branchName: () => "main",
    prompt: JSON.stringify,
  });
  const started = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "delivery-reconnect-context", task_id: taskId });
  for (const operation of [adapter.inspect.bind(adapter), adapter.collect.bind(adapter), adapter.cancel.bind(adapter)]) {
    const result = await operation(String(started.execution_id));
    assert.equal(result.status, "uncertain");
    assert.match(String(result.error), /role|labels|protected intent/i);
  }
  assert.equal(waitCalls, 0);
  assert.equal(archiveCalls, 0);
});

test("Paseo fresh create validates the returned agent snapshot before accepted proof", async () => {
  const taskId = "task_paseo_fresh_snapshot", agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`);
  let refreshCalls = 0, currentCalls = 0, archiveCalls = 0;
  const agent = {
    id: agentId, status: "running", pendingPermissions: null, lastError: null,
    async refresh() { refreshCalls += 1; },
    current() { currentCalls += 1; return { workspaceId: "wrong-workspace", provider: "wrong", model: "wrong", cwd: "/tmp", labels: { "codex-toolkit.role": "reviewer" }, ...paseoSnapshot }; },
    async send() { throw new Error("must not prompt"); },
    async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() { archiveCalls += 1; },
  };
  const workspace = { id: "workspace-fresh-snapshot", directory: process.cwd(), agents: { async create() { return agent; } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  const paseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
    workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } },
    agents: { async list() { return { entries: [] }; }, ref() { return agent; } },
  };
  const result = await new PaseoExecutorAdapter({ paseo, hostId: "host-fresh-snapshot", stateDir: await mkdtemp(join(tmpdir(), "delivery-paseo-fresh-snapshot-")), role: "agent", repositoryRepo: "kasparsj/codex-toolkit", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", ...codexSettings, branchName: () => "main", prompt: JSON.stringify }).dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "delivery-fresh-snapshot", task_id: taskId });
  assert.equal(result.status, "uncertain");
  assert.equal(result.terminal, "nonterminal");
  assert.ok(refreshCalls > 0);
  assert.ok(currentCalls > 0);
  assert.equal(archiveCalls, 0);
});

test("Paseo preserves exact created identities as uncertainty when post-create refresh responses are lost", async () => {
  const request = { repo: "kasparsj/codex-toolkit", delivery_id: "delivery-refresh-loss", task_id: "task_refresh_loss" };
  const labels = { "codex-toolkit.task-id": request.task_id, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": request.delivery_id, "codex-toolkit.role": "agent" };
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${request.task_id}`);
  const baseOptions = { hostId: "host-refresh-loss", role: "agent" as const, repositoryRepo: "kasparsj/codex-toolkit", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", ...codexSettings, branchName: () => "main", prompt: JSON.stringify };

  for (const loss of ["workspace", "agent"] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), `delivery-paseo-${loss}-refresh-loss-`));
    let workspaceCreates = 0, agentCreates = 0;
    const workspaceId = `workspace-${loss}-refresh-loss`;
    const agent = {
      id: agentId, status: "running", pendingPermissions: null, lastError: null,
      async refresh() { if (loss === "agent") throw new Error("agent refresh response lost"); },
      current() { return { workspaceId, provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; },
      async send() {},
      async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() {},
    };
    let workspaceRefreshes = 0;
    const workspace = {
      id: workspaceId, directory: process.cwd(), agents: { async create() { agentCreates += 1; return agent; } },
      async refresh() { workspaceRefreshes += 1; if (loss === "workspace" && workspaceRefreshes === 1) throw new Error("workspace refresh response lost"); },
      current() { return { workspaceDirectory: process.cwd() }; }, async archive() {},
    };
    const paseo = {
      providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
      workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; return workspace; }, ref() { return workspace; } },
      agents: { async list() { return { entries: [] }; }, ref() { return agent; } },
    };
    const result = await new PaseoExecutorAdapter({ ...baseOptions, paseo, stateDir }).dispatch(request);
    assert.equal(result.status, "uncertain", loss);
    assert.equal(result.effect, "unknown", loss);
    assert.equal(result.terminal, "nonterminal", loss);
    assert.equal(workspaceCreates, 1, loss);
    assert.equal(agentCreates, loss === "workspace" ? 0 : 1, loss);
    const receiptName = (await readdir(stateDir)).find((name) => /^ar_[0-9a-f]{32}\.json$/.test(name));
    assert.ok(receiptName, loss);
    const receipt = JSON.parse(await readFile(join(stateDir, receiptName), "utf8"));
    assert.equal(receipt.private.workspace_id, workspaceId, loss);
    if (loss === "agent") assert.equal(receipt.private.agent_id, agentId, loss);
  }
});

test("two Paseo controllers hold one exact async dispatch owner across create and prompt effects", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "delivery-paseo-operation-owner-"));
  const request = { repo: "kasparsj/codex-toolkit", delivery_id: "delivery-operation-owner", task_id: "task_operation_owner" };
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${request.task_id}`), workspaceId = "workspace-operation-owner";
  const labels = { "codex-toolkit.task-id": request.task_id, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": request.delivery_id, "codex-toolkit.role": "agent" };
  const listEntered = deferred(), releaseList = deferred();
  let listCalls = 0, workspaceCreates = 0, agentCreates = 0, prompts = 0;
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId, provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; }, async send() { prompts += 1; }, async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() {} };
  const workspace = { id: workspaceId, directory: process.cwd(), agents: { async create(options: Record<string, unknown>) { agentCreates += 1; assert.equal(options.prompt, undefined); return agent; } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  const paseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
    agents: { async list() { listCalls += 1; listEntered.resolve(); await releaseList.promise; return { entries: [] }; }, ref() { return agent; } },
    workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; return workspace; }, ref() { return workspace; } },
  };
  const options = { paseo, hostId: "host-operation-owner", stateDir, role: "agent" as const, repositoryRepo: "kasparsj/codex-toolkit", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", ...codexSettings, branchName: () => "main", prompt: JSON.stringify };
  const firstPromise = new PaseoExecutorAdapter(options).dispatch(request);
  await listEntered.promise;
  const observer = await new PaseoExecutorAdapter(options).dispatch(request);
  assert.equal(observer.status, "uncertain");
  assert.match(String(observer.error), /live controller|duplicate/i);
  assert.equal(listCalls, 1);
  assert.equal(workspaceCreates, 0);
  assert.equal(agentCreates, 0);
  releaseList.resolve();
  const owner = await firstPromise;
  assert.equal(owner.status, "running");
  assert.equal(listCalls, 1);
  assert.equal(workspaceCreates, 1);
  assert.equal(agentCreates, 1);
  assert.equal(prompts, 1);
  assert.equal((await readdir(stateDir)).filter((name) => /^ar_[0-9a-f]{32}\.json$/.test(name)).length, 1);
});

test("Paseo dead or unknown exact operation owners never trigger a zero-match blind create", async () => {
  for (const ownership of ["dead", "unknown"] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), `delivery-paseo-${ownership}-owner-`));
    const request = { repo: "kasparsj/codex-toolkit", delivery_id: `delivery-${ownership}-owner`, task_id: `task_${ownership}_owner` };
    const context = { repo: "github.com/kasparsj/codex-toolkit", delivery_id: request.delivery_id, task_id: request.task_id, packet_digest: digest(request) };
    const store = new AdapterReceiptStore(stateDir, "agent"), reference = store.newReference(), now = new Date().toISOString();
    const hostId = `host-${ownership}-owner`, agentId = executorInternals.stableUuid(`agent:${context.repo}:${request.task_id}`);
    const selectedConfig = { provider: "codex/gpt-5.6", ...codexSettings }, labels = { "codex-toolkit.delivery": context.delivery_id, "codex-toolkit.task-id": request.task_id, "codex-toolkit.repo": context.repo, "codex-toolkit.role": "agent" };
    const createRequest = { agentId, config: selectedConfig, idempotencyKey: request.task_id, requestId: executorInternals.stableUuid(`agent-create:${context.repo}:${request.task_id}`), labels };
    const selectedConfigDigest = digest(selectedConfig), sourcePath = realpathSync(process.cwd());
    const receipt: AdapterReceipt = { schema_version: 1, adapter: "paseo", reference, role: "agent", ...context, execution_id: `paseo:v1:${reference}`, state: "intent", created_at: now, updated_at: now, private: { phase: "preflight", host_id: hostId, source_path: sourcePath, common_dir: commonDir, base_ref: "main", base_sha: currentSha, branch: "main", provider: "codex", model: "gpt-5.6", selected_config: selectedConfig, selected_config_digest: selectedConfigDigest, agent_create_request: createRequest, agent_create_request_digest: digest(createRequest), profile_fingerprint: digest({ host_id: hostId, role: "agent", source_path: sourcePath, common_dir: commonDir, provider: "codex", model: "gpt-5.6", selected_config_digest: selectedConfigDigest }), sdk_contract: "@getpaseo/client@0.15.4", workspace_title: `Delivery [${request.task_id}]`, deterministic_agent_id: agentId, workspace_request_id: executorInternals.stableUuid(`workspace:${context.repo}:${request.task_id}`), agent_request_id: createRequest.requestId, prompt_message_id: executorInternals.stableUuid(`agent-prompt:${context.repo}:${request.task_id}`) } };
    store.write(receipt);
    const lockPath = join(stateDir, `.operation-paseo-${reference}`), lockContext = { operation: "paseo_dispatch", receipt_reference: reference, receipt_role: "agent", repo_digest: digest(context.repo), packet_digest: context.packet_digest };
    if (ownership === "dead") {
      const locksUrl = new URL("../src/locks.ts", import.meta.url).href;
      const identityUrl = new URL("../src/process-identity.ts", import.meta.url).href;
      const child = spawn(node, ["--experimental-strip-types", "--input-type=module", "-e", `import{acquireDirectoryLockSync}from ${JSON.stringify(locksUrl)};import{processIdentity}from ${JSON.stringify(identityUrl)};acquireDirectoryLockSync(${JSON.stringify(lockPath)},{...${JSON.stringify(lockContext)},controller_identity:processIdentity(process.pid)});`], { stdio: "ignore" });
      await new Promise<void>((accept, reject) => { child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`lock child exited ${code}`))); child.once("error", reject); });
    } else {
      acquireDirectoryLockSync(lockPath, { ...lockContext, controller_identity: processIdentity(process.pid)! });
      const ownerPath = join(lockPath, "owner.json"), owner = JSON.parse(await readFile(ownerPath, "utf8"));
      const identity = JSON.parse(owner.context.controller_identity); identity.argv_digest = digest("different-live-command"); owner.context.controller_identity = JSON.stringify(identity);
      await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    }
    let workspaceCreates = 0, agentCreates = 0, listCalls = 0;
    const paseo = {
      providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
      agents: { async list() { listCalls += 1; return { entries: [] }; }, ref() { throw new Error("unused"); } },
      workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; throw new Error("must not create"); }, ref() { throw new Error("unused"); } },
    };
    const result = await new PaseoExecutorAdapter({ paseo, hostId: `host-${ownership}-owner`, stateDir, role: "agent", repositoryRepo: "kasparsj/codex-toolkit", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", ...codexSettings, branchName: () => "main", prompt: JSON.stringify }).dispatch(request);
    assert.equal(result.status, "uncertain", ownership);
    assert.equal(workspaceCreates, 0, ownership);
    assert.equal(agentCreates, 0, ownership);
    assert.equal(listCalls, ownership === "dead" ? 1 : 0, ownership);
    if (ownership === "dead") assert.equal(store.read(reference).private?.operation_recovery_required, true);
  }
});
