import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ExecutableJsonAdapter, PaseoExecutorAdapter, PiRpcExecutorAdapter, executorInternals } from "../src/executors.ts";
import { digest } from "../src/core.ts";

const node = process.execPath;
const currentSha = execFileSync("git", ["rev-parse", "main"], { encoding: "utf8" }).trim();
const commonDir = realpathSync(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
const adapterState = (name: string) => mkdtemp(join(tmpdir(), `delivery-executable-${name}-`));
const piPacket = (extra: Record<string, unknown> = {}) => ({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: `task_${Math.random().toString(16).slice(2).padEnd(12, "0")}`, kind: "plan", ...extra });
const codexSettings = { modeId: "auto", featureValues: { plan_mode: false }, options: { approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } } } as const;
const paseoSnapshot = { currentModeId: "auto", features: [{ type: "toggle" as const, id: "plan_mode", value: false }] };
const paseoDiscovery = (provider = "codex") => ({
  async listModes() { return { provider, modes: [{ id: "auto" }], fetchedAt: "2026-11-12T00:00:00.000Z" }; },
  async listFeatures() { return { provider, features: paseoSnapshot.features, fetchedAt: "2026-11-12T00:00:00.000Z" }; },
});
async function fakePi(name: string, environment: Record<string, string> = {}): Promise<PiRpcExecutorAdapter> { const fixture = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname, dir = await mkdtemp(join(tmpdir(), `delivery-pi-${name}-`)), wrapper = join(dir, "pi"); await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi\nexec "${node}" "${fixture}" "$@"\n`, { mode: 0o700 }); return new PiRpcExecutorAdapter({ executable: wrapper, cwd: process.cwd(), timeoutMs: 2_000, stateDir: join(dir, "receipts"), sessionOwnersDir: join(dir, "owners"), sessionDir: join(dir, "sessions"), role: "agent", environment }); }
async function paseoOptions(name: string, provider = "codex") { return { stateDir: await adapterState(`paseo-${name}`), role: "agent" as const, repositoryRepo: "kasparsj/codex-toolkit", repositoryCommonDir: commonDir, ...(provider === "codex" ? codexSettings : { modeId: "auto", featureValues: {}, options: {} }) }; }
async function collectPaseoText(name: string, lastMessage: string | null, provider = "codex") {
  const taskId = `task_frame_${name.replace(/[^a-z0-9]/gi, "_")}`, deliveryId = `delivery-frame-${name}`;
  const packet = { repo: "kasparsj/codex-toolkit", delivery_id: deliveryId, task_id: taskId };
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`), workspaceId = `workspace-frame-${name}`;
  const labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": deliveryId, "codex-toolkit.role": "agent" };
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId, provider, model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; }, async send() {}, async waitForFinish() { return { status: "idle" as const, error: null, lastMessage }; }, async reload() {}, async archive() {} };
  const workspace = { id: workspaceId, directory: process.cwd(), agents: { async create() { return agent; } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  const paseo = { providers: { ...paseoDiscovery(provider), async listAvailable() { return { providers: [{ provider, available: true }] }; }, async listModels() { return { provider, models: [{ id: "gpt-5.6" }] }; } }, workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } }, agents: { async list() { return { entries: [] }; }, ref() { return agent; } } };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: `host-frame-${name}`, repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider, model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...await paseoOptions(`frame-${name}`, provider) });
  const started = await adapter.dispatch(packet), collected = await adapter.collect(String(started.execution_id));
  return { adapter, packet, started, collected };
}

test("executable adapter sends one packet and validates one result", async () => {
  const adapter = new ExecutableJsonAdapter({ argv: [node, "-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.error('diagnostic');process.stdout.write(JSON.stringify({packet:JSON.parse(s)}))})"], cwd: process.cwd(), stateDir: await adapterState("success") });
  const packet = { hello: "world", repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: "task_exec_1234" }, started = await adapter.dispatch(packet);
  assert.equal(started.status, "running");
  const result = await adapter.collect(String(started.execution_id));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, { packet });
  assert.equal((await adapter.resolveOutcomeProof(result as never, { repo: "github.com/kasparsj/codex-toolkit", delivery_id: "d1", role: "agent", task_id: "task_exec_1234", packet_digest: digest(packet), execution_id: String(started.execution_id) })).trusted, true);
});

test("executable adapter fails closed on invalid output and deadline", async () => {
  const invalid = new ExecutableJsonAdapter({ argv: [node, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('not-json'))"], cwd: process.cwd(), stateDir: await adapterState("invalid") });
  const invalidStarted = await invalid.dispatch({ task_id: "task_invalid_1" });
  assert.match(String((await invalid.collect(String(invalidStarted.execution_id))).error), /invalid JSON/);
  const hanging = new ExecutableJsonAdapter({ argv: [node, "-e", "process.stdin.resume();setInterval(()=>{},1000)"], cwd: process.cwd(), stateDir: await adapterState("timeout"), timeoutMs: 25 });
  const hangingStarted = await hanging.dispatch({ task_id: "task_hanging_1" });
  assert.equal((await hanging.collect(String(hangingStarted.execution_id))).status, "timeout");
});

test("executable adapter exposes a stable running identity and confirms cancellation exit", async () => {
  const stateDir = await adapterState("cancel");
  const options = { argv: [node, "-e", "process.stdin.resume();setInterval(()=>{},1000)"] as const, cwd: process.cwd(), stateDir, timeoutMs: 10_000 };
  const moduleUrl = new URL("../src/executors.ts", import.meta.url).href;
  const dispatchProgram = `import {ExecutableJsonAdapter} from ${JSON.stringify(moduleUrl)};const adapter=new ExecutableJsonAdapter(${JSON.stringify(options)});console.log(JSON.stringify(await adapter.dispatch({task_id:"task_cancel_123"})));`;
  const started = JSON.parse(execFileSync(node, ["--experimental-strip-types", "--input-type=module", "-e", dispatchProgram], { encoding: "utf8", timeout: 2_000 }));
  const separateController = new ExecutableJsonAdapter(options);
  assert.equal(started.execution_id, "process:task_cancel_123");
  assert.equal((await separateController.inspect(String(started.execution_id))).status, "running");
  assert.equal((await separateController.cancel(String(started.execution_id))).status, "cancelled");
  assert.equal((await separateController.collect(String(started.execution_id))).status, "cancelled");
});

test("executable adapter reports owner loss without relaunching", async () => {
  const stateDir = await adapterState("owner-loss");
  const adapter = new ExecutableJsonAdapter({ argv: [node, "-e", "process.stdin.resume();setTimeout(()=>process.exit(0),1000)"], cwd: process.cwd(), stateDir, timeoutMs: 10_000 });
  const started = await adapter.dispatch({ task_id: "task_owner_loss" });
  const [executionDirectory] = await readdir(stateDir);
  const recordPath = join(stateDir, executionDirectory!, "record.json");
  let stored = JSON.parse(await readFile(recordPath, "utf8"));
  for (let attempt = 0; attempt < 50 && !stored.target_pid; attempt += 1) { await new Promise((accept) => setTimeout(accept, 10)); stored = JSON.parse(await readFile(recordPath, "utf8")); }
  assert.equal(typeof stored.worker_pid, "number"); assert.equal(typeof stored.target_pid, "number"); assert.equal(typeof stored.worker_process_identity, "string"); assert.equal(typeof stored.target_process_identity, "string");
  const identity = stored.worker_process_identity; delete stored.worker_process_identity; await writeFile(recordPath, JSON.stringify(stored)); assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain");
  stored.worker_process_identity = JSON.stringify({ started_at: "Mon Jan  1 00:00:00 1990", argv_digest: "0".repeat(64) }); await writeFile(recordPath, JSON.stringify(stored)); assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain");
  stored.worker_process_identity = identity; await writeFile(recordPath, JSON.stringify(stored)); assert.equal((await adapter.inspect(String(started.execution_id))).status, "running");
  process.kill(stored.worker_pid, "SIGKILL");
  for (let attempt = 0; attempt < 50 && (await adapter.inspect(String(started.execution_id))).status === "running"; attempt += 1) await new Promise((accept) => setTimeout(accept, 10));
  assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain");
  process.kill(stored.target_pid, "SIGKILL");
});

test("Paseo adapter discovers provider/model and persists reconnectable identity", async () => {
  const calls: string[] = [];
  let createdAgentRequest: Record<string, unknown> | undefined, discoveredFeatures: Record<string, unknown> | undefined;
  let snapshotMode = "auto", snapshotFeatures = paseoSnapshot.features;
  const agentId = executorInternals.stableUuid("agent:github.com/kasparsj/codex-toolkit:task_12345678"), labels = { "codex-toolkit.task-id": "task_12345678", "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": "d1", "codex-toolkit.role": "agent" };
  const agent = {
    id: agentId, status: "running", pendingPermissions: null, lastError: null,
    async refresh() { calls.push("refresh"); },
    current() { return { workspaceId: "workspace-1", provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, currentModeId: snapshotMode, features: snapshotFeatures }; },
    async send() { calls.push("send"); },
    async waitForFinish() { calls.push("wait"); return { status: "idle" as const, error: null, lastMessage: JSON.stringify({ schema_version: 1, result: {} }) }; },
    async reload() { calls.push("reload"); }, async archive() { calls.push("archive"); },
  };
  const paseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6", isSelectable: true }] }; }, async listFeatures(input: Record<string, unknown>) { discoveredFeatures = input; return { provider: "codex", features: paseoSnapshot.features, fetchedAt: "2026-11-12T00:00:00.000Z" }; } },
    workspaces: { async list() { calls.push("list-workspaces"); return { entries: [] }; }, async create(input: Record<string, unknown>) { calls.push(`workspace:${String((input.source as Record<string, unknown>).kind)}`); return { id: "workspace-1", directory: process.cwd(), async refresh() { calls.push("workspace-refresh"); }, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {}, agents: { async create(input: Record<string, unknown>) { createdAgentRequest = input; calls.push("agent"); return agent; } } }; }, ref() { return { id: "workspace-1", directory: process.cwd(), async refresh() { calls.push("workspace-refresh"); }, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {}, agents: { async create() { throw new Error("unused"); } } }; } },
    agents: { async list() { calls.push("list-agents"); return { entries: [] }; }, ref(id: string) { assert.equal(id, agentId); return agent; } },
  };
  const protectedOptions = await paseoOptions("discover");
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "host-1", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...protectedOptions });
  const dispatched = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: "task_12345678" });
  assert.equal(dispatched.status, "running");
  assert.match(String(dispatched.execution_id), /^paseo:v1:ar_/);
  assert.equal((await adapter.inspect(String(dispatched.execution_id))).status, "running");
  const changedSettings = new PaseoExecutorAdapter({ paseo, hostId: "host-1", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...protectedOptions, featureValues: {} });
  const held = await changedSettings.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: "task_12345678" });
  assert.equal(held.status, "uncertain"); assert.match(String(held.error), /selected settings/);
  snapshotMode = "full-access"; assert.equal((await adapter.inspect(String(dispatched.execution_id))).status, "uncertain"); snapshotMode = "auto";
  snapshotFeatures = [{ type: "toggle", id: "plan_mode", value: true }]; assert.equal((await adapter.inspect(String(dispatched.execution_id))).status, "uncertain"); snapshotFeatures = paseoSnapshot.features;
  assert.equal((await adapter.collect(String(dispatched.execution_id))).status, "completed");
  assert.equal((await adapter.cancel(String(dispatched.execution_id))).status, "completed", "terminal receipt is idempotent and is not overwritten by a late cancel");
  assert.deepEqual(discoveredFeatures, { provider: "codex/gpt-5.6", cwd: realpathSync(process.cwd()), modeId: "auto", featureValues: { plan_mode: false } });
  assert.deepEqual(createdAgentRequest?.config, { provider: "codex/gpt-5.6", ...codexSettings });
  assert.equal(createdAgentRequest?.prompt, undefined, "agent creation must not start work before returned snapshot validation");
  assert.deepEqual(calls, ["list-agents", "list-workspaces", "workspace:worktree", "workspace-refresh", "agent", "refresh", "workspace-refresh", "send", "refresh", "workspace-refresh", "refresh", "workspace-refresh", "refresh", "workspace-refresh", "refresh", "workspace-refresh", "wait"]);
});

test("Paseo generic provider uses explicit discovered capabilities without leaking protected settings into prompt or public outcome", async () => {
  const stateDir = await adapterState("paseo-generic-settings"), taskId = "task_generic_capabilities", deliveryId = "delivery-generic-capabilities", canary = "private-capability-canary";
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`), workspaceId = "workspace-generic-capabilities";
  const labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": deliveryId, "codex-toolkit.role": "agent" };
  let created: Record<string, unknown> | undefined, sent = "";
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId, provider: "pi", model: "fixture", cwd: process.cwd(), labels, currentModeId: "safe", features: [{ type: "select" as const, id: "permission_profile", value: canary, options: [{ id: canary }] }] }; }, async send(text: string) { sent = text; }, async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() {} };
  const workspace = { id: workspaceId, directory: process.cwd(), async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {}, agents: { async create(input: Record<string, unknown>) { created = input; return agent; } } };
  const paseo = { providers: { async listAvailable() { return { providers: [{ provider: "pi", available: true }] }; }, async listModels() { return { provider: "pi", models: [{ id: "fixture" }] }; }, async listModes() { return { provider: "pi", modes: [{ id: "safe" }] }; }, async listFeatures() { return { provider: "pi", features: [{ type: "select" as const, id: "permission_profile", value: canary, options: [{ id: canary }] }] }; } }, workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } }, agents: { async list() { return { entries: [] }; }, ref() { return agent; } } };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "host-generic-capabilities", stateDir, role: "agent", repositoryRepo: "kasparsj/codex-toolkit", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "pi", model: "fixture", modeId: "safe", featureValues: { permission_profile: canary }, options: {}, branchName: () => "main", prompt: JSON.stringify });
  const started = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: deliveryId, task_id: taskId });
  assert.equal(started.status, "running"); assert.equal(JSON.stringify(started).includes(canary), false); assert.equal(sent.includes(canary), false);
  assert.deepEqual((created?.config as Record<string, unknown>)?.featureValues, { permission_profile: canary }); assert.equal(created?.prompt, undefined);
  const receiptName = (await readdir(stateDir)).find((name) => /^ar_[0-9a-f]{32}\.json$/.test(name)); assert.ok(receiptName);
  const receipt = JSON.parse(await readFile(join(stateDir, receiptName), "utf8")); assert.equal(receipt.private.selected_config.featureValues.permission_profile, canary); assert.equal(JSON.stringify(receipt.outcome ?? {}).includes(canary), false);
});

test("Paseo mode-less provider omits mode from discovery, creation, provenance, and exact reconnect", async () => {
  const stateDir = await adapterState("paseo-mode-less"), taskId = "task_mode_less_provider", deliveryId = "delivery-mode-less-provider";
  const agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`), workspaceId = "workspace-mode-less";
  const labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": deliveryId, "codex-toolkit.role": "agent" };
  let created = false, workspaceCreates = 0, agentCreates = 0, sends = 0, snapshotHasMode = true, snapshotMode: unknown = null;
  let featureRequest: Record<string, unknown> | undefined, createRequest: Record<string, unknown> | undefined;
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId, provider: "pi", model: "fixture", cwd: process.cwd(), labels, ...(snapshotHasMode ? { currentModeId: snapshotMode } : {}), features: [] }; }, async send() { sends += 1; }, async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() {} };
  const workspace = { id: workspaceId, directory: process.cwd(), async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {}, agents: { async create(input: Record<string, unknown>) { agentCreates += 1; created = true; createRequest = input; return agent; } } };
  const paseo = {
    providers: {
      async listAvailable() { return { providers: [{ provider: "pi", available: true }] }; },
      async listModels() { return { provider: "pi", models: [{ id: "fixture" }] }; },
      async listModes() { return { provider: "pi", modes: [] }; },
      async listFeatures(input: Record<string, unknown>) { featureRequest = input; return { provider: "pi", features: [] }; },
    },
    workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; return workspace; }, ref(id: string) { assert.equal(id, workspaceId); return workspace; } },
    agents: { async list() { return { entries: created ? [{ agent: { id: agentId, workspaceId, labels } }] : [] }; }, ref(id: string) { assert.equal(id, agentId); return agent; } },
  };
  const options = { paseo, hostId: "host-mode-less", stateDir, role: "agent" as const, repositoryRepo: "kasparsj/codex-toolkit", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "pi", model: "fixture", featureValues: {}, options: {}, branchName: () => "main", prompt: JSON.stringify };
  const adapter = new PaseoExecutorAdapter(options);
  const packet = { repo: "kasparsj/codex-toolkit", delivery_id: deliveryId, task_id: taskId };
  const started = await adapter.dispatch(packet);
  assert.equal(started.status, "running");
  assert.equal(Object.prototype.hasOwnProperty.call(featureRequest, "modeId"), false);
  const createdConfig = createRequest?.config as Record<string, unknown>; assert.equal(Object.prototype.hasOwnProperty.call(createdConfig, "modeId"), false);
  const receiptName = (await readdir(stateDir)).find((name) => /^ar_[0-9a-f]{32}\.json$/.test(name)); assert.ok(receiptName);
  const receiptPath = join(stateDir, receiptName), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(receipt.private.selected_config, "modeId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(receipt.private.agent_create_request.config, "modeId"), false);
  assert.equal(receipt.private.selected_config_digest, digest(receipt.private.selected_config));
  assert.equal(receipt.private.agent_create_request_digest, digest(receipt.private.agent_create_request));
  assert.equal((await adapter.inspect(String(started.execution_id))).status, "running");
  const repeated = await adapter.dispatch(packet); assert.equal(repeated.status, "running"); assert.equal(repeated.reconciled, true);
  assert.equal(workspaceCreates, 1); assert.equal(agentCreates, 1); assert.equal(sends, 1);

  snapshotHasMode = false; assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain", "missing mode snapshot is not mode-less proof");
  snapshotHasMode = true; snapshotMode = undefined; assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain", "undefined mode snapshot is not mode-less proof");
  snapshotMode = "safe"; assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain", "non-null mode snapshot is not mode-less proof");
  snapshotMode = null; assert.equal((await adapter.inspect(String(started.execution_id))).status, "running");
  receipt.private.selected_config.modeId = "safe"; await writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal((await adapter.inspect(String(started.execution_id))).status, "uncertain", "tampered selected settings fail reconnect validation");
  assert.equal(workspaceCreates, 1); assert.equal(agentCreates, 1); assert.equal(sends, 1);
});

test("Paseo mode catalogs require exact agreement between omission and advertised modes", async () => {
  let workspaceCreates = 0, agentLists = 0;
  const api = (modes: Array<{ id: string }>, provider = "pi") => ({ providers: { async listAvailable() { return { providers: [{ provider: "pi", available: true }] }; }, async listModels() { return { provider: "pi", models: [{ id: "fixture" }] }; }, async listModes() { return { provider, modes }; }, async listFeatures() { return { provider: "pi", features: [] }; } }, workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; throw new Error("must not create"); }, ref() { throw new Error("unused"); } }, agents: { async list() { agentLists += 1; return { entries: [] }; }, ref() { throw new Error("unused"); } } });
  const base = { hostId: "host-mode-catalog", repositoryPath: process.cwd(), repositoryCommonDir: commonDir, baseRef: "main", baseSha: currentSha, provider: "pi", model: "fixture", featureValues: {}, options: {}, branchName: () => "main", prompt: JSON.stringify };
  const cases = [
    ["omitted-nonempty", [{ id: "safe" }], undefined, "pi", /requires one advertised mode selection/],
    ["selected-empty", [], "safe", "pi", /advertises no modes/],
    ["empty-id", [{ id: "" }], undefined, "pi", /did not return the expected pi catalog/],
    ["null-entry", [null] as unknown as Array<{ id: string }>, undefined, "pi", /did not return the expected pi catalog/],
    ["duplicate", [{ id: "safe" }, { id: "safe" }], "safe", "pi", /did not return the expected pi catalog/],
    ["provider-mismatch", [], undefined, "codex", /did not return the expected pi catalog/],
  ] as const;
  for (const [name, modes, modeId, discoveredProvider, error] of cases) {
    const stateDir = await adapterState(`paseo-mode-catalog-${name}`);
    const adapter = new PaseoExecutorAdapter({ paseo: api([...modes], discoveredProvider), stateDir, role: "agent", repositoryRepo: "kasparsj/codex-toolkit", ...base, ...(modeId === undefined ? {} : { modeId }) });
    const result = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: `delivery-${name}`, task_id: `task_mode_${name.replace(/-/g, "_")}` });
    assert.equal(result.status, "failed", name); assert.equal(result.effect, "none", name); assert.match(String(result.error), error, name);
  }
  assert.equal(workspaceCreates, 0); assert.equal(agentLists, 0);
});

test("Paseo Codex collection removes only one documented leading assistant display boundary", async () => {
  const boundary = "\n\n---\n\n", valid = JSON.stringify({ schema_version: 1, result: { ok: true } });
  const accepted = await collectPaseoText("single_boundary", `${boundary}${valid}`);
  assert.equal(accepted.collected.status, "completed");
  assert.deepEqual(accepted.collected.result, { schema_version: 1, result: { ok: true } });
  const expected = { repo: "github.com/kasparsj/codex-toolkit", delivery_id: String(accepted.packet.delivery_id), role: "agent" as const, task_id: String(accepted.packet.task_id), packet_digest: digest(accepted.packet), execution_id: String(accepted.started.execution_id) };
  assert.equal((await accepted.adapter.resolveOutcomeProof(accepted.collected as never, expected)).trusted, true);
  assert.equal((await accepted.adapter.resolveOutcomeProof(accepted.collected as never, { ...expected, repo: "github.com/other/repo" })).trusted, false);
  assert.equal((await accepted.adapter.resolveOutcomeProof(accepted.collected as never, { ...expected, execution_id: "paseo:v1:ar_00000000000000000000000000000000" })).trusted, false);

  const rejected = [
    ["repeated", `${boundary}${boundary}${valid}`, "codex"],
    ["commentary", `Working on it.${boundary}${valid}`, "codex"],
    ["multiple", `${boundary}${valid}\n${valid}`, "codex"],
    ["prose", `${boundary}Result follows: ${valid}`, "codex"],
    ["empty", boundary, "codex"],
    ["fence", `${boundary}\`\`\`json\n${valid}\n\`\`\``, "codex"],
    ["stale", `${boundary}${JSON.stringify({ schema_version: 1, result: { stale: true } })}${boundary}${valid}`, "codex"],
    ["non_codex", `${boundary}${valid}`, "claude"],
  ] as const;
  for (const [name, text, provider] of rejected) {
    const result = await collectPaseoText(name, text, provider);
    assert.equal(result.collected.status, "failed", name);
    assert.equal(result.collected.effect, "accepted", name);
    assert.equal(result.collected.terminal, "failed", name);
    assert.equal(result.collected.result, undefined, name);
  }
});

test("Paseo adapter refuses unavailable settings instead of guessing", async () => {
  const paseo = { providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: false, error: "missing" }] }; }, async listModels() { return {}; } }, workspaces: { async list() { return { entries: [] }; }, async create() { throw new Error("must not create"); }, ref() { throw new Error("unused"); } }, agents: { async list() { return { entries: [] }; }, ref() { throw new Error("unused"); } } };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "h", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "x", branchName: () => "x", prompt: () => "x", ...await paseoOptions("refuse") });
  const refused = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: "task_12345678" });
  assert.equal(refused.status, "failed"); assert.equal(refused.effect, "none"); assert.match(String(refused.error), /unavailable: missing/);
});

test("Paseo adapter refuses unsupported mode, feature, discovery errors, and native options before create or prompt", async () => {
  let workspaceCreates = 0, agentCreates = 0, prompts = 0;
  const baseProviders = { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } };
  const api = (providers: typeof baseProviders) => ({ providers, workspaces: { async list() { return { entries: [] }; }, async create() { workspaceCreates += 1; throw new Error("must not create"); }, ref() { throw new Error("must not reference workspace"); } }, agents: { async list() { agentCreates += 1; return { entries: [] }; }, ref() { prompts += 1; throw new Error("must not reference agent"); } } });
  const cases = [
    ["mode", { ...baseProviders, async listModes() { return { provider: "codex", modes: [{ id: "full-access" }] }; } }, /mode auto is not supported/],
    ["feature", { ...baseProviders, async listFeatures() { return { provider: "codex", features: [] }; } }, /feature plan_mode is not supported/],
    ["feature-value", { ...baseProviders, async listFeatures() { return { provider: "codex", features: [{ type: "toggle" as const, id: "plan_mode", value: true }] }; } }, /did not resolve/],
    ["mode-error", { ...baseProviders, async listModes() { return { provider: "codex", error: "mode unavailable" }; } }, /mode discovery failed: mode unavailable/],
    ["mode-empty-error", { ...baseProviders, async listModes() { return { provider: "codex", modes: [{ id: "auto" }], error: "" }; } }, /mode discovery failed/],
    ["feature-error", { ...baseProviders, async listFeatures() { return { provider: "codex", error: "feature unavailable" }; } }, /feature discovery failed: feature unavailable/],
    ["feature-malformed", { ...baseProviders, async listFeatures() { return { provider: "codex", features: [{ type: "toggle" as const, id: "", value: false }] }; } }, /feature discovery did not return the expected codex catalog/],
  ] as const;
  for (const [name, providers, error] of cases) {
    const adapter = new PaseoExecutorAdapter({ paseo: api(providers as typeof baseProviders), hostId: `host-${name}`, repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...await paseoOptions(`settings-${name}`) });
    const refused = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: `delivery-${name}`, task_id: `task_settings_${name.replace(/-/g, "_")}` });
    assert.equal(refused.status, "failed", name); assert.equal(refused.effect, "none", name); assert.match(String(refused.error), error, name);
  }
  const invalidState = await paseoOptions("settings-native-options");
  assert.throws(() => new PaseoExecutorAdapter({ paseo: api(baseProviders), hostId: "host-native-options", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...invalidState, options: { ...codexSettings.options, approval_policy: "never" } }), /requires the selected on-request workspace-write policy/);
  assert.equal(workspaceCreates, 0); assert.equal(agentCreates, 0); assert.equal(prompts, 0);
});

test("Paseo adapter refuses a matching label without exact deterministic identity", async () => {
  let created = false;
  const paseo = {
    providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } },
    workspaces: { async list() { return { entries: [] }; }, async create() { created = true; throw new Error("duplicate"); }, ref() { throw new Error("unused"); } },
    agents: { async list() { return { entries: [{ agent: { id: "agent-existing", workspaceId: "workspace-existing", labels: { "codex-toolkit.task-id": "task_abcdefgh" } } }] }; }, ref() { throw new Error("unused"); } },
  };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "host-1", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "delivery/test", prompt: () => "test", ...await paseoOptions("reconcile") });
  const result = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: "task_abcdefgh" });
  assert.equal(result.status, "uncertain"); assert.match(String(result.error), /deterministic identity/); assert.equal(created, false);
});

test("Paseo unknown deterministic identity adoption and duplicate matches fail closed", async () => {
  const taskId = "task_exact_1234", agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`), labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": "d1", "codex-toolkit.role": "agent" };
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId: "workspace-exact", provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; }, async send() { throw new Error("must not prompt"); }, async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() {} };
  const workspace = { id: "workspace-exact", directory: process.cwd(), agents: { async create() { throw new Error("must not create"); } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  let createCalls = 0;
  const paseo = { providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } }, workspaces: { async list() { return { entries: [] }; }, async create() { createCalls += 1; throw new Error("must not create"); }, ref(id: string) { assert.equal(id, workspace.id); return workspace; } }, agents: { async list() { return { entries: [{ agent: { id: agentId, workspaceId: workspace.id, labels } }] }; }, ref(id: string) { assert.equal(id, agentId); return agent; } } };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "host", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...await paseoOptions("exact") });
  const result = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: taskId });
  assert.equal(result.status, "uncertain"); assert.match(String(result.error), /owned creation provenance/); assert.equal(createCalls, 0);

  const duplicatePaseo = { ...paseo, agents: { ...paseo.agents, async list() { return { entries: [{ agent: { id: agentId, workspaceId: workspace.id, labels } }, { agent: { id: `${agentId}-duplicate`, workspaceId: workspace.id, labels } }] }; } } };
  const duplicate = new PaseoExecutorAdapter({ paseo: duplicatePaseo, hostId: "host", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...await paseoOptions("duplicate") });
  const refused = await duplicate.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: taskId });
  assert.equal(refused.status, "uncertain"); assert.match(String(refused.error), /multiple Paseo agents/); assert.equal(createCalls, 0);
});

test("Paseo wait timeout is nonterminal and exact legacy-owned Codex cancellation remains available", async () => {
  const taskId = "task_timeout_123", agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`), labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": "d1", "codex-toolkit.role": "agent" }; let archived = 0;
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId: "workspace-timeout", provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; }, async send() {}, async waitForFinish() { return { status: "timeout" as const, error: "observer deadline", lastMessage: null }; }, async reload() {}, async archive() { archived += 1; } };
  const workspace = { id: "workspace-timeout", directory: process.cwd(), agents: { async create() { return agent; } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  const paseo = { providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } }, workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } }, agents: { async list() { return { entries: [] }; }, ref() { return agent; } } };
  const protectedOptions = await paseoOptions("timeout");
  const adapterOptions = { paseo, hostId: "host", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...protectedOptions };
  const adapter = new PaseoExecutorAdapter(adapterOptions);
  const started = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: taskId });
  const timeout = await adapter.collect(String(started.execution_id)); assert.equal(timeout.status, "timeout"); assert.equal(timeout.terminal, "nonterminal");
  const receiptName = (await readdir(protectedOptions.stateDir)).find((name) => /^ar_[0-9a-f]{32}\.json$/.test(name)); assert.ok(receiptName);
  const receiptPath = join(protectedOptions.stateDir, receiptName), legacy = JSON.parse(await readFile(receiptPath, "utf8"));
  for (const key of ["selected_config", "selected_config_digest", "agent_create_request", "agent_create_request_digest", "profile_fingerprint", "adoption_context_digest"]) delete legacy.private[key];
  await writeFile(receiptPath, JSON.stringify(legacy));
  const legacyController = new PaseoExecutorAdapter(adapterOptions);
  assert.equal((await legacyController.inspect(String(started.execution_id))).status, "uncertain", "legacy provenance cannot authorize observation or result acceptance");
  const cancelled = await legacyController.cancel(String(started.execution_id)); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.terminal, "cancelled"); assert.equal(archived, 1);
  const resolution = await adapter.resolveOutcomeProof(cancelled as never, { repo: "github.com/kasparsj/codex-toolkit", delivery_id: "d1", role: "agent", task_id: taskId, packet_digest: digest({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: taskId }), execution_id: String(started.execution_id) });
  assert.equal(resolution.trusted, true);
});

test("Paseo lost archive acknowledgement remains nonterminal uncertainty", async () => {
  const taskId = "task_archive_lost", agentId = executorInternals.stableUuid(`agent:github.com/kasparsj/codex-toolkit:${taskId}`), labels = { "codex-toolkit.task-id": taskId, "codex-toolkit.repo": "github.com/kasparsj/codex-toolkit", "codex-toolkit.delivery": "d1", "codex-toolkit.role": "agent" };
  const agent = { id: agentId, status: "running", pendingPermissions: null, lastError: null, async refresh() {}, current() { return { workspaceId: "workspace-lost", provider: "codex", model: "gpt-5.6", cwd: process.cwd(), labels, ...paseoSnapshot }; }, async send() {}, async waitForFinish() { throw new Error("unused"); }, async reload() {}, async archive() { throw new Error("connection lost"); } };
  const workspace = { id: "workspace-lost", directory: process.cwd(), agents: { async create() { return agent; } }, async refresh() {}, current() { return { workspaceDirectory: process.cwd() }; }, async archive() {} };
  const paseo = { providers: { ...paseoDiscovery(), async listAvailable() { return { providers: [{ provider: "codex", available: true }] }; }, async listModels() { return { provider: "codex", models: [{ id: "gpt-5.6" }] }; } }, workspaces: { async list() { return { entries: [] }; }, async create() { return workspace; }, ref() { return workspace; } }, agents: { async list() { return { entries: [] }; }, ref() { return agent; } } };
  const adapter = new PaseoExecutorAdapter({ paseo, hostId: "host", repositoryPath: process.cwd(), baseRef: "main", baseSha: currentSha, provider: "codex", model: "gpt-5.6", branchName: () => "main", prompt: JSON.stringify, ...await paseoOptions("archive-lost") });
  const started = await adapter.dispatch({ repo: "kasparsj/codex-toolkit", delivery_id: "d1", task_id: taskId }), result = await adapter.cancel(String(started.execution_id));
  assert.equal(result.status, "uncertain"); assert.equal(result.terminal, "nonterminal"); assert.match(String(result.error), /acknowledgement was lost/);
});

test("Pi RPC waits past receipt and agent_end for agent_settled", async () => {
  const rpc = await fakePi("settled");
  const started = await rpc.dispatch(piPacket());
  assert.equal(started.accepted, "started");
  assert.equal((await rpc.inspect(String(started.execution_id))).status, "running", "agent_end is not settlement");
  const completed = await rpc.collect(String(started.execution_id));
  assert.equal(completed.status, "completed");
  assert.equal((completed.result as Record<string, unknown>).schema_version, 1);
});

test("Pi handled receipt terminates immediately with unknown extension effects", async () => {
  const rpc = await fakePi("handled");
  const started = await rpc.dispatch(piPacket({ handled: true }));
  assert.equal(started.status, "failed"); assert.equal(started.effect, "unknown"); assert.equal(started.terminal, "failed");
  assert.equal((await rpc.inspect(String(started.execution_id))).status, "failed");
  assert.equal((await rpc.collect(String(started.execution_id))).status, "failed");
});

test("Pi refuses a provider-returned intermediate session symlink before prompting", async () => {
  const fixture = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
  const root = await mkdtemp(join(tmpdir(), "delivery-pi-session-intermediate-symlink-"));
  const wrapper = join(root, "pi"), prompts = join(root, "prompts");
  await writeFile(wrapper, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi
previous=""
session_dir=""
for argument in "$@"; do
  if [ "$previous" = "--session-dir" ]; then session_dir="$argument"; break; fi
  previous="$argument"
done
mkdir -p "$session_dir/actual"
: > "$session_dir/actual/session.jsonl"
chmod 600 "$session_dir/actual/session.jsonl"
ln -s actual "$session_dir/alias"
FAKE_PI_SESSION_FILE="$session_dir/alias/session.jsonl" exec "${node}" "${fixture}" "$@"
`, { mode: 0o700 });
  const adapter = new PiRpcExecutorAdapter({ executable: wrapper, cwd: root, timeoutMs: 2_000, stateDir: join(root, "receipts"), sessionOwnersDir: join(root, "owners"), sessionDir: join(root, "sessions"), role: "agent", environment: { FAKE_PI_PROMPT_MARKER: prompts } });
  const result = await adapter.dispatch(piPacket({ scenario: "hold" }));
  try {
    assert.equal(result.status, "failed");
    assert.equal(result.effect, "none");
    assert.match(String(result.error), /session.*symlink|unsafe.*session/i);
    await assert.rejects(readFile(prompts, "utf8"), /ENOENT/);
  } finally { if (result.status === "running") await adapter.cancel(String(result.execution_id)); }
});

test("Pi refuses provider replacement of the reserved session scope before prompting", async () => {
  const fixture = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
  for (const attack of ["scope-symlink", "same-path-replacement-directory"] as const) {
    const root = await mkdtemp(join(tmpdir(), `delivery-pi-reserved-scope-${attack}-`));
    const wrapper = join(root, "pi"), prompts = join(root, "prompts");
    await writeFile(wrapper, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi
previous=""
session_dir=""
for argument in "$@"; do
  if [ "$previous" = "--session-dir" ]; then session_dir="$argument"; break; fi
  previous="$argument"
done
moved="$session_dir-moved"
mv "$session_dir" "$moved"
${attack === "scope-symlink" ? 'ln -s "$(basename "$moved")" "$session_dir"' : 'mkdir "$session_dir" && chmod 700 "$session_dir"'}
exec "${node}" "${fixture}" "$@"
`, { mode: 0o700 });
    const adapter = new PiRpcExecutorAdapter({ executable: wrapper, cwd: root, timeoutMs: 2_000, stateDir: join(root, "receipts"), sessionOwnersDir: join(root, "owners"), sessionDir: join(root, "sessions"), role: "agent", environment: { FAKE_PI_PROMPT_MARKER: prompts } });
    const result = await adapter.dispatch(piPacket({ scenario: "hold" }));
    try {
      assert.equal(result.status, "failed", attack);
      assert.equal(result.effect, "none", attack);
      assert.match(String(result.error), /symbolic link|identity changed|unsafe state path/i, attack);
      await assert.rejects(readFile(prompts, "utf8"), /ENOENT/, attack);
    } finally { if (result.status === "running") await adapter.cancel(String(result.execution_id)); }
  }
});

test("Pi accepts a canonical provider session beneath a configured OS root alias and resumes its required evidence", { skip: realpathSync("/tmp") === "/tmp" }, async () => {
  const fixture = new URL("./fixtures/fake-pi.mjs", import.meta.url).pathname;
  const root = await mkdtemp("/tmp/delivery-pi-session-root-alias-");
  const wrapper = join(root, "pi");
  await writeFile(wrapper, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.5.2; exit 0; fi
previous=""
session_dir=""
session_file=""
for argument in "$@"; do
  if [ "$previous" = "--session-dir" ]; then session_dir="$argument"; break; fi
  if [ "$previous" = "--session" ]; then session_file="$argument"; break; fi
  previous="$argument"
done
if [ -n "$session_dir" ]; then
  canonical_dir=$(cd "$session_dir" && pwd -P)
  session_file="$canonical_dir/session.jsonl"
  if [ ! -e "$session_file" ]; then : > "$session_file"; chmod 600 "$session_file"; fi
fi
FAKE_PI_SESSION_FILE="$session_file" exec "${node}" "${fixture}" "$@"
`, { mode: 0o700 });
  const options = { executable: wrapper, cwd: root, timeoutMs: 2_000, stateDir: join(root, "receipts"), sessionOwnersDir: join(root, "owners"), sessionDir: join(root, "sessions"), role: "agent" as const };
  const adapter = new PiRpcExecutorAdapter(options);
  const first = await adapter.dispatch(piPacket({ scenario: "hold" }));
  assert.equal(first.status, "running");
  const receiptName = (await readdir(options.stateDir)).find((name) => /^ar_[0-9a-f]{32}\.json$/.test(name));
  assert.ok(receiptName);
  const receipt = JSON.parse(await readFile(join(options.stateDir, receiptName), "utf8"));
  const sessionFile = String(receipt.private?.session_file);
  assert.match(sessionFile, /^\/private\/tmp\//);
  assert.equal((await adapter.cancel(String(first.execution_id))).status, "cancelled");
  const resumeAdapter = new PiRpcExecutorAdapter(options);
  const resumed = await resumeAdapter.resume(sessionFile, piPacket({ scenario: "ordinary" }));
  try {
    assert.equal(resumed.status, "running");
    assert.equal((await resumeAdapter.collect(String(resumed.execution_id))).status, "completed");
  } finally { if (resumed.status === "running") await resumeAdapter.cancel(String(resumed.execution_id)); }
});

test("Pi terminal errors reject partial JSON while a later successful retry may complete", async () => {
  const terminal = await fakePi("terminal-error"), terminalStarted = await terminal.dispatch(piPacket({ scenario: "terminal-error" })), terminalResult = await terminal.collect(String(terminalStarted.execution_id));
  assert.equal(terminalResult.status, "failed"); assert.match(String(terminalResult.error), /synthetic attempt failed/); assert.equal(terminalResult.result, undefined);

  const truncated = await fakePi("terminal-length"), truncatedStarted = await truncated.dispatch(piPacket({ scenario: "terminal-length" })), truncatedResult = await truncated.collect(String(truncatedStarted.execution_id));
  assert.equal(truncatedResult.status, "failed"); assert.match(String(truncatedResult.error), /stopped with length/); assert.equal(truncatedResult.result, undefined);

  const failedRetry = await fakePi("retry-failure"), failedStarted = await failedRetry.dispatch(piPacket({ scenario: "retry-failure" })); assert.equal((await failedRetry.inspect(String(failedStarted.execution_id))).status, "running"); const failedResult = await failedRetry.collect(String(failedStarted.execution_id));
  assert.equal(failedResult.status, "failed"); assert.match(String(failedResult.error), /synthetic retries exhausted/); assert.equal(failedResult.result, undefined);

  const successfulRetry = await fakePi("retry-success"), successfulStarted = await successfulRetry.dispatch(piPacket({ scenario: "retry-success" })), successfulResult = await successfulRetry.collect(String(successfulStarted.execution_id));
  assert.equal(successfulResult.status, "completed"); assert.equal((successfulResult.result as Record<string, unknown>).schema_version, 1);

  const abortRoot = await mkdtemp(join(tmpdir(), "delivery-pi-abort-barrier-")), abortReady = join(abortRoot, "ready");
  const aborted = await fakePi("abort-error", { FAKE_PI_ABORT_READY: abortReady }), abortedStarted = await aborted.dispatch(piPacket({ scenario: "abort-error" }));
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    try { ready = (await readFile(abortReady, "utf8")).includes("ready"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!ready) await new Promise((accept) => setTimeout(accept, 5));
  }
  assert.equal(ready, true, "fake Pi acknowledged the explicit abort-before-settlement barrier");
  assert.equal((await aborted.cancel(String(abortedStarted.execution_id))).status, "cancelled");
});

test("Pi persisted terminal receipt reattaches without a new RPC runtime", async () => {
  const first = await fakePi("reattach"), options = first.options;
  const started = await first.dispatch(piPacket());
  assert.match(String(started.execution_id), /^pi:/); await new Promise((resolve) => setTimeout(resolve, 60));
  await first.collect(String(started.execution_id));
  const second = new PiRpcExecutorAdapter(options);
  assert.equal((await second.inspect(String(started.execution_id))).status, "completed");
  assert.equal((await second.collect(String(started.execution_id))).status, "completed");
});

test("Pi buffers settlement that arrives before prompt acknowledgement", async () => {
  const rpc = await fakePi("early-settle"), packet = piPacket({ scenario: "early-settle" });
  const result = await rpc.dispatch(packet);
  assert.equal(result.status, "completed"); assert.equal(result.effect, "accepted"); assert.equal(result.terminal, "completed");
  assert.equal((await rpc.inspect(String(result.execution_id))).status, "completed");
});

test("Pi prompt rejection records unknown hook effects and does not relaunch", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "delivery-pi-marker-")), marker = join(markerDir, "prompts");
  const rpc = await fakePi("reject", { FAKE_PI_PROMPT_MARKER: marker }), packet = piPacket({ scenario: "reject" });
  const result = await rpc.dispatch(packet);
  assert.equal(result.status, "failed"); assert.equal(result.effect, "unknown"); assert.equal(result.terminal, "failed");
  assert.equal((await readFile(marker, "utf8")).trim(), "prompt");
  assert.equal((await rpc.inspect(String(result.execution_id))).status, "failed");
  const repeated = await rpc.dispatch(packet); assert.equal(repeated.status, "failed"); assert.equal(repeated.execution_id, result.execution_id);
  assert.equal((await readFile(marker, "utf8")).trim(), "prompt", "inspection must not submit another prompt");
});

test("Pi unavailable model is a proven preflight refusal and never sends a prompt", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "delivery-pi-model-marker-")), marker = join(markerDir, "prompts");
  const base = await fakePi("model-refusal", { FAKE_PI_MODELS_EMPTY: "1", FAKE_PI_PROMPT_MARKER: marker });
  const rpc = new PiRpcExecutorAdapter({ ...base.options, provider: "openai", model: "missing" });
  const result = await rpc.dispatch(piPacket());
  assert.equal(result.status, "failed"); assert.equal(result.effect, "none"); assert.equal((result.proof as Record<string, unknown>).kind, "preflight_refusal");
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
});

test("Pi shared canonical-session owner excludes another role and detached inspection never spawns", async () => {
  const first = await fakePi("shared-owner"), reviewer = new PiRpcExecutorAdapter({ ...first.options, role: "reviewer", stateDir: join(dirname(first.options.stateDir), "reviewer-receipts") });
  const packet = piPacket(), started = await first.dispatch(packet);
  const receiptName = (await readdir(first.options.stateDir)).find((name) => /^ar_[0-9a-f]{32}\.json$/.test(name)); assert.ok(receiptName);
  const receipt = JSON.parse(await readFile(join(first.options.stateDir, receiptName), "utf8")); assert.equal(typeof receipt.private?.session_file, "string");
  const refused = await reviewer.resume(receipt.private.session_file, { ...packet, task_id: `${packet.task_id}_review`, kind: "review" });
  assert.equal(refused.status, "failed"); assert.equal(refused.effect, "none");
  await first.collect(String(started.execution_id));
  const detached = new PiRpcExecutorAdapter(first.options);
  assert.equal((await detached.inspect(String(started.execution_id))).status, "completed", "fresh adapter reads the exact terminal receipt without launching Pi");
});

test("Pi proof resolver binds exact packet and role while legacy identity stays uncertain", async () => {
  const rpc = await fakePi("proof"), packet = piPacket(), started = await rpc.dispatch(packet), completed = await rpc.collect(String(started.execution_id));
  const expected = { repo: `github.com/${String(packet.repo)}`, delivery_id: String(packet.delivery_id), role: "agent" as const, task_id: String(packet.task_id), packet_digest: digest(packet), execution_id: String(started.execution_id) };
  assert.equal((await rpc.resolveOutcomeProof(completed as never, expected)).trusted, true);
  assert.equal((await rpc.resolveOutcomeProof(completed as never, { ...expected, role: "reviewer" })).trusted, false);
  assert.equal((await rpc.inspect("pi:legacy-session-path")).status, "uncertain");
});
