#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeliveryError, digest, requireCondition } from "./core.ts";
import { DeliveryEngine, repositoryCommandInputDigest, type ControlAction } from "./engine.ts";
import { createRunExport, inspectRunExport, writeRunExport } from "./export.ts";
import { loadPolicy } from "./policy.ts";
import { dashboardProjection, safeProjection } from "./projection.ts";
import { ProposalSpool } from "./proposals.ts";
import { hashPackage, skillHashes } from "./pins.ts";
import { FileStateStore } from "./store.ts";
import { Publisher, type PublisherConfig } from "./publisher.ts";
import { defaultProfilePath, inferRepository, loadBoundProfile, loadLocalProfile, profileResources, type ConfiguredRepositorySource, type ExecutorProfile } from "./config.ts";
import { ExecutableJsonAdapter, PaseoExecutorAdapter, PiRpcExecutorAdapter } from "./executors.ts";
import { FOREGROUND_POLL_MS, ForegroundSupervisor, loadForegroundPolicy } from "./foreground.ts";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import type { ExecutorPort, TrustedCheckerPort } from "./ports.ts";
import type { DeliveryState, JsonObject, ReviewStage } from "./types.ts";
import { processIdentity, processOwnershipLost, repositoryScopeDigest, RepositoryRegistry, resolveRepository, workspaceSetup, type CommandReservationInput, type RunnerSession } from "./repository.ts";
import { acceptedReviewerWaitIdentity, assertWorkerOwnership, controlRunner, deliveryRequiresDrain, finishRunnerTransition, requestOwnedRunnerStop, reserveRunnerTransition, type AcceptedReviewerWaitIdentity, type RunnerAction } from "./runner.ts";
import { beginCoordinatedCancellation, reconcileCoordinatedCancellation } from "./cancellation-coordinator.ts";

type Args = { command: string; options: Map<string, string | boolean>; positionals: string[] };
function parse(argv: string[]): Args {
  requireCondition(argv.length > 0, "command required", "INVALID_ARGUMENT");
  let command = argv.shift()!;
  if (command === "draft") { const child = argv.shift(); requireCondition(["issue", "publish", "list", "show", "retry", "remove"].includes(child ?? ""), "draft command must be issue, publish, list, show, retry, or remove", "INVALID_ARGUMENT"); command = `draft-${child}`; }
  const options = new Map<string, string | boolean>(); const positionals: string[] = [];
  while (argv.length) {
    const item = argv.shift()!;
    if (!item.startsWith("--")) { positionals.push(item); continue; }
    const key = item.slice(2); requireCondition(key.length > 0 && !options.has(key), `invalid or duplicate option --${key}`, "INVALID_ARGUMENT");
    if (["no-dispatch", "defer-actions-verification"].includes(key)) options.set(key, true);
    else { const value = argv.shift(); requireCondition(value !== undefined && !value.startsWith("--"), `option --${key} requires a value`, "INVALID_ARGUMENT"); options.set(key, value); }
  }
  return { command, options, positionals };
}
function string(args: Args, key: string, required = true): string | undefined { const value = args.options.get(key); if (required) requireCondition(typeof value === "string", `--${key} is required`, "INVALID_ARGUMENT"); return typeof value === "string" ? value : undefined; }
function integer(args: Args, key: string, required = false): number | undefined { const value = string(args, key, required); if (value === undefined) return undefined; const result = Number(value); requireCondition(Number.isSafeInteger(result) && result > 0, `--${key} must be a positive integer`, "INVALID_ARGUMENT"); return result; }
function nonnegative(args: Args, key: string, required = false): number | undefined { const value = string(args, key, required); if (value === undefined) return undefined; const result = Number(value); requireCondition(Number.isSafeInteger(result) && result >= 0, `--${key} must be a nonnegative integer`, "INVALID_ARGUMENT"); return result; }
function allowed(args: Args, names: string[]): void { for (const key of args.options.keys()) requireCondition(key === "profile" || names.includes(key), `unknown option --${key}`, "INVALID_ARGUMENT"); }
function envelope(data: unknown): Record<string, unknown> { return { ok: true, data }; }
function cancellationInputDigest(repo: string, deliveryId: string, expectedRevision: number): string { return digest({ repo, delivery_id: deliveryId, expected_revision: expectedRevision, action: "cancel", draft_digest: null }); }
function proposalCommandIdentity(repo: string, action: "publish_issue" | "retry_issue", proposalId: string, proposalDigest: string): { requestId: string; inputDigest: string } {
  return { requestId: `${action === "publish_issue" ? "publish" : "retry"}_${digest({ proposal_id: proposalId, proposal_digest: proposalDigest }).slice(0, 24)}`, inputDigest: digest({ repo, action, proposal_id: proposalId, proposal_digest: proposalDigest }) };
}
function proposalOperationId(repo: string, proposalId: string, proposalDigest: string): string { return digest({ repo, id: proposalId, content_digest: proposalDigest }).slice(0, 24); }
export function foregroundStatusReporter(write: (line: string) => void = (line) => console.error(line), now: () => Date = () => new Date()): (status: string, state?: { repo: string; revision: number }, message?: string) => void {
  let previousIdentity: string | undefined;
  return (status, state, message) => {
    const identity = JSON.stringify({ status, revision: state?.revision ?? null, message: message ?? null });
    if (identity === previousIdentity) return;
    previousIdentity = identity;
    write(`${now().toISOString()} foreground ${state?.repo ?? "repository"} ${status}${state ? ` revision=${state.revision}` : ""}${message ? ` guidance=${JSON.stringify(message)}` : ""}`);
  };
}
export function reserveProposalCommand(registry: RepositoryRegistry, repo: string, input: CommandReservationInput): { session: RunnerSession; token: string; readbackOnly: boolean } {
  const session = registry.reserveCommand(repo, input), operation = session.operation; requireCondition(operation?.kind === "command", "proposal command reservation is missing", "RUNNER_BARRIER");
  return { session, token: operation.token, readbackOnly: session.desired_state === "paused" || session.status === "pausing" || session.status === "stopping" };
}
export function reserveWorkspaceCommand(registry: RepositoryRegistry, repo: string, input: CommandReservationInput): { session: RunnerSession; token: string; readbackOnly: boolean } {
  const session = registry.reserveCommand(repo, input), operation = session.operation; requireCondition(operation?.kind === "command", "workspace command reservation is missing", "RUNNER_BARRIER");
  return { session, token: operation.token, readbackOnly: session.desired_state !== "running" || session.status !== "running" };
}
async function stdinJson(): Promise<Record<string, unknown>> { let raw = ""; for await (const chunk of process.stdin) { raw += chunk; requireCondition(Buffer.byteLength(raw) <= 256 * 1024, "setup input exceeds 256 KiB", "INVALID_ARGUMENT"); } const value = JSON.parse(raw || "{}"); requireCondition(value && typeof value === "object" && !Array.isArray(value), "input must be one JSON object", "INVALID_ARGUMENT"); return value as Record<string, unknown>; }
function signalOwnedProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") { try { process.kill(-child.pid, signal); return; } catch { /* fall back to the exact child */ } }
  try { child.kill(signal); } catch { /* exact child already exited */ }
}
function runOwnedChecker(config: { argv: [string, ...string[]]; cwd: string }, packet: JsonObject): Promise<string> {
  const [executable, ...argv] = config.argv, limit = 1024 * 1024, timeoutMs = 15 * 60_000;
  return new Promise((accept, reject) => {
    const child = spawn(executable, argv, { cwd: config.cwd, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])) });
    let stdout = "", stdoutBytes = 0, stderrBytes = 0, failure: Error | undefined, timedOut = false, hardStop: NodeJS.Timeout | undefined;
    const stop = (error: Error): void => { if (failure) return; failure = error; signalOwnedProcessGroup(child, "SIGTERM"); hardStop = setTimeout(() => signalOwnedProcessGroup(child, "SIGKILL"), 1_000); hardStop.unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(new Error("checker timed out")); }, timeoutMs); timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; if (stdoutBytes > limit) stop(new Error("checker stdout exceeded 1048576 bytes")); else stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > limit) stop(new Error("checker stderr exceeded 1048576 bytes")); });
    child.stdin.once("error", (error) => { if (!failure) failure = error; });
    child.once("error", (error) => { clearTimeout(timer); if (hardStop) clearTimeout(hardStop); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer); if (hardStop) clearTimeout(hardStop);
      if (failure) return reject(failure);
      if (timedOut) return reject(new Error("checker timed out"));
      if (code !== 0) return reject(new Error(`checker exited unsuccessfully (${code ?? signal ?? "unknown"})`));
      accept(stdout);
    });
    child.stdin.end(`${JSON.stringify(packet)}\n`);
  });
}
class ExecutableChecker implements TrustedCheckerPort {
  private readonly config: { argv: [string, ...string[]]; cwd: string };
  constructor(config: { argv: [string, ...string[]]; cwd: string }) { this.config = config; }
  async verify(packet: JsonObject): Promise<JsonObject> {
    const output = await runOwnedChecker(this.config, packet);
    const value = JSON.parse(output.trim()) as unknown;
    requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "checker must return one JSON object");
    return value as JsonObject;
  }
}
function executorAdapter(profile: ExecutorProfile, stateDir: string, sessionOwnersDir: string, role: "agent" | "reviewer", configuredSource: ConfiguredRepositorySource | undefined, clients: PaseoClient[]): ExecutorPort {
  if (profile.kind === "pi") return new PiRpcExecutorAdapter({ executable: profile.executable, cwd: profile.cwd, stateDir, sessionOwnersDir, role, ...(profile.provider ? { provider: profile.provider } : {}), ...(profile.model ? { model: profile.model } : {}), ...(profile.session_dir ? { sessionDir: profile.session_dir } : {}) });
  if (profile.kind === "executable") return new ExecutableJsonAdapter({ argv: profile.argv, cwd: profile.cwd, stateDir });
  requireCondition(configuredSource, `${role} Paseo configured source pin is unavailable`);
  const paseo = createPaseoClient({ url: profile.url, reconnect: { enabled: true } }); clients.push(paseo);
  return new PaseoExecutorAdapter({ paseo: paseo as unknown as ConstructorParameters<typeof PaseoExecutorAdapter>[0]["paseo"], hostId: profile.host_id, stateDir, role, repositoryRepo: configuredSource.repo, repositoryPath: configuredSource.repository_path, repositoryCommonDir: configuredSource.common_dir, baseRef: profile.base_ref, baseSha: profile.base_sha, provider: profile.provider, model: profile.model, ...(profile.modeId === undefined ? {} : { modeId: profile.modeId }), featureValues: profile.featureValues, options: profile.options, ...(profile.toolPolicy ? { toolPolicy: profile.toolPolicy } : {}), branchName: (id) => `delivery/${id.slice(0, 12)}`, prompt: (packet) => JSON.stringify(packet) });
}
function profileRuntimeLocations(profilePath: string, profile: ReturnType<typeof loadLocalProfile>): Record<string, string> {
  const executable = profile.executor.kind === "executable" ? profile.executor.argv[0] : profile.executor.kind === "pi" ? profile.executor.executable : process.execPath;
  const reviewer = profile.reviewer ? profile.reviewer.kind === "executable" ? profile.reviewer.argv[0] : profile.reviewer.kind === "pi" ? profile.reviewer.executable : process.execPath : undefined;
  const argumentFiles: Record<string, string> = {};
  const commands = [
    ["executor", profile.executor.kind === "executable" ? profile.executor : undefined],
    ["checker", profile.checker],
    ["reviewer", profile.reviewer?.kind === "executable" ? profile.reviewer : undefined],
  ] as const;
  for (const [role, command] of commands) if (command) command.argv.slice(1).forEach((argument, index) => {
    if (argument.startsWith("-")) return;
    const path = resolve(command.cwd, argument);
    if (existsSync(path) && (lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) argumentFiles[`${role}_arg_${index + 1}`] = path;
  });
  return { profile: profilePath, policy: profile.policy.path, foreground_policy: profile.foreground_policy, publisher_config: profile.publisher_config, executor: executable, ...(profile.checker ? { checker: profile.checker.argv[0] } : {}), ...(reviewer ? { reviewer } : {}), runtime: process.execPath, ...argumentFiles };
}
function validateSetupProfile(profilePath: string, repo: string): void {
  const profile = loadLocalProfile(profilePath); requireCondition(profile.repository.toLowerCase() === repo, "profile repository does not match workspace");
  profileResources(profile, repo);
  loadPolicy(profile.policy.path, { expectedDigest: profile.policy.digest, sourceRef: profile.policy.ref, sourceSha: profile.policy.sha, fetchedAt: profile.policy.fetched_at });
  loadForegroundPolicy(profile.foreground_policy, repo); skillHashes(profile.skills_root);
  const store = new FileStateStore(profile.state_dir); new Publisher(store.readProtected(profile.publisher_config) as unknown as PublisherConfig);
  for (const [label, path] of Object.entries(profileRuntimeLocations(profilePath, profile))) requireCondition(existsSync(path), `profile ${label} dependency is unavailable`);
}
async function configuredEngine(store: FileStateStore, args: Args, repo: string | undefined, grant: string | undefined, profile?: ReturnType<typeof loadLocalProfile>, connectExternal = true): Promise<{ engine: DeliveryEngine; paseoClients: PaseoClient[]; executor?: ExecutorPort; reviewer?: ExecutorPort }> {
  const configPath = string(args, "publisher-config", false);
  if (profile && configPath) requireCondition(resolve(configPath) === profile.publisher_config, "--publisher-config cannot override the selected profile", "INVALID_ARGUMENT");
  const publisherPath = configPath ?? profile?.publisher_config;
  const publisher = publisherPath ? new Publisher(store.readProtected(publisherPath) as unknown as PublisherConfig) : undefined;
  const paseoClients: PaseoClient[] = [];
  const registry = new RepositoryRegistry(), resources = profile && repo ? profileResources(profile, repo) : undefined, sessionOwnersDir = registry.piSessionOwnersDir();
  const executor = profile ? executorAdapter(profile.executor, join(profile.state_dir, "executor-processes"), sessionOwnersDir, "agent", resources?.configured_sources.executor, paseoClients) : undefined;
  const reviewer = profile?.reviewer ? executorAdapter(profile.reviewer, join(profile.state_dir, "reviewer-processes"), sessionOwnersDir, "reviewer", resources?.configured_sources.reviewer, paseoClients) : undefined;
  const checker = profile?.checker ? new ExecutableChecker(profile.checker) : undefined;
  if (connectExternal) for (const client of paseoClients) await client.connect();
  const engineSrc = fileURLToPath(new URL("./", import.meta.url));
  const argumentLocations: Record<string, string> = Object.fromEntries(["skills-root", "agent-launcher", "worktree", "agent-scratch", "installation", "runtime"].flatMap((key) => { const value = string(args, key, false); return value ? [[key, resolve(value)]] : []; }));
  const runtimeLocations: Record<string, string> | undefined = profile ? { ...profileRuntimeLocations(string(args, "profile")!, profile), skills_root: profile.skills_root, engine_src: engineSrc } : Object.keys(argumentLocations).length ? { ...argumentLocations, engine_src: engineSrc } : undefined;
  const actions: ControlAction[] = ["pause", "resume", "cancel", "recover", "publish_plan", "publish_implementation", "correct", "recheck_ready", "retry_review", "export_handoff", "bind_manual_pr"];
  return { engine: new DeliveryEngine({ store, ...(publisher ? { publisher } : {}), ...(executor ? { executor } : {}), ...(checker ? { checker } : {}), ...(reviewer ? { reviewer } : {}), ...(runtimeLocations ? { runtimeLocations } : {}), ...(grant && repo ? { controlGrant: { token: grant, repositories: [repo], actions } } : {}) }), paseoClients, ...(executor ? { executor } : {}), ...(reviewer ? { reviewer } : {}) };
}

const WORKSPACE_ACTIONS: ControlAction[] = ["pause", "resume", "cancel", "recover", "publish_plan", "publish_implementation", "correct", "recheck_ready", "retry_review"];

function workspaceSnapshot(directory: string, registry = new RepositoryRegistry()): Record<string, unknown> {
  const identity = resolveRepository(directory), setup = workspaceSetup(identity, registry), session = registry.readSession(identity.repo), observation = registry.observe(session);
  const binding = registry.readBinding(identity.repo); let runs: unknown[] = [], warnings: string[] = [], retainedDeliveryId: string | undefined, retainedDeliveryBlocked = false;
  let operatorActions: ControlAction[] = [];
  if (binding && setup.configured) {
    const scan = new FileStateStore(binding.state_dir).scan(identity.repo);
    runs = scan.states.flatMap((state) => (dashboardProjection(state).runs as unknown[]));
    const retained = scan.states.find((state) => state.claim_status === "active"); retainedDeliveryId = retained?.delivery_id; retainedDeliveryBlocked = retained?.status === "blocked";
    if (scan.diagnostics.length) warnings = ["Some saved deliveries could not be read. Their files were preserved."];
    if (process.env.DELIVERY_OPERATOR_GRANT) {
      const profile = registry.validateBoundProfile(identity, binding).profile, foreground = loadForegroundPolicy(profile.foreground_policy, identity.repo);
      operatorActions = WORKSPACE_ACTIONS.filter((action) => !action.startsWith("publish_") || foreground.pr_publication === "explicit");
    }
  }
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), identity, scopeDigest: repositoryScopeDigest(identity, binding?.revision ?? 0), setup,
    runner: {
      revision: session.revision, status: observation.status === "running" && retainedDeliveryBlocked ? "blocked" : observation.status, desiredState: session.desired_state, observedState: observation.observedState,
      ...(session.reason ? { reason: session.reason } : {}), ...(session.heartbeat_at ? { heartbeatAt: session.heartbeat_at } : {}),
      ...(retainedDeliveryId ? { deliveryId: retainedDeliveryId } : {}), ...(session.generation ? { generation: session.generation } : {}),
    },
    runs, operatorActions, warnings,
  };
}

function assertWorkspaceScope(directory: string, expectedScope: string | undefined, registry: RepositoryRegistry): void {
  if (expectedScope === undefined) return;
  requireCondition(/^[0-9a-f]{64}$/.test(expectedScope), "--expected-scope must be a SHA-256 digest", "INVALID_ARGUMENT");
  const identity = resolveRepository(directory), binding = registry.readBinding(identity.repo), current = repositoryScopeDigest(identity, binding?.revision ?? 0);
  requireCondition(current === expectedScope, "workspace repository scope changed; refresh /delivery before retrying", "SCOPE_CHANGED");
}

function setupWorkspace(directory: string, expectedRevision: number, requestId: string, input: Record<string, unknown>, registry = new RepositoryRegistry()): Record<string, unknown> {
  const identity = resolveRepository(directory); let profilePath: string, configure: (() => void) | undefined;
  if (input.mode === "import") {
    requireCondition(typeof input.profilePath === "string" && resolve(input.profilePath) === input.profilePath && realpathSync(input.profilePath) === input.profilePath, "profilePath must be canonical, absolute, and symlink-free", "INVALID_ARGUMENT"); profilePath = input.profilePath; validateSetupProfile(profilePath, identity.repo);
  } else {
    requireCondition(input.mode === "create", "setup mode must be import or create", "INVALID_ARGUMENT");
    for (const key of ["policyPath", "skillsRoot", "publisherConfigPath", "executorConfigPath"] as const) requireCondition(typeof input[key] === "string" && resolve(input[key] as string) === input[key], `${key} must be canonical and absolute`, "INVALID_ARGUMENT");
    const provenance = input.policy as Record<string, unknown>;
    requireCondition(provenance && typeof provenance.ref === "string" && typeof provenance.sha === "string" && typeof provenance.digest === "string" && typeof provenance.fetched_at === "string", "policy provenance is required", "INVALID_ARGUMENT");
    requireCondition(Object.keys(provenance).every((key) => ["ref", "sha", "digest", "fetched_at"].includes(key)), "policy provenance has unsupported fields", "INVALID_ARGUMENT");
    const allowedPaths = input.allowedPaths as Record<string, unknown>;
    requireCondition(allowedPaths && typeof allowedPaths === "object" && !Array.isArray(allowedPaths) && Object.keys(allowedPaths).length === 2 && Object.keys(allowedPaths).every((key) => key === "plan" || key === "implementation"), "allowedPaths must contain plan and implementation path lists", "INVALID_ARGUMENT");
    for (const stage of ["plan", "implementation"] as const) requireCondition(Array.isArray(allowedPaths[stage]) && (allowedPaths[stage] as unknown[]).length > 0 && (allowedPaths[stage] as unknown[]).every((path) => typeof path === "string" && path.length > 0 && path !== "." && !path.startsWith("/") && !path.includes("\\") && !/[?*\[\]]/.test(path) && !path.split("/").some((part) => part === "" || part === "." || part === "..")), `allowedPaths.${stage} must contain only narrow repository-relative paths`, "INVALID_ARGUMENT");
    const protectedStore = new FileStateStore(registry.root), publisher = protectedStore.readProtected(input.publisherConfigPath as string), executor = protectedStore.readProtected(input.executorConfigPath as string);
    requireCondition(String(publisher.repo).toLowerCase() === identity.repo && Number.isInteger(publisher.repositoryId), "publisher config does not match repository", "INVALID_ARGUMENT");
    const checker = typeof input.checkerConfigPath === "string" ? protectedStore.readProtected(input.checkerConfigPath) : undefined;
    const reviewer = typeof input.reviewerConfigPath === "string" ? protectedStore.readProtected(input.reviewerConfigPath) : undefined;
    profilePath = registry.generatedProfilePath(identity.repo); const foregroundPath = registry.generatedForegroundPath(identity.repo);
    configure = () => {
      registry.writeConfiguration(foregroundPath, { schema_version: 1, repository: identity.repo, repository_id: publisher.repositoryId, auto_schedule: false, pr_publication: "off", issue_publication: "off", allowed_paths: { plan: [...new Set(allowedPaths.plan as string[])].sort(), implementation: [...new Set(allowedPaths.implementation as string[])].sort() } });
      registry.writeConfiguration(profilePath, {
        schema_version: 1, repository: identity.repo, state_dir: registry.generatedStateDir(identity.repo), skills_root: input.skillsRoot,
        policy: { path: input.policyPath, ref: provenance.ref, sha: provenance.sha, digest: provenance.digest, fetched_at: provenance.fetched_at }, foreground_policy: foregroundPath, publisher_config: input.publisherConfigPath, executor,
        ...(checker ? { checker } : {}), ...(reviewer ? { reviewer } : {}),
      });
      validateSetupProfile(profilePath, identity.repo);
    };
  }
  registry.bind(identity, profilePath, expectedRevision, requestId, configure); return workspaceSnapshot(directory, registry);
}

async function runRepositoryWorker(directory: string, generation: number, token: string): Promise<void> {
  const identity = resolveRepository(directory), registry = new RepositoryRegistry(), binding = registry.readBinding(identity.repo);
  requireCondition(binding, "repository setup is incomplete"); const profile = registry.admitProfile(identity, binding.profile_path, binding.state_dir).profile;
  let workerProcessIdentity: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) { try { workerProcessIdentity = assertWorkerOwnership(registry, identity.repo, generation, token).owner_process_identity; break; } catch (error) { if (attempt === 99) throw error; await new Promise((resolveWait) => setTimeout(resolveWait, 20)); } }
  requireCondition(workerProcessIdentity, "repository runner process identity is unavailable");
  const synthetic: Args = { command: "runner-worker", positionals: [], options: new Map([["profile", binding.profile_path]]) };
  const store = new FileStateStore(profile.state_dir), configured = await configuredEngine(store, synthetic, identity.repo, undefined, profile); const engine = configured.engine;
  const policy = loadPolicy(profile.policy.path, { expectedDigest: profile.policy.digest, sourceRef: profile.policy.ref, sourceSha: profile.policy.sha, fetchedAt: profile.policy.fetched_at });
  const foreground = loadForegroundPolicy(profile.foreground_policy, identity.repo); requireCondition(foreground.auto_schedule === false, "repository runner requires unattended scheduling off");
  const publisherConfig = store.readProtected(profile.publisher_config); const requestedPoll = Number(process.env.DELIVERY_RUNNER_POLL_MS ?? FOREGROUND_POLL_MS);
  requireCondition(Number.isInteger(requestedPoll) && requestedPoll >= 10 && requestedPoll <= FOREGROUND_POLL_MS, "invalid repository runner poll interval");
  requireCondition(requestedPoll === FOREGROUND_POLL_MS || publisherConfig.testOnly === true, "custom repository runner poll interval is test-only");
  const runtimeLocations = { ...profileRuntimeLocations(binding.profile_path, profile), skills_root: profile.skills_root, engine_src: fileURLToPath(new URL("./", import.meta.url)) };
  const ownerTokenDigest = digest(token), heartbeatIntervalMs = 10_000; let nextHeartbeatAt = 0, signalRequestRevision: number | undefined;
  const heartbeatIfDue = (force = false): RunnerSession | undefined => {
    if (!force && Date.now() < nextHeartbeatAt) return undefined;
    const session = registry.heartbeatWorker(identity.repo, generation, ownerTokenDigest); nextHeartbeatAt = Date.now() + heartbeatIntervalMs; return session;
  };
  const requestSignalStop = (): void => {
    try {
      const owned = registry.readSession(identity.repo);
      if (owned.cancellation || owned.desired_state === "stopped") return;
      signalRequestRevision ??= owned.revision;
      requestOwnedRunnerStop({ identity, generation, token, ownerProcessIdentity: workerProcessIdentity, requestRevision: signalRequestRevision, requestId: `runner_signal_stop_${generation}` }, registry);
    } catch { /* exact ownership and durable state remain authoritative; repeated signals never force termination */ }
  };
  process.on("SIGINT", requestSignalStop); process.on("SIGTERM", requestSignalStop);
  try {
    const initialScan = store.scan(identity.repo); requireCondition(initialScan.diagnostics.length === 0, "saved delivery state is unreadable; refusing to infer that no work is active"); let active = initialScan.states.find((state) => state.claim_status === "active");
    if (!active) {
      const session = assertWorkerOwnership(registry, identity.repo, generation, token);
      if (session.delivery_id) { active = store.read(identity.repo, session.delivery_id); requireCondition(active.claim_status === "active", "the exact delivery selected for Resume is no longer active; Start is required for new work"); }
      else active = engine.start({ repo: identity.repo, issue: session.issue ?? null, policy, skillHashes: skillHashes(profile.skills_root), engineHashes: { delivery_src: hashPackage(runtimeLocations.engine_src) }, pinLocations: runtimeLocations, safeguards: { publication: { pr: foreground.pr_publication, issue: foreground.issue_publication }, ...(foreground.allowed_paths ? { allowedPaths: foreground.allowed_paths } : {}) } });
      const current = registry.readSession(identity.repo); registry.mutateSession(identity.repo, current.revision, (value) => { value.delivery_id = active!.delivery_id; return value; });
    }
    const supervisor = new ForegroundSupervisor({ engine, repo: identity.repo, policy, policyConfig: foreground, pinLocations: runtimeLocations, skillHashes: skillHashes(profile.skills_root), engineHashes: { delivery_src: hashPackage(runtimeLocations.engine_src) }, propagateOperatorHold: true });
    registry.acknowledgeWorkerReady(identity.repo, generation, ownerTokenDigest, active.delivery_id);
    let watching = false, watched: Promise<void> | undefined, cancellationFailure: unknown;
    const watchCancellation = (): void => {
      if (watching) return;
      const session = registry.readSession(identity.repo), cancellation = session.cancellation;
      if (!cancellation || cancellation.epoch.startsWith("pending:")) return;
      watching = true;
      watched = (async () => {
        const context = { repo: identity.repo, delivery_id: cancellation.delivery_id, expected_revision: cancellation.expected_revision, request_id: cancellation.request_id, input_digest: cancellation.input_digest, repository_generation: cancellation.generation };
        const result = await engine.reconcileCancellation(context, { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) });
        registry.updateCancellationPhase(identity.repo, cancellation.token, result.status === "draining" || result.status === "complete" ? "draining" : "reconciling");
        cancellationFailure = undefined;
      })().catch((error) => {
        cancellationFailure = error;
        registry.recordWorkerDiagnostic(identity.repo, generation, ownerTokenDigest, workerProcessIdentity!, error);
      }).finally(() => { watching = false; });
    };
    const finalizeDrainedCancellation = (): boolean => {
      const cancellation = registry.readSession(identity.repo).cancellation; if (cancellation?.phase !== "draining") return false;
      registry.acknowledgeCancellationDrain(identity.repo, generation, digest(token), cancellation.token);
      const context = { repo: identity.repo, delivery_id: cancellation.delivery_id, expected_revision: cancellation.expected_revision, request_id: cancellation.request_id, input_digest: cancellation.input_digest, repository_generation: cancellation.generation }, claimGeneration = store.read(identity.repo, cancellation.delivery_id).claim_generation;
      registry.withCancellationFinalization({ repo: identity.repo, delivery_id: cancellation.delivery_id, request_id: cancellation.request_id, input_digest: cancellation.input_digest, epoch: cancellation.epoch, reservation_token: cancellation.token, generation, claim_generation: claimGeneration, owner_token_digest: digest(token) }, (fence) => engine.finalizeCancellation(context, fence));
      return true;
    };
    const settleReleasedClaim = (state: DeliveryState | undefined): boolean => {
      if (!state || state.claim_status !== "released") return false;
      registry.mutateSession(identity.repo, undefined, (value) => {
        requireCondition(value.generation === generation && value.owner_token_digest === digest(token) && value.owner_pid === process.pid && value.owner_process_identity === processIdentity(process.pid), "repository runner ownership changed");
        requireCondition(value.delivery_id === state.delivery_id, "released delivery ownership changed", "RUNNER_BARRIER");
        value.desired_state = "stopped"; value.status = "stopped"; value.owner_pid = null; delete value.owner_process_identity; delete value.delivery_id; value.issue = null; value.heartbeat_at = new Date().toISOString(); return value;
      });
      return true;
    };
    const waitForWake = async (delayMs: number): Promise<void> => {
      const deadline = Date.now() + delayMs;
      while (Date.now() < deadline) {
        watchCancellation(); if (watched) await watched;
        const session = heartbeatIfDue() ?? assertWorkerOwnership(registry, identity.repo, generation, token);
        if (session.desired_state !== "running" || session.cancellation) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(250, Math.max(1, deadline - Date.now()))));
      }
    };
    const pumpOwnedCancellation = async (reservation: string, deliveryId: string): Promise<boolean> => {
      for (;;) {
        const held = heartbeatIfDue() ?? registry.readSession(identity.repo), operation = held.operation, cancellation = held.cancellation;
        if (!cancellation) return false;
        requireCondition(held.generation === generation && held.owner_token_digest === ownerTokenDigest && held.owner_pid === process.pid && held.owner_process_identity === workerProcessIdentity
          && held.desired_state === "stopped" && !held.recovery && !held.in_flight && operation?.kind === "worker" && operation.token === reservation
          && operation.phase === "effect" && operation.generation === generation && operation.owner_token_digest === ownerTokenDigest && operation.owner_pid === process.pid
          && operation.owner_process_identity === workerProcessIdentity && operation.delivery_id === deliveryId && cancellation.delivery_id === deliveryId
          && cancellation.generation === generation && cancellation.owner_token_digest === ownerTokenDigest, "cancellation no longer belongs to the exact live worker", "RUNNER_BARRIER");
        if (cancellation.epoch.startsWith("pending:")) { await new Promise((resolveWait) => setTimeout(resolveWait, 25)); continue; }
        watchCancellation(); if (watched) await watched;
        const refreshed = registry.readSession(identity.repo), currentCancellation = refreshed.cancellation;
        requireCondition(currentCancellation?.token === cancellation.token && currentCancellation.epoch === cancellation.epoch && currentCancellation.request_id === cancellation.request_id
          && currentCancellation.input_digest === cancellation.input_digest && currentCancellation.expected_revision === cancellation.expected_revision
          && currentCancellation.generation === generation && currentCancellation.owner_token_digest === ownerTokenDigest, "cancellation identity changed during live reconciliation", "RUNNER_BARRIER");
        if (currentCancellation.phase === "draining" || currentCancellation.phase === "complete") {
          finishRunnerTransition(registry, identity.repo, generation, token, reservation, deliveryId);
          if (currentCancellation.phase !== "complete") finalizeDrainedCancellation();
          return true;
        }
        if (cancellationFailure) cancellationFailure = undefined;
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    };
    const sameReviewerWait = (left: AcceptedReviewerWaitIdentity | undefined, right: AcceptedReviewerWaitIdentity | undefined): boolean => Boolean(left && right && digest(left) === digest(right));
    while (true) {
      watchCancellation(); if (watched) await watched; if (finalizeDrainedCancellation()) break;
      const before = registry.readSession(identity.repo), currentDelivery: DeliveryState | undefined = before.delivery_id ? store.read(identity.repo, before.delivery_id) : active;
      if (settleReleasedClaim(currentDelivery)) break;
      if (before.desired_state === "running") {
        const retryDelay = supervisor.retryDelayMs();
        if (retryDelay > 0) { await waitForWake(retryDelay); continue; }
        if (currentDelivery && !supervisor.transitionRequired(currentDelivery)) { await waitForWake(requestedPoll); continue; }
      }
      const allowStopping = before.desired_state === "stopped" && deliveryRequiresDrain(currentDelivery);
      const reviewerWait = before.desired_state === "running" && supervisor.retryDelayMs() === 0 ? acceptedReviewerWaitIdentity(currentDelivery) : undefined;
      const reserved = reserveRunnerTransition(registry, identity.repo, generation, token, allowStopping);
      if (!reserved) { const session = registry.readSession(identity.repo); if (session.status === "stopped") break; heartbeatIfDue(); await new Promise((resolveWait) => setTimeout(resolveWait, 250)); continue; }
      const reservation = reserved.operation!.token, stoppingDrain = reserved.operation?.kind === "worker" && reserved.operation.effect_admission === "stopping_drain"; if (!registry.markWorkerEffect(identity.repo, reservation, reviewerWait?.execution_id ?? currentDelivery?.runner.execution_id)) continue;
      heartbeatIfDue(true); let heartbeatFailure: unknown;
      const timer = setInterval(watchCancellation, 25), heartbeatTimer = setInterval(() => { try { heartbeatIfDue(); } catch (error) { heartbeatFailure ??= error; } }, 1_000); timer.unref(); heartbeatTimer.unref();
      try {
        if (stoppingDrain) {
          do {
            try { active = await engine.drainAcceptedExecution(identity.repo, currentDelivery!.delivery_id, active?.revision ?? currentDelivery!.revision); }
            catch (error) {
              if (!(error instanceof DeliveryError) || error.code !== "STALE_REVISION") throw error;
              const current = registry.readSession(identity.repo), operation = current.operation, cancellation = current.cancellation;
              const latest = store.read(identity.repo, currentDelivery!.delivery_id), durable = latest.controls.cancellation;
              const pending = cancellation?.epoch.startsWith("pending:") === true;
              const exactCancellationSupersession = current.generation === generation && current.owner_token_digest === ownerTokenDigest
                && current.owner_pid === process.pid && current.owner_process_identity === workerProcessIdentity && current.status === "stopping" && current.desired_state === "stopped"
                && !current.recovery && !current.in_flight && operation?.kind === "worker" && operation.token === reservation && operation.phase === "effect"
                && operation.effect_admission === "stopping_drain" && operation.generation === generation && operation.owner_token_digest === ownerTokenDigest
                && operation.owner_pid === process.pid && operation.owner_process_identity === workerProcessIdentity && operation.delivery_id === currentDelivery!.delivery_id
                && cancellation?.delivery_id === currentDelivery!.delivery_id && cancellation.generation === generation && cancellation.owner_token_digest === ownerTokenDigest
                && (pending && durable === undefined || durable?.request_id === cancellation.request_id && durable.request_digest === cancellation.input_digest
                  && durable.expected_revision === cancellation.expected_revision && durable.repository_generation === cancellation.generation && durable.epoch === cancellation.epoch);
              if (!exactCancellationSupersession) throw error;
              active = latest; break;
            }
            if (heartbeatFailure) throw heartbeatFailure;
            if (!deliveryRequiresDrain(active) || registry.readSession(identity.repo).cancellation) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, 250));
          } while (true);
        } else {
          active = await supervisor.tick();
          while (sameReviewerWait(reviewerWait, acceptedReviewerWaitIdentity(active)) && supervisor.retryDelayMs() === 0) {
            const held = registry.readSession(identity.repo), operation = held.operation;
            if (held.status !== "running" || held.desired_state !== "running" || held.cancellation || held.recovery || held.in_flight
              || operation?.kind !== "worker" || operation.token !== reservation || operation.phase !== "effect" || operation.effect_admission !== "running"
              || operation.generation !== generation || operation.owner_token_digest !== ownerTokenDigest || operation.owner_pid !== process.pid
              || operation.owner_process_identity !== workerProcessIdentity || operation.delivery_id !== reviewerWait!.delivery_id) break;
            await waitForWake(requestedPoll);
            const afterWait = registry.readSession(identity.repo), afterOperation = afterWait.operation;
            if (afterWait.status !== "running" || afterWait.desired_state !== "running" || afterWait.cancellation || afterWait.recovery || afterWait.in_flight
              || afterOperation?.kind !== "worker" || afterOperation.token !== reservation || afterOperation.phase !== "effect" || afterOperation.effect_admission !== "running"
              || afterOperation.generation !== generation || afterOperation.owner_token_digest !== ownerTokenDigest || afterOperation.owner_pid !== process.pid
              || afterOperation.owner_process_identity !== workerProcessIdentity || afterOperation.delivery_id !== reviewerWait!.delivery_id || supervisor.retryDelayMs() > 0) break;
            const latest = store.read(identity.repo, reviewerWait!.delivery_id);
            if (!sameReviewerWait(reviewerWait, acceptedReviewerWaitIdentity(latest))) break;
            active = await supervisor.tick();
            if (heartbeatFailure) throw heartbeatFailure;
          }
        }
        if (heartbeatFailure) throw heartbeatFailure;
      }
      catch (error) {
        const current = registry.readSession(identity.repo), exactOwner = current.generation === generation && current.owner_token_digest === ownerTokenDigest && current.owner_pid === process.pid && current.owner_process_identity === processIdentity(process.pid);
        if (!exactOwner) throw error;
        registry.recordWorkerDiagnostic(identity.repo, generation, ownerTokenDigest, workerProcessIdentity!, error);
        if (!current.cancellation) throw error;
      }
      finally { clearInterval(timer); clearInterval(heartbeatTimer); if (watched) await watched; }
      if (registry.readSession(identity.repo).cancellation && await pumpOwnedCancellation(reservation, currentDelivery!.delivery_id)) break;
      finishRunnerTransition(registry, identity.repo, generation, token, reservation, active?.delivery_id);
      if (finalizeDrainedCancellation()) break;
      const ownedId = registry.readSession(identity.repo).delivery_id, owned = ownedId ? store.read(identity.repo, ownedId) : active;
      if (settleReleasedClaim(owned)) break;
      await waitForWake(Math.max(requestedPoll, supervisor.retryDelayMs()));
    }
  } finally { process.off("SIGINT", requestSignalStop); process.off("SIGTERM", requestSignalStop); await Promise.all(configured.paseoClients.map((client) => client.close().catch(() => undefined))); }
}

interface RunnerRecoveryResult { revision: number; launch: boolean }

async function resumeRecoveredCancellation(directory: string, requestId: string, registry: RepositoryRegistry): Promise<RunnerRecoveryResult> {
  const identity = resolveRepository(directory), initial = registry.readSession(identity.repo), cancellation = initial.cancellation;
  requireCondition(cancellation && initial.requests[requestId]?.status === "reconciled" && initial.owner_pid === null && !initial.operation && !initial.recovery && !initial.in_flight, "recovered cancellation is not ready for exact finalization", "RUNNER_BARRIER");
  const binding = registry.readBinding(identity.repo); requireCondition(binding, "repository setup is incomplete");
  const profile = registry.admitProfile(identity, binding.profile_path, binding.state_dir).profile, store = new FileStateStore(binding.state_dir);
  const configured = await configuredEngine(store, { command: "runner-recovery", positionals: [], options: new Map([["profile", binding.profile_path]]) }, identity.repo, process.env.DELIVERY_OPERATOR_GRANT, profile);
  try {
    const coordinated = beginCoordinatedCancellation({ registry, engine: configured.engine, repo: identity.repo, deliveryId: cancellation.delivery_id, expectedRevision: cancellation.expected_revision, requestId: cancellation.request_id, inputDigest: cancellation.input_digest, grant: process.env.DELIVERY_OPERATOR_GRANT });
    const result = await reconcileCoordinatedCancellation({ registry, engine: configured.engine, coordinated, adapters: { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) } });
    requireCondition(result === "complete", "recovered cancellation remains uncertain", "CANCEL_UNCONFIRMED");
    const current = registry.readSession(identity.repo);
    const completed = registry.mutateSession(identity.repo, current.revision, (value) => {
      const request = value.requests[requestId]; requireCondition(request?.status === "reconciled" && value.cancellation?.phase === "complete" && value.owner_pid === null && !value.operation && !value.recovery && !value.in_flight, "recovered cancellation completion changed", "RUNNER_BARRIER");
      request.status = "completed"; return value;
    });
    return { revision: completed.revision, launch: false };
  } finally { await Promise.all(configured.paseoClients.map((client) => client.close().catch(() => undefined))); }
}

async function reconcileRunnerRecovery(directory: string, expectedRevision: number, requestId: string, registry: RepositoryRegistry): Promise<RunnerRecoveryResult | undefined> {
  const identity = resolveRepository(directory), initial = registry.readSession(identity.repo), requestDigest = digest({ repo: identity.repo, expected_revision: expectedRevision, action: "recover", issue: null }), prior = initial.requests[requestId];
  if (prior) {
    requireCondition(prior.digest === requestDigest, "request ID was already used for different runner input", "REQUEST_CONFLICT");
    if (prior.status === "completed") return { revision: initial.revision, launch: false };
    if (prior.status === "reconciled" && initial.cancellation) return resumeRecoveredCancellation(directory, requestId, registry);
    if (prior.status === "reconciled") return { revision: initial.revision, launch: true };
    if (initial.recovery && !processOwnershipLost(initial.recovery.owner_pid, initial.recovery.owner_process_identity)) return undefined;
  }
  const initialObservation = registry.observe(initial); if (!prior) requireCondition(initial.revision === expectedRevision, `stale runner revision: current ${initial.revision}`, "STALE_REVISION"); requireCondition(initialObservation.status === "uncertain" && initialObservation.observedState === "lost", "recovery requires proven lost process ownership");
  const strandedWorker = initial.operation;
  if (strandedWorker) { requireCondition(strandedWorker.kind === "worker", "command reservation requires exact command-journal reconciliation", "RUNNER_BARRIER"); requireCondition(strandedWorker.generation === initial.generation && strandedWorker.owner_token_digest === initial.owner_token_digest && processOwnershipLost(strandedWorker.owner_pid, strandedWorker.owner_process_identity), "worker reservation ownership is not an exact proven-lost runner operation", "RUNNER_BARRIER"); }
  const strandedCancellation = initial.cancellation;
  if (strandedCancellation) {
    requireCondition(strandedWorker?.kind === "worker" && strandedWorker.phase === "effect" && typeof strandedWorker.operation_id === "string", "dead cancellation recovery requires one exact effect reservation", "RUNNER_BARRIER");
    requireCondition(!strandedCancellation.epoch.startsWith("pending:") && strandedCancellation.delivery_id === strandedWorker.delivery_id && strandedCancellation.generation === initial.generation
      && strandedCancellation.owner_token_digest === initial.owner_token_digest && processOwnershipLost(strandedCancellation.owner_pid, strandedCancellation.owner_process_identity), "cancellation observer ownership is not exactly lost", "RUNNER_BARRIER");
  }
  registry.recoverMutationLock(identity.repo);
  const recoveryToken = `recovery_${digest({ repo: identity.repo, revision: expectedRevision, request: new Date().toISOString() }).slice(0, 24)}`;
  const recoveryOwnerIdentity = processIdentity(process.pid); requireCondition(recoveryOwnerIdentity, "recovery process identity is unavailable");
  const session = registry.mutateSession(identity.repo, prior ? initial.revision : expectedRevision, (value) => { const observed = registry.observe(value); requireCondition(observed.status === "uncertain" && observed.observedState === "lost", "recovery requires one proven lost owner"); if (value.recovery) requireCondition(processOwnershipLost(value.recovery.owner_pid, value.recovery.owner_process_identity), "another recovery owner is still alive or cannot be proven lost"); value.recovery = { token: recoveryToken, started_at: new Date().toISOString(), owner_pid: process.pid, owner_process_identity: recoveryOwnerIdentity }; value.requests[requestId] = { digest: requestDigest, action: "recover", revision: value.revision + 1, at: prior?.at ?? new Date().toISOString(), status: "intent" }; return value; });
  const recoveryHeartbeat = setInterval(() => { try { registry.heartbeatRecovery(identity.repo, recoveryToken); } catch { /* exact-token completion below reports ownership loss */ } }, 1_000); recoveryHeartbeat.unref();
  let active: ReturnType<FileStateStore["list"]>[number] | undefined;
  try {
    const binding = registry.readBinding(identity.repo); requireCondition(binding, "repository setup is incomplete"); const profile = registry.admitProfile(identity, binding.profile_path, binding.state_dir).profile, store = new FileStateStore(binding.state_dir);
    store.recoverRepoLock(identity.repo); const recoveryScan = store.scan(identity.repo); requireCondition(recoveryScan.diagnostics.length === 0, "saved delivery state is unreadable; recovery cannot infer external-effect ownership"); active = recoveryScan.states.find((state) => state.claim_status === "active") ?? (strandedCancellation ? recoveryScan.states.find((state) => state.delivery_id === strandedCancellation.delivery_id) : undefined);
    if (active && strandedCancellation && strandedWorker?.kind === "worker") {
      requireCondition(active.delivery_id === strandedCancellation.delivery_id, "dead cancellation delivery identity changed", "RUNNER_BARRIER");
      const synthetic: Args = { command: "runner-recovery", positionals: [], options: new Map([["profile", binding.profile_path]]) }, configured = await configuredEngine(store, synthetic, identity.repo, process.env.DELIVERY_OPERATOR_GRANT, profile);
      try {
        const context = { repo: identity.repo, delivery_id: strandedCancellation.delivery_id, expected_revision: strandedCancellation.expected_revision, request_id: strandedCancellation.request_id, input_digest: strandedCancellation.input_digest, repository_generation: strandedCancellation.generation };
        const readback = await configured.engine.reconcileCancellationExecutionReadback(context, strandedWorker.operation_id!, { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) });
        active = store.read(identity.repo, strandedCancellation.delivery_id);
        const durable = active.controls.cancellation, execution = active.executions.find((item) => item.id === strandedWorker.operation_id);
        requireCondition(readback.epoch === strandedCancellation.epoch && readback.request_digest === strandedCancellation.input_digest && (readback.status === "draining" || readback.status === "complete")
          && readback.outstanding_operation_ids.length === 0 && durable?.epoch === strandedCancellation.epoch && durable.request_id === strandedCancellation.request_id
          && durable.request_digest === strandedCancellation.input_digest && durable.expected_revision === strandedCancellation.expected_revision
          && durable.repository_generation === strandedCancellation.generation && durable.outstanding_operation_ids.length === 0
          && execution && execution.external_id && execution.effect === "accepted" && ["completed", "failed", "cancelled"].includes(execution.status)
          && execution.terminal && execution.terminal !== "nonterminal" && execution.proof && typeof execution.proof_digest === "string"
          && execution.cancellation?.epoch === strandedCancellation.epoch && execution.cancellation.status === "completed"
          && !active.executions.some((item) => ["dispatching", "running", "uncertain"].includes(item.status))
          && !active.operations.some((operation) => ["intent", "accepted", "uncertain"].includes(operation.status)) && active.unresolved_effects.length === 0,
        "authoritative cancellation readback did not prove exact terminal quiescence", "CANCEL_UNCONFIRMED");
        registry.retireDeadWorkerForCancellation(identity.repo, { recovery_token: recoveryToken, request_id: requestId, operation_token: strandedWorker.token, operation_id: strandedWorker.operation_id!, delivery_id: strandedCancellation.delivery_id,
          generation: strandedCancellation.generation, owner_token_digest: strandedCancellation.owner_token_digest, owner_pid: strandedWorker.owner_pid, owner_process_identity: strandedWorker.owner_process_identity,
          cancellation_token: strandedCancellation.token, cancellation_request_id: strandedCancellation.request_id, cancellation_input_digest: strandedCancellation.input_digest,
          cancellation_expected_revision: strandedCancellation.expected_revision, cancellation_epoch: strandedCancellation.epoch });
        const coordinated = beginCoordinatedCancellation({ registry, engine: configured.engine, repo: identity.repo, deliveryId: strandedCancellation.delivery_id, expectedRevision: strandedCancellation.expected_revision, requestId: strandedCancellation.request_id, inputDigest: strandedCancellation.input_digest, grant: process.env.DELIVERY_OPERATOR_GRANT });
        const result = await reconcileCoordinatedCancellation({ registry, engine: configured.engine, coordinated, adapters: { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) } });
        requireCondition(result === "complete", "recovered cancellation remains uncertain", "CANCEL_UNCONFIRMED");
        const final = registry.readSession(identity.repo), completed = registry.mutateSession(identity.repo, final.revision, (value) => { const request = value.requests[requestId]; requireCondition(request?.status === "reconciled" && value.cancellation?.phase === "complete" && value.owner_pid === null, "recovered cancellation completion changed", "RUNNER_BARRIER"); request.status = "completed"; return value; });
        return { revision: completed.revision, launch: false };
      } finally { await Promise.all(configured.paseoClients.map((client) => client.close().catch(() => undefined))); }
    }
    requireCondition(!strandedCancellation, "dead cancellation recovery requires an active exact delivery", "CANCEL_UNCONFIRMED");
    if (active) {
    const synthetic: Args = { command: "runner-recovery", positionals: [], options: new Map([["profile", binding.profile_path]]) }, configured = await configuredEngine(store, synthetic, identity.repo, undefined, profile);
    try {
      if (active.operations.some((operation) => ["intent", "accepted", "uncertain"].includes(operation.status))) active = await configured.engine.reconcilePublicationEffects(identity.repo, active.delivery_id, active.revision);
      const agent = active.executions.find((execution) => execution.id === active!.runner.execution_id && execution.kind === "agent");
      if (agent && ["dispatching", "running", "uncertain"].includes(agent.status)) {
        if (agent.status === "uncertain" && agent.external_id) active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.executions.find((item) => item.id === agent.id)!.status = "running"; state.runner.status = "running"; return state; });
        if (active.runner.status === "dispatching" && profile.executor.kind !== "pi") active = await configured.engine.dispatch(identity.repo, active.delivery_id, active.revision);
        else if (active.runner.status === "running") active = await configured.engine.collect(identity.repo, active.delivery_id, active.revision);
      }
      const reviewer = active.executions.find((execution) => execution.kind === "reviewer" && ["dispatching", "running", "uncertain"].includes(execution.status));
      if (reviewer && !active.receipts.engineering) {
        if (reviewer.status === "uncertain" && reviewer.external_id) active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { state.executions.find((item) => item.id === reviewer.id)!.status = "running"; return state; });
        if (reviewer.external_id || profile.reviewer?.kind !== "pi") active = await configured.engine.verifyCandidate(identity.repo, active.delivery_id, active.revision);
      }
    } finally { await Promise.all(configured.paseoClients.map((client) => client.close().catch(() => undefined))); }
    }
    if (active) {
      active = store.mutate(identity.repo, active.delivery_id, active.revision, (state) => { const resolved = new Set([...state.executions.filter((item) => ["completed", "cancelled", "failed"].includes(item.status)).map((item) => item.id), ...state.operations.filter((item) => item.status === "completed").map((item) => item.id)]); state.unresolved_effects = state.unresolved_effects.filter((item) => !resolved.has(item)); return state; });
      requireCondition(!active.executions.some((execution) => execution.status === "uncertain" || execution.status === "dispatching" || execution.status === "running" && !execution.external_id) && !active.operations.some((operation) => ["intent", "accepted", "uncertain"].includes(operation.status)) && active.unresolved_effects.length === 0, "external effects are not uniquely reconciled; recovery cannot duplicate them");
    }
    const current = registry.readSession(identity.repo);
    return { revision: registry.mutateSession(identity.repo, current.revision, (value) => { requireCondition(value.recovery?.token === recoveryToken, "runner recovery reservation changed"); if (session.in_flight) requireCondition(value.in_flight?.token === session.in_flight.token, "runner transition changed during recovery"); if (strandedWorker) { requireCondition(value.operation?.kind === "worker" && value.operation.token === strandedWorker.token && value.operation.generation === strandedWorker.generation && value.operation.owner_token_digest === strandedWorker.owner_token_digest && processOwnershipLost(value.operation.owner_pid, value.operation.owner_process_identity), "worker reservation changed during recovery", "RUNNER_BARRIER"); delete value.operation; } delete value.recovery; if (session.in_flight) delete value.in_flight; value.requests[requestId]!.status = "reconciled"; value.reason = active?.unresolved_effects.length ? "Existing external effects require exact readback after recovery." : undefined; return value; }).revision, launch: true };
  } catch (error) {
    const current = registry.readSession(identity.repo); if (current.recovery?.token === recoveryToken) registry.mutateSession(identity.repo, current.revision, (value) => { delete value.recovery; value.reason = "Recovery did not prove a safe continuation; no new work was launched."; return value; }); throw error;
  } finally { clearInterval(recoveryHeartbeat); }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let runtimeClients: PaseoClient[] = [];
  try {
    if (argv.length === 0) argv = ["foreground"];
    const args = parse([...argv]);
    if (args.command === "workspace-status") {
      allowed(args, ["directory"]); console.log(JSON.stringify(envelope(workspaceSnapshot(string(args, "directory")!)))); return 0;
    }
    if (args.command === "workspace-setup") {
      allowed(args, ["directory", "expected-revision", "expected-scope", "request-id"]); const requestId = string(args, "request-id")!, directory = string(args, "directory")!, registry = new RepositoryRegistry(); requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId), "invalid request ID", "INVALID_ARGUMENT"); assertWorkspaceScope(directory, string(args, "expected-scope", false), registry);
      const result = setupWorkspace(directory, nonnegative(args, "expected-revision", true)!, requestId, await stdinJson(), registry); console.log(JSON.stringify(envelope(result))); return 0;
    }
    if (args.command === "runner-control") {
      allowed(args, ["directory", "expected-revision", "expected-scope", "request-id", "action", "issue"]); const directory = string(args, "directory")!, registry = new RepositoryRegistry(); assertWorkspaceScope(directory, string(args, "expected-scope", false), registry); const identity = resolveRepository(directory), action = string(args, "action") as RunnerAction;
      requireCondition(["start", "pause", "resume", "stop", "recover"].includes(action), "invalid runner action", "INVALID_ARGUMENT");
      const requestId = string(args, "request-id")!, requestRevision = nonnegative(args, "expected-revision", true)!; requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId), "invalid request ID", "INVALID_ARGUMENT");
      if (action === "recover" && !registry.readBinding(identity.repo)) {
        const session = registry.readSession(identity.repo); requireCondition(session.revision === requestRevision && session.generation === 0 && session.status === "stopped", "unbound legacy recovery requires an unchanged stopped repository session", "STALE_REVISION"); registry.recoverLegacyForeground(identity.repo);
        console.log(JSON.stringify(envelope(workspaceSnapshot(directory, registry)))); return 0;
      }
      let expectedRevision = requestRevision; if (action === "recover") { const reconciled = await reconcileRunnerRecovery(directory, expectedRevision, requestId, registry); if (reconciled === undefined || !reconciled.launch) { console.log(JSON.stringify(envelope(workspaceSnapshot(directory, registry)))); return 0; } expectedRevision = reconciled.revision; }
      controlRunner({ identity, expectedRevision, ...(action === "recover" ? { requestRevision } : {}), requestId, action, ...(integer(args, "issue") ? { issue: integer(args, "issue") } : {}) }, registry);
      console.log(JSON.stringify(envelope(workspaceSnapshot(directory, registry)))); return 0;
    }
    if (args.command === "runner-worker") {
      allowed(args, ["directory", "generation", "token"]); const directory = string(args, "directory")!, generation = integer(args, "generation", true)!, token = string(args, "token")!;
      try { await runRepositoryWorker(directory, generation, token); }
      catch (error) {
        try { const identity = resolveRepository(directory), registry = new RepositoryRegistry(), current = registry.readSession(identity.repo), ownerIdentity = processIdentity(process.pid); if (ownerIdentity && current.generation === generation && current.owner_token_digest === digest(token)) registry.recordWorkerExitFailure(identity.repo, generation, digest(token), ownerIdentity, error); } catch { /* preserve original failure and exact durable ownership */ }
        throw error;
      }
      console.log(JSON.stringify(envelope({ status: "stopped" }))); return 0;
    }
    if (args.command === "workspace-command") {
      allowed(args, ["directory", "delivery-id", "expected-revision", "expected-scope", "request-id", "action", "digest"]); const directory = string(args, "directory")!, registry = new RepositoryRegistry(); assertWorkspaceScope(directory, string(args, "expected-scope", false), registry); const identity = resolveRepository(directory), binding = registry.readBinding(identity.repo); requireCondition(binding, "repository setup is incomplete");
      const profile = registry.admitProfile(identity, binding.profile_path, binding.state_dir).profile; const action = string(args, "action") as ControlAction; requireCondition(WORKSPACE_ACTIONS.includes(action), "invalid workspace action", "INVALID_ARGUMENT");
      const deliveryId = string(args, "delivery-id")!, expectedRevision = integer(args, "expected-revision", true)!, requestId = string(args, "request-id")!;
      const sessionBefore = registry.readSession(identity.repo), observedBefore = registry.observe(sessionBefore);
      if (action === "cancel") {
        const store = new FileStateStore(binding.state_dir), liveOwner = observedBefore.observedState === "alive";
        const configured = await configuredEngine(store, { ...args, options: new Map([...args.options, ["profile", binding.profile_path]]) }, identity.repo, process.env.DELIVERY_OPERATOR_GRANT, profile, !liveOwner); runtimeClients = configured.paseoClients;
        const coordinated = beginCoordinatedCancellation({ registry, engine: configured.engine, repo: identity.repo, deliveryId, expectedRevision, requestId, inputDigest: cancellationInputDigest(identity.repo, deliveryId, expectedRevision), grant: process.env.DELIVERY_OPERATOR_GRANT });
        if (!liveOwner) await reconcileCoordinatedCancellation({ registry, engine: configured.engine, coordinated, adapters: { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) } });
        await Promise.all(runtimeClients.map((client) => client.close())); runtimeClients = []; console.log(JSON.stringify(envelope(workspaceSnapshot(directory, registry)))); return 0;
      }
      let reservation: string | undefined, commandInputDigest: string | undefined, reconcilingEffect = false, readbackOnly = false;
      const draftDigest = string(args, "digest", false);
      if (action === "retry_review") {
        requireCondition(process.env.DELIVERY_OPERATOR_GRANT, "operator control grant is unavailable", "UNAUTHORIZED");
        requireCondition(draftDigest === undefined, "review retry does not accept a publication digest", "INVALID_ARGUMENT");
      }
      if (["publish_plan", "publish_implementation", "correct", "recheck_ready", "retry_review"].includes(action)) {
        const session = registry.readSession(identity.repo), observed = registry.observe(session);
        commandInputDigest = repositoryCommandInputDigest({ repo: identity.repo, deliveryId, expectedRevision, requestId, action, draftDigest });
        reconcilingEffect = session.operation?.kind === "command" && session.operation.request_id === requestId && session.operation.input_digest === commandInputDigest && session.operation.phase === "effect";
        readbackOnly = reconcilingEffect && ["paused", "stopped"].includes(session.desired_state);
        const stoppedReviewRetry = action === "retry_review" && session.desired_state === "stopped" && observed.status === "stopped" && observed.observedState === "not_running";
        requireCondition(session.desired_state === "running" && observed.status === "running" || stoppedReviewRetry || readbackOnly, "repository runner barrier blocks new external effects", "RUNNER_BARRIER");
        const reserved = reserveWorkspaceCommand(registry, identity.repo, { action, delivery_id: deliveryId, request_id: requestId, input_digest: commandInputDigest, expected_revision: expectedRevision, ...(action === "retry_review" ? { allow_stopped: true } : {}), ...(draftDigest === undefined ? {} : { draft_digest: draftDigest }), ...(reconcilingEffect ? { reconcile_effect: true } : {}) }); reservation = reserved.token; readbackOnly = reserved.readbackOnly;
      }
      const store = new FileStateStore(binding.state_dir);
      const configured = await configuredEngine(store, { ...args, options: new Map([...args.options, ["profile", binding.profile_path]]) }, identity.repo, process.env.DELIVERY_OPERATOR_GRANT, profile, action !== "retry_review"); runtimeClients = configured.paseoClients;
      if (reservation && reconcilingEffect) {
        const reconciled = await configured.engine.reconcileControlRequest({ repo: identity.repo, deliveryId, expectedRevision, action, requestId, grant: process.env.DELIVERY_OPERATOR_GRANT, ...(draftDigest === undefined ? {} : { draftDigest }), repositoryInputDigest: commandInputDigest!, ...(readbackOnly ? { mode: "readback" as const } : {}) });
        requireCondition(reconciled.repository_input_digest === commandInputDigest, "engine reconciled a different repository command", "REQUEST_CONFLICT");
        if ((readbackOnly || action === "retry_review") && reconciled.status === "absent") {
          registry.finishReservation(identity.repo, reservation);
          throw new DeliveryError(action === "retry_review" ? "review retry authorization was proven absent and retired; explicitly replay the exact request" : "dead command was proven pre-effect and retired; explicitly Resume the repository and replay the exact request", "RUNNER_BARRIER");
        }
        requireCondition(reconciled.status === "completed" || reconciled.status === "failed", "command effect remains uncertain after authoritative journal reconciliation", "RUNNER_BARRIER");
        registry.finishReservation(identity.repo, reservation);
        await Promise.all(runtimeClients.map((client) => client.close())); runtimeClients = []; console.log(JSON.stringify(envelope(workspaceSnapshot(directory, registry)))); return 0;
      }
      if (reservation) registry.markCommandEffect(identity.repo, reservation, requestId);
      try {
        await configured.engine.control({ repo: identity.repo, deliveryId, expectedRevision, action, requestId, grant: process.env.DELIVERY_OPERATOR_GRANT, ...(draftDigest === undefined ? {} : { draftDigest }) });
      } catch (error) {
        if (reservation && error instanceof DeliveryError && error.code === "STALE_REVISION") {
          try {
            const readback = await configured.engine.reconcileControlRequest({ repo: identity.repo, deliveryId, expectedRevision, action, requestId, grant: process.env.DELIVERY_OPERATOR_GRANT, ...(draftDigest === undefined ? {} : { draftDigest }), repositoryInputDigest: commandInputDigest!, mode: "readback" });
            if (readback.status === "absent") registry.finishReservation(identity.repo, reservation);
          } catch { /* retain the exact reservation unless authoritative readback proves no matching effect */ }
        } else if (action === "retry_review" && reservation) {
          const readback = await configured.engine.reconcileControlRequest({ repo: identity.repo, deliveryId, expectedRevision, action, requestId, grant: process.env.DELIVERY_OPERATOR_GRANT, ...(draftDigest === undefined ? {} : { draftDigest }), repositoryInputDigest: commandInputDigest!, mode: "readback" });
          if (["absent", "completed", "failed"].includes(readback.status)) registry.finishReservation(identity.repo, reservation);
        }
        throw error;
      }
      if (reservation) registry.finishReservation(identity.repo, reservation);
      await Promise.all(runtimeClients.map((client) => client.close())); runtimeClients = []; console.log(JSON.stringify(envelope(workspaceSnapshot(directory, registry)))); return 0;
    }
    if (args.command === "foreground") {
      allowed(args, ["profile"]); const inferred = inferRepository(), identity = resolveRepository(process.cwd()), registry = new RepositoryRegistry(), selectedProfile = string(args, "profile", false) ?? defaultProfilePath(inferred); requireCondition(!registry.readBinding(inferred), "repository is managed by the durable runner; use runner-control", "RUNNER_BARRIER"); const profile = registry.admitProfile(identity, selectedProfile).profile; requireCondition(profile.repository.toLowerCase() === inferred, "foreground profile does not match launch repository");
      const store = new FileStateStore(profile.state_dir); const publisher = new Publisher(store.readProtected(profile.publisher_config) as unknown as PublisherConfig);
      const configured = await configuredEngine(store, { ...args, options: new Map([...args.options, ["profile", string(args, "profile", false) ?? defaultProfilePath(inferred)]]) }, profile.repository, undefined, profile); const engine = configured.engine; runtimeClients = configured.paseoClients;
      const policy = loadPolicy(profile.policy.path, { expectedDigest: profile.policy.digest, sourceRef: profile.policy.ref, sourceSha: profile.policy.sha, fetchedAt: profile.policy.fetched_at }); const foreground = loadForegroundPolicy(profile.foreground_policy, profile.repository);
      const runtimeLocations = { ...profileRuntimeLocations(string(args, "profile", false) ?? defaultProfilePath(inferred), profile), skills_root: profile.skills_root, engine_src: fileURLToPath(new URL("./", import.meta.url)) }; const controller = new AbortController(); const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
      const reconcileCancellation = async (): Promise<boolean> => {
        const reservation = registry.readSession(profile.repository).cancellation; if (!reservation || reservation.phase === "complete" || reservation.epoch.startsWith("pending:")) return false;
        const coordinated = { context: { repo: profile.repository, delivery_id: reservation.delivery_id, expected_revision: reservation.expected_revision, request_id: reservation.request_id, input_digest: reservation.input_digest, repository_generation: reservation.generation }, reservation };
        return await reconcileCoordinatedCancellation({ registry, engine, coordinated, adapters: { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) } }) === "complete";
      };
      try { await new ForegroundSupervisor({ engine, repo: profile.repository, policy, policyConfig: foreground, pinLocations: runtimeLocations, skillHashes: skillHashes(profile.skills_root), engineHashes: { delivery_src: hashPackage(runtimeLocations.engine_src) }, reconcileCancellation, sessionGuard: (acquire) => registry.withLegacyForegroundGuard(inferred, profile.state_dir, acquire), onStatus: foregroundStatusReporter() }).run(controller.signal); }
      finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await Promise.all(runtimeClients.map((client) => client.close())); runtimeClients = []; }
      console.log(JSON.stringify(envelope({ status: "stopped", repo: profile.repository }))); return 0;
    }
    if (args.command === "inspect-export") {
      allowed(args, ["input"]); const value = inspectRunExport(string(args, "input")!); console.log(JSON.stringify(envelope(value))); return 0;
    }
    const profilePath = string(args, "profile", false); let profile = profilePath ? loadLocalProfile(profilePath) : undefined;
    const suppliedStateDir = string(args, "state-dir", !profile); if (profile && suppliedStateDir) requireCondition(resolve(suppliedStateDir) === profile.state_dir, "--state-dir cannot override the selected profile", "INVALID_ARGUMENT");
    const repo = (string(args, "repo", args.command !== "list" && !profile) ?? profile?.repository) as string | undefined;
    if (profile && repo) requireCondition(repo.toLowerCase() === profile.repository.toLowerCase(), "--repo does not match the selected profile repository", "INVALID_ARGUMENT");
    const stateDir = suppliedStateDir ?? profile!.state_dir; const store = new FileStateStore(stateDir); const grant = process.env.DELIVERY_OPERATOR_GRANT;
    const registry = new RepositoryRegistry(), durableBinding = registry.bindingForStateDir(stateDir), repositoryBinding = repo ? registry.readBinding(repo.toLowerCase()) : undefined;
    const legacyMutations = ["start", "resume", "advance", "stage-handoff", "publish-plan", "publish-implementation", "export-handoff", "bind-manual-pr", "pause", "control-resume", "control-publish-plan", "control-publish-implementation", "cancel", "recover", "correct", "recheck-ready", "retry-review", "draft-issue", "draft-remove", "draft-publish", "draft-retry"];
    if (repositoryBinding && legacyMutations.includes(args.command)) requireCondition(resolve(stateDir) === repositoryBinding.state_dir, "repository is bound to a different durable state root; use runner-control or workspace-command", "RUNNER_BARRIER");
    if (durableBinding && ["start", "resume", "advance", "stage-handoff", "publish-plan", "publish-implementation", "pause", "control-resume", "control-publish-plan", "control-publish-implementation", "cancel", "recover", "correct", "recheck-ready", "retry-review"].includes(args.command)) throw new DeliveryError("repository is managed by the durable runner; use runner-control or workspace-command", "RUNNER_BARRIER");
    if (profile && legacyMutations.includes(args.command)) { const identity = resolveRepository(process.cwd()); requireCondition(identity.repo === profile.repository, "effect-capable profile repository does not match the current Git repository", "RUNNER_BARRIER"); profile = registry.admitProfile(identity, profilePath!, profile.state_dir).profile; }
    const directPublisherCommands = ["resume", "publish-plan", "publish-implementation", "export-handoff", "bind-manual-pr", "pause", "control-resume", "control-publish-plan", "control-publish-implementation", "cancel", "recover", "correct", "recheck-ready", "retry-review"];
    const directPublisherConfig = string(args, "publisher-config", false);
    if (!profile && directPublisherConfig && directPublisherCommands.includes(args.command)) {
      if (["pause", "control-resume", "control-publish-plan", "control-publish-implementation", "cancel", "recover", "correct", "recheck-ready", "retry-review"].includes(args.command)) requireCondition(grant, "operator control grant is unavailable", "UNAUTHORIZED");
      const identity = resolveRepository(process.cwd());
      requireCondition(identity.repo === repo?.toLowerCase(), "effect-capable publisher repository does not match the current Git repository", "RUNNER_BARRIER");
      registry.admitPublisherConfig(identity, directPublisherConfig, stateDir);
    }
    const proposalPublicationPolicy = args.command === "draft-publish" || args.command === "draft-retry" ? (() => {
      requireCondition(profile, `${args.command} requires a protected local profile`, "AUTHORIZATION_REQUIRED");
      const foreground = loadForegroundPolicy(profile.foreground_policy, profile.repository);
      requireCondition(foreground.issue_publication !== "off", "issue publication is disabled by protected local policy", "AUTHORIZATION_REQUIRED");
      return foreground;
    })() : undefined;
    let data: unknown;
    if (args.command === "list") {
      allowed(args, ["state-dir", "repo"]); const scanned = store.scan(repo); const states = scanned.states; data = { schemaVersion: 2, generatedAt: new Date().toISOString(), repositories: [...new Set(states.map((state) => state.repo))].map((id) => ({ id, label: id })), runs: states.flatMap((state) => (dashboardProjection(state).runs as unknown[])), diagnostics: scanned.diagnostics };
    } else if (args.command === "status") {
      allowed(args, ["state-dir", "repo", "delivery-id"]); data = dashboardProjection(store.read(repo!, string(args, "delivery-id")!));
    } else if (args.command === "export") {
      allowed(args, ["state-dir", "repo", "delivery-id", "output"]); const value = createRunExport(store.read(repo!, string(args, "delivery-id")!)); writeRunExport(string(args, "output")!, value); data = { output: string(args, "output")!, digest: value.digest };
    } else if (args.command === "draft-list") {
      allowed(args, ["state-dir", "repo"]); data = new ProposalSpool(store).list(repo!).map(({ body: _body, ...proposal }) => proposal);
    } else if (args.command === "draft-show") {
      allowed(args, ["state-dir", "repo"]); requireCondition(args.positionals.length === 1, "draft proposal ID required"); data = new ProposalSpool(store).read(repo!, args.positionals[0]!);
    } else if (args.command === "draft-remove") {
      allowed(args, ["state-dir", "repo", "digest"]); requireCondition(args.positionals.length === 1, "draft proposal ID required"); data = new ProposalSpool(store).remove(repo!, args.positionals[0]!, string(args, "digest")!);
    } else if (args.command === "draft-issue") {
      allowed(args, ["state-dir", "repo", "from", "repository-id", "actor-id"]); const input = JSON.parse(readFileSync(string(args, "from")!, "utf8")); requireCondition(input && typeof input === "object" && typeof input.title === "string" && typeof input.body === "string" && Object.keys(input).every((key) => ["title", "body"].includes(key)), "issue proposal must contain only title and body"); data = new ProposalSpool(store).enqueue({ repo: repo!, repositoryId: integer(args, "repository-id", true)!, actorId: integer(args, "actor-id", true)!, title: input.title, body: input.body });
    } else if (args.command === "draft-publish") {
      allowed(args, ["state-dir", "repo", "digest"]); requireCondition(proposalPublicationPolicy, "issue publication policy is unavailable"); requireCondition(args.positionals.length === 1, "draft proposal ID required"); const spool = new ProposalSpool(store), proposalId = args.positionals[0]!, proposalDigest = string(args, "digest")!;
      if (durableBinding) {
        requireCondition(repo === durableBinding.repo && profile?.state_dir === durableBinding.state_dir, "draft publication does not match the bound repository", "RUNNER_BARRIER"); requireCondition(grant, "operator control grant is unavailable", "UNAUTHORIZED");
        const registry = new RepositoryRegistry(), identity = proposalCommandIdentity(repo!, "publish_issue", proposalId, proposalDigest), session = registry.readSession(repo!), reconciling = session.operation?.kind === "command" && session.operation.action === "publish_issue" && session.operation.delivery_id === proposalId && session.operation.request_id === identity.requestId && session.operation.input_digest === identity.inputDigest && session.operation.phase === "effect", protectedDigest = reconciling && session.operation?.kind === "command" ? session.operation.draft_digest : proposalDigest;
        const reserved = reserveProposalCommand(registry, repo!, { action: "publish_issue", delivery_id: proposalId, request_id: identity.requestId, input_digest: identity.inputDigest, ...(protectedDigest === undefined ? {} : { draft_digest: protectedDigest }), allow_stopped: true, ...(reconciling ? { reconcile_effect: true } : {}) }), reservation = reserved.token, publisher = new Publisher(store.readProtected(profile.publisher_config) as unknown as PublisherConfig);
        if (!reconciling) registry.markCommandEffect(repo!, reservation, proposalOperationId(repo!, proposalId, proposalDigest));
        try {
          let proposal = spool.read(repo!, proposalId);
          let terminal = false;
          if (reconciling) {
            await publisher.recoverLock?.();
            const readback = await spool.reconcilePublication(repo!, proposalId, publisher, { mode: "readback" }); proposal = readback.proposal;
            if (reserved.readbackOnly) {
              if (readback.status === "absent") { registry.finishReservation(repo!, reservation); throw new DeliveryError("dead proposal command was proven pre-effect and retired; explicitly Resume the repository and replay the exact request", "RUNNER_BARRIER"); }
              requireCondition(readback.status === "completed" || readback.status === "failed", "proposal effect remains uncertain after readback-only reconciliation", "RUNNER_BARRIER");
            }
            terminal = readback.status === "completed" || readback.status === "failed";
          } else terminal = proposal.status === "published" || proposal.status === "failed";
          if (terminal) data = spool.read(repo!, proposalId);
          else { if (proposal.status === "queued") proposal = spool.authorize(repo!, proposalId, proposalDigest); data = await spool.publish(repo!, proposal.id, publisher, "explicit"); }
          registry.finishReservation(repo!, reservation);
        } catch (error) { if (spool.read(repo!, proposalId).status === "failed") registry.finishReservation(repo!, reservation); throw error; }
      } else data = spool.authorize(repo!, proposalId, proposalDigest);
    } else {
    const configured = await configuredEngine(store, args, repo, grant, profile, args.command !== "retry-review" && !(args.command === "start" && args.options.get("no-dispatch") === true)); const engine = configured.engine; runtimeClients = configured.paseoClients;
    if (args.command === "start") {
      allowed(args, ["state-dir", "repo", "issue", "delivery-id", "policy", "policy-ref", "policy-sha", "policy-digest", "policy-fetched-at", "skills-root", "no-dispatch", "agent-launcher", "publisher-launcher", "worktree", "agent-scratch", "profile", "installation", "runtime", "max-attempts", "max-elapsed-seconds"]);
      requireCondition(args.options.get("defer-actions-verification") !== true, "Actions deferral is unsupported in local developer mode");
      const policy = profile ? loadPolicy(profile.policy.path, { expectedDigest: profile.policy.digest, sourceRef: profile.policy.ref, sourceSha: profile.policy.sha, fetchedAt: profile.policy.fetched_at }) : loadPolicy(string(args, "policy")!, { expectedDigest: string(args, "policy-digest")!, sourceRef: string(args, "policy-ref")!, sourceSha: string(args, "policy-sha")!, fetchedAt: string(args, "policy-fetched-at")! });
      const skillsRoot = string(args, "skills-root", false) ?? profile?.skills_root;
      const deliveryId = string(args, "delivery-id", false);
      const engineSrc = fileURLToPath(new URL("./", import.meta.url)); const locations: Record<string, string> = profile ? { ...profileRuntimeLocations(profilePath!, profile), skills_root: profile.skills_root, engine_src: engineSrc } : { ...Object.fromEntries(["skills-root", "agent-launcher", "worktree", "agent-scratch", "installation", "runtime"].flatMap((key) => { const value = string(args, key, false); return value ? [[key, resolve(value)]] : []; })), engine_src: engineSrc };
      const protectedForeground = profile ? loadForegroundPolicy(profile.foreground_policy, profile.repository) : undefined;
      const state = engine.start({ repo: repo!, issue: integer(args, "issue") ?? null, ...(deliveryId ? { deliveryId } : {}), policy, ...(skillsRoot ? { skillHashes: skillHashes(skillsRoot) } : {}), engineHashes: { delivery_src: hashPackage(engineSrc) }, pinLocations: locations, safeguards: protectedForeground ? { publication: { pr: protectedForeground.pr_publication, issue: protectedForeground.issue_publication }, ...(protectedForeground.allowed_paths ? { allowedPaths: protectedForeground.allowed_paths } : {}) } : { publication: { pr: "off", issue: "off" } }, budget: { maxAttempts: integer(args, "max-attempts") ?? 8, maxElapsedSeconds: integer(args, "max-elapsed-seconds") ?? 86400 } });
      data = dashboardProjection(args.options.get("no-dispatch") === true ? state : await engine.dispatch(state.repo, state.delivery_id, state.revision));
    } else if (args.command === "resume") {
      allowed(args, ["state-dir", "repo", "delivery-id", "result", "skills-root", "defer-actions-verification", "publisher-config"]);
      requireCondition(args.options.get("defer-actions-verification") !== true, "Actions verification cannot be deferred");
      const id = string(args, "delivery-id")!; const result = string(args, "result", false);
      if (result) { const state = store.read(repo!, id); data = dashboardProjection(engine.acceptManifest(repo!, id, JSON.parse(readFileSync(result, "utf8")), state.revision)); }
      else { const state = store.read(repo!, id); const next = state.runner.status === "running" ? await engine.collect(repo!, id, state.revision) : state.status === "plan_review" || state.status === "implementation_review" ? await engine.refreshReviews(repo!, id, state.status === "plan_review" ? "plan" : "implementation", state.revision) : ["publication_pending", "pre_ready_ci_waiting", "manual_ready_pending", "tracking_pending"].includes(state.status) ? await engine.recheckReady(repo!, id, state.revision) : state; data = dashboardProjection(next); }
    } else if (args.command === "advance") {
      allowed(args, ["state-dir", "repo", "delivery-id", "stage"]); const stage = string(args, "stage")!; requireCondition(stage === "plan" || stage === "implementation", "--stage must be plan or implementation"); const state = store.read(repo!, string(args, "delivery-id")!); data = dashboardProjection(engine.advanceFromReceipt(repo!, state.delivery_id, stage, state.revision));
    } else if (args.command === "stage-handoff") {
      allowed(args, ["state-dir", "repo", "delivery-id", "stage", "input", "expected-revision"]); const stage = string(args, "stage")!; requireCondition(stage === "plan" || stage === "implementation", "invalid handoff stage"); const handoff = JSON.parse(readFileSync(string(args, "input")!, "utf8")); data = dashboardProjection(engine.stageHandoff(repo!, string(args, "delivery-id")!, stage, handoff, integer(args, "expected-revision", true)!));
    } else if (args.command === "publish-plan" || args.command === "publish-implementation") {
      allowed(args, ["state-dir", "repo", "delivery-id", "publisher-config", "expected-revision", "digest"]); data = dashboardProjection(await engine.publishStage(repo!, string(args, "delivery-id")!, args.command === "publish-plan" ? "plan" : "implementation", integer(args, "expected-revision", true)!, string(args, "digest")!));
    } else if (args.command === "export-handoff" || args.command === "bind-manual-pr") {
      const binding = durableBinding; allowed(args, ["state-dir", "repo", "delivery-id", "publisher-config", "expected-revision", "stage", "number", "request-id"]); const stage = string(args, "stage")!; requireCondition(stage === "plan" || stage === "implementation", "invalid handoff stage");
      const deliveryId = string(args, "delivery-id")!, expectedRevision = integer(args, "expected-revision", true)!, number = args.command === "bind-manual-pr" ? integer(args, "number", true)! : undefined;
      if (binding) {
        requireCondition(profile && profilePath && binding.repo === repo?.toLowerCase() && binding.state_dir === profile.state_dir && binding.profile_path === realpathSync(profilePath), "managed manual publication requires the exact bound repository profile and state root", "RUNNER_BARRIER"); requireCondition(grant, "operator control grant is unavailable", "UNAUTHORIZED");
        const requestId = string(args, "request-id")!, action: ControlAction = args.command === "export-handoff" ? "export_handoff" : "bind_manual_pr";
        const controlInput = { repo: repo!, deliveryId, expectedRevision, action, requestId, grant, stage: stage as ReviewStage, ...(number === undefined ? {} : { number }) };
        const inputDigest = repositoryCommandInputDigest(controlInput), prior = registry.readSession(repo!);
        const exactPrior = prior.operation?.kind === "command" && prior.operation.action === action && prior.operation.delivery_id === deliveryId && prior.operation.request_id === requestId && prior.operation.input_digest === inputDigest;
        const reconcile = async (mode: "recover" | "readback") => {
          const result = await engine.reconcileControlRequest({ ...controlInput, repositoryInputDigest: inputDigest, mode });
          requireCondition(result.repository_input_digest === inputDigest, "engine reconciled a different manual publication command", "REQUEST_CONFLICT"); return result;
        };
        let outcome = await reconcile("readback");
        if (!exactPrior && (outcome.status === "completed" || outcome.status === "failed")) data = dashboardProjection(store.read(repo!, deliveryId));
        else {
          const reserved = reserveWorkspaceCommand(registry, repo!, { action, delivery_id: deliveryId, request_id: requestId, input_digest: inputDigest, expected_revision: expectedRevision, ...(exactPrior ? { reconcile_effect: true } : {}) }), operation = reserved.session.operation!;
          if (outcome.status === "completed" || outcome.status === "failed") { registry.finishReservation(repo!, reserved.token); data = dashboardProjection(store.read(repo!, deliveryId)); }
          else if (reserved.readbackOnly) {
            if (operation.phase === "reserved" && outcome.status === "absent") { registry.finishReservation(repo!, reserved.token); throw new DeliveryError("dead manual publication command was proven pre-effect and retired; explicitly Resume the repository and replay the exact request", "RUNNER_BARRIER"); }
            throw new DeliveryError("manual publication effect remains uncertain after exact readback; resolve it before Resume", "RUNNER_BARRIER");
          } else {
            if (exactPrior) outcome = await reconcile("recover");
            else if (outcome.status === "absent") {
              registry.markCommandEffect(repo!, reserved.token, requestId);
              let controlError: unknown;
              try { await engine.control(controlInput); }
              catch (error) {
                controlError = error;
                try { outcome = await reconcile("readback"); }
                catch { throw error; }
              }
              if (outcome.status === "absent" && controlError !== undefined) { registry.finishReservation(repo!, reserved.token); throw controlError; }
              if (outcome.status === "absent") outcome = await reconcile("readback");
            } else registry.markCommandEffect(repo!, reserved.token, outcome.operation_id ?? requestId);
            if (outcome.status === "completed" || outcome.status === "failed") { registry.finishReservation(repo!, reserved.token); data = dashboardProjection(store.read(repo!, deliveryId)); }
            else throw new DeliveryError("manual publication effect remains uncertain after authoritative journal reconciliation", "RUNNER_BARRIER");
          }
        }
      } else data = dashboardProjection(args.command === "export-handoff" ? await engine.exportManualHandoff(repo!, deliveryId, stage, expectedRevision) : await engine.bindManualPullRequest(repo!, deliveryId, stage, number!, expectedRevision));
    } else if (["pause", "control-resume", "control-publish-plan", "control-publish-implementation", "cancel", "recover", "correct", "recheck-ready", "retry-review"].includes(args.command)) {
      allowed(args, ["state-dir", "repo", "delivery-id", "expected-revision", "request-id", "publisher-config", "digest"]); requireCondition(grant, "operator control grant is unavailable", "UNAUTHORIZED");
      const action = (args.command === "control-resume" ? "resume" : args.command.startsWith("control-publish-") ? args.command.replace("control-", "").replaceAll("-", "_") : args.command.replace("-", "_")) as ControlAction, deliveryId = string(args, "delivery-id")!, expectedRevision = integer(args, "expected-revision", true)!, requestId = string(args, "request-id")!;
      if (action === "cancel") {
        const coordinated = beginCoordinatedCancellation({ registry, engine, repo: repo!, deliveryId, expectedRevision, requestId, inputDigest: cancellationInputDigest(repo!, deliveryId, expectedRevision), grant });
        const foregroundOwner = registry.readLegacyForeground(repo!);
        if (!foregroundOwner || processOwnershipLost(foregroundOwner.pid, foregroundOwner.process_identity)) await reconcileCoordinatedCancellation({ registry, engine, coordinated, adapters: { ...(configured.executor ? { executor: configured.executor } : {}), ...(configured.reviewer ? { reviewer: configured.reviewer } : {}) } });
        data = dashboardProjection(store.read(repo!, deliveryId));
      } else data = await engine.control({ repo: repo!, deliveryId, expectedRevision, action, requestId, grant, ...(string(args, "digest", false) ? { draftDigest: string(args, "digest", false) } : {}) });
    } else if (args.command === "draft-retry") {
      allowed(args, ["state-dir", "repo", "digest", "publisher-config"]); requireCondition(proposalPublicationPolicy, "issue publication policy is unavailable"); requireCondition(args.positionals.length === 1, "draft proposal ID required");
      const publisher = engine.publisherPort(); requireCondition(publisher, "publisher is not configured"); const spool = new ProposalSpool(store);
      if (durableBinding) {
        requireCondition(repo === durableBinding.repo && profile?.state_dir === durableBinding.state_dir, "draft retry does not match the bound repository", "RUNNER_BARRIER");
        requireCondition(grant, "operator control grant is unavailable", "UNAUTHORIZED");
        const proposalId = args.positionals[0]!, proposalDigest = string(args, "digest")!, retryIdentity = proposalCommandIdentity(repo!, "retry_issue", proposalId, proposalDigest), registry = new RepositoryRegistry(), session = registry.readSession(repo!), prior = session.operation?.kind === "command" && session.operation.phase === "effect" && session.operation.delivery_id === proposalId && ["publish_issue", "retry_issue"].includes(session.operation.action) ? session.operation : undefined;
        if (prior) { const expected = proposalCommandIdentity(repo!, prior.action as "publish_issue" | "retry_issue", proposalId, proposalDigest); requireCondition(prior.request_id === expected.requestId && prior.input_digest === expected.inputDigest && (prior.draft_digest === undefined || prior.draft_digest === proposalDigest), "proposal command reconciliation semantic input changed", "REQUEST_CONFLICT"); }
        const command = prior ? { action: prior.action, requestId: prior.request_id, inputDigest: prior.input_digest, ...(prior.draft_digest === undefined ? {} : { draftDigest: prior.draft_digest }) } : { action: "retry_issue", ...retryIdentity, draftDigest: proposalDigest };
        let reserved = reserveProposalCommand(registry, repo!, { action: command.action, delivery_id: proposalId, request_id: command.requestId, input_digest: command.inputDigest, ...(command.draftDigest === undefined ? {} : { draft_digest: command.draftDigest }), allow_stopped: true, ...(prior ? { reconcile_effect: true } : {}) }), reservation = reserved.token;
        if (!prior) registry.markCommandEffect(repo!, reservation, proposalOperationId(repo!, proposalId, proposalDigest));
        try {
          let proposal = spool.read(repo!, proposalId), terminal = false;
          if (prior) {
            await publisher.recoverLock?.();
            const readback = await spool.reconcilePublication(repo!, proposalId, publisher, { mode: "readback" }); proposal = readback.proposal;
            if (reserved.readbackOnly) {
              if (readback.status === "absent") { registry.finishReservation(repo!, reservation); throw new DeliveryError("dead proposal command was proven pre-effect and retired; explicitly Resume the repository and replay the exact request", "RUNNER_BARRIER"); }
              requireCondition(readback.status === "completed" || readback.status === "failed", "proposal effect remains uncertain after readback-only reconciliation", "RUNNER_BARRIER"); terminal = true;
            } else if (readback.status === "completed") terminal = true;
            else if (readback.status === "failed") { registry.finishReservation(repo!, reservation); reserved = reserveProposalCommand(registry, repo!, { action: "retry_issue", delivery_id: proposalId, request_id: retryIdentity.requestId, input_digest: retryIdentity.inputDigest, draft_digest: proposalDigest, allow_stopped: true }); reservation = reserved.token; registry.markCommandEffect(repo!, reservation, proposalOperationId(repo!, proposalId, proposalDigest)); }
          }
          if (terminal) data = proposal;
          else { if (proposal.status !== "published") proposal = spool.retry(repo!, proposalId, proposalDigest); data = proposal.status === "published" ? proposal : await spool.publish(repo!, proposal.id, publisher, "explicit"); }
          registry.finishReservation(repo!, reservation);
        } catch (error) { if (spool.read(repo!, proposalId).status === "failed") registry.finishReservation(repo!, reservation); throw error; }
      } else { const proposal = spool.retry(repo!, args.positionals[0]!, string(args, "digest")!); data = await spool.publish(repo!, proposal.id, publisher, "explicit"); }
    } else throw new DeliveryError(`unsupported command: ${args.command}`, "INVALID_ARGUMENT");
    }
    await Promise.all(runtimeClients.map((client) => client.close())); runtimeClients = []; console.log(JSON.stringify(envelope(data))); return 0;
  } catch (error) {
    await Promise.all(runtimeClients.map((client) => client.close().catch(() => undefined)));
    const value = error instanceof DeliveryError ? error : new DeliveryError(error instanceof Error ? error.message : String(error));
    const match = /current (\d+)/.exec(value.message);
    console.log(JSON.stringify({ ok: false, error: { code: value.code, message: value.message, ...(match ? { currentRevision: Number(match[1]) } : {}) } }));
    return value.code === "INVALID_ARGUMENT" ? 64 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
