import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DeliveryError, digest, newToken, requireCondition, utcNow } from "./core.ts";
import { processIdentity, RepositoryRegistry, type RepositoryIdentity, type RunnerSession } from "./repository.ts";
import { FileStateStore } from "./store.ts";
import { assertNoForegroundSession } from "./foreground.ts";
import type { DeliveryState, ExecutionState } from "./types.ts";

export type RunnerAction = "start" | "pause" | "resume" | "stop" | "recover";
export interface RunnerControlInput { identity: RepositoryIdentity; expectedRevision: number; requestRevision?: number; requestId: string; action: RunnerAction; issue?: number }
export interface AcceptedReviewerWaitIdentity {
  delivery_id: string;
  state_revision: number;
  workflow_status: "implementation_review" | "publication_pending";
  candidate_sha: string;
  manifest_digest: string;
  manifest_generation: number;
  producer_execution_id: string;
  producer_identity: string;
  criteria_digest: string;
  execution_id: string;
  external_id: string;
  packet_digest: string;
  proof_kind: string;
  proof_reference: string;
  proof_digest: string;
}

function requestDigest(input: RunnerControlInput): string { return digest({ repo: input.identity.repo, expected_revision: input.requestRevision ?? input.expectedRevision, action: input.action, issue: input.issue ?? null }); }
function executionRequiresDrain(execution: ExecutionState): boolean {
  if (["dispatching", "running"].includes(execution.status)) return true;
  if (execution.status !== "uncertain") return false;
  const authenticatedHandledObservation = execution.provider === "pi" && execution.effect === "unknown" && execution.terminal === "failed"
    && execution.proof?.kind === "no_ordinary_run" && typeof execution.proof_digest === "string" && /^[0-9a-f]{64}$/.test(execution.proof_digest);
  return !authenticatedHandledObservation;
}
export function deliveryRequiresDrain(state: DeliveryState | undefined): boolean { return Boolean(state && (["dispatching", "running"].includes(state.runner.status) || state.executions.some(executionRequiresDrain))); }
export function acceptedReviewerWaitIdentity(state: DeliveryState | undefined): AcceptedReviewerWaitIdentity | undefined {
  if (!state || state.claim_status !== "active" || !["implementation_review", "publication_pending"].includes(state.status)
    || state.controls.paused || state.controls.cancelled || state.controls.cancellation || state.receipts.engineering
    || ["running", "failed"].includes(state.runner.status)) return undefined;
  const manifest = state.manifests.implement, check = state.receipts.checks;
  const candidate = manifest?.value.result.candidate_sha;
  if (!manifest || typeof candidate !== "string" || typeof manifest.producer_execution_id !== "string" || typeof manifest.producer_identity !== "string" || manifest.producer_identity.length === 0
    || check?.status !== "success" || check.candidate_sha !== candidate || check.manifest_digest !== manifest.digest) return undefined;
  const criteriaDigest = digest({ delivery_id: state.delivery_id, issue: state.issue, candidate_sha: candidate, manifest_digest: manifest.digest,
    plan_digest: state.manifests.plan?.digest ?? null, producer_execution_id: manifest.producer_execution_id, producer_identity: manifest.producer_identity });
  const matching = state.executions.filter((execution) => {
    if (execution.kind !== "reviewer" || execution.stage !== "engineering_review" || !execution.packet || execution.packet_digest !== digest(execution.packet)) return false;
    const packet = execution.packet, criteria = packet.criteria;
    return packet.kind === "review" && packet.repo === state.repo && packet.delivery_id === state.delivery_id && packet.candidate_sha === candidate
      && packet.producer_execution_id === manifest.producer_execution_id && packet.producer_identity === manifest.producer_identity
      && criteria !== null && typeof criteria === "object" && !Array.isArray(criteria)
      && criteria.manifest_digest === manifest.digest && criteria.criteria_digest === criteriaDigest
      && (packet.manifest_generation === undefined || packet.manifest_generation === manifest.generation)
      && packet.task_id === execution.id;
  });
  if (matching.length !== 1) return undefined;
  const execution = matching[0]!;
  if (execution.status !== "running" || execution.effect !== "accepted" || execution.terminal !== "nonterminal" || execution.result
    || typeof execution.external_id !== "string" || typeof execution.packet_digest !== "string" || !execution.proof || typeof execution.proof_digest !== "string") return undefined;
  return {
    delivery_id: state.delivery_id, state_revision: state.revision, workflow_status: state.status as AcceptedReviewerWaitIdentity["workflow_status"], candidate_sha: candidate,
    manifest_digest: manifest.digest, manifest_generation: manifest.generation, producer_execution_id: manifest.producer_execution_id, producer_identity: manifest.producer_identity,
    criteria_digest: criteriaDigest, execution_id: execution.id, external_id: execution.external_id, packet_digest: execution.packet_digest,
    proof_kind: execution.proof.kind, proof_reference: execution.proof.reference, proof_digest: execution.proof_digest,
  };
}
function replayAfterRace(error: unknown, registry: RepositoryRegistry, input: RunnerControlInput, valueDigest: string): RunnerSession {
  if (error instanceof DeliveryError && error.code === "STALE_REVISION") { const current = registry.readSession(input.identity.repo), prior = current.requests[input.requestId]; if (prior) { requireCondition(prior.digest === valueDigest, "request ID was already used for different runner input", "REQUEST_CONFLICT"); return current; } }
  throw error;
}

export function runnerLaunchEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "DELIVERY_REGISTRY_DIR", "DELIVERY_OPERATOR_GRANT", "DELIVERY_RUNNER_POLL_MS"].flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]!]]));
}

function launchWorker(identity: RepositoryIdentity, session: RunnerSession, registry: RepositoryRegistry, token: string): RunnerSession {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", cli, "runner-worker", "--directory", identity.worktree, "--generation", String(session.generation), "--token", token], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: runnerLaunchEnvironment(),
  });
  child.unref();
  if (!child.pid) { registry.mutateSession(identity.repo, session.revision, (current) => { current.status = "uncertain"; current.reason = "Runner launch did not establish a process ID."; return current; }); throw new DeliveryError("repository runner could not start"); }
  const ownerProcessIdentity = processIdentity(child.pid);
  if (!ownerProcessIdentity) { registry.mutateSession(identity.repo, session.revision, (current) => { current.status = "uncertain"; current.owner_pid = child.pid!; current.reason = "Runner process exited before ownership acknowledgment."; return current; }); throw new DeliveryError("repository runner process identity could not be captured"); }
  return registry.mutateSession(identity.repo, session.revision, (current) => { requireCondition(current.generation === session.generation && current.owner_token_digest === digest(token), "runner launch reservation changed"); current.owner_pid = child.pid!; current.owner_process_identity = ownerProcessIdentity; return current; });
}

export function controlRunner(input: RunnerControlInput, registry = new RepositoryRegistry()): RunnerSession {
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId), "invalid request ID");
  const valueDigest = requestDigest(input); const prior = registry.readSession(input.identity.repo).requests[input.requestId];
  if (prior) { requireCondition(prior.digest === valueDigest, "request ID was already used for different runner input", "REQUEST_CONFLICT"); if (input.action !== "recover" || !["intent", "reconciled"].includes(prior.status ?? "")) return registry.readSession(input.identity.repo); }
  if (input.action === "start") {
    const binding = registry.readBinding(input.identity.repo); requireCondition(binding, "repository setup is incomplete");
    registry.admitProfile(input.identity, binding.profile_path, binding.state_dir);
    registry.assertNoLegacyForeground(input.identity.repo);
    assertNoForegroundSession(new FileStateStore(binding.state_dir), input.identity.repo);
    const scanned = new FileStateStore(binding.state_dir).scan(input.identity.repo); requireCondition(scanned.diagnostics.length === 0, "saved delivery state is unreadable; recover it explicitly before Start"); const unfinished = scanned.states.find((state) => state.claim_status === "active");
    requireCondition(!unfinished, "an unfinished delivery already exists; use Resume or Recover instead of Start");
    const token = newToken(24);
    let reserved: RunnerSession; try { reserved = registry.mutateSession(input.identity.repo, input.expectedRevision, (session) => {
      const observed = registry.observe(session); requireCondition(session.status === "stopped" || observed.status === "uncertain" && session.generation === 0, "repository runner is already active or requires recovery");
      if (session.cancellation) { requireCondition(session.cancellation.phase === "complete", "repository cancellation is not complete", "RUNNER_BARRIER"); (session.cancellation_history ??= []).push(structuredClone(session.cancellation)); delete session.cancellation; delete session.stopped_drained_ack_digest; }
      session.generation += 1; session.status = "starting"; session.desired_state = "running"; session.owner_pid = null; delete session.owner_process_identity; delete session.delivery_id; session.owner_token_digest = digest(token); session.owner_started_at = utcNow(); session.issue = input.issue ?? null; delete session.reason; session.requests[input.requestId] = { digest: valueDigest, action: input.action, revision: session.revision + 1, at: utcNow() }; return session;
    }); } catch (error) { return replayAfterRace(error, registry, input, valueDigest); }
    return launchWorker(input.identity, reserved, registry, token);
  }
  if (input.action === "recover") {
    const current = registry.readSession(input.identity.repo), observed = registry.observe(current); requireCondition(observed.status === "uncertain", "recovery requires lost or uncertain runner ownership");
    requireCondition(!current.in_flight, "runner has an unresolved transition; reconcile it before recovery");
    const binding = registry.readBinding(input.identity.repo); requireCondition(binding, "repository setup is incomplete");
    registry.admitProfile(input.identity, binding.profile_path, binding.state_dir);
    const stateFiles = new FileStateStore(binding.state_dir);
    const active = stateFiles.list(input.identity.repo).find((item: { claim_status: string }) => item.claim_status === "active");
    requireCondition(!active || !active.executions.some((execution: { status: string; external_id?: string }) => execution.status === "dispatching" || execution.status === "uncertain" || execution.status === "running" && !execution.external_id), "external execution must have a reconciled durable identity before runner recovery");
    const token = newToken(24);
    let reserved: RunnerSession; try { reserved = registry.mutateSession(input.identity.repo, input.expectedRevision, (session) => { session.generation += 1; session.status = "starting"; session.desired_state = "running"; session.owner_pid = null; delete session.owner_process_identity; session.owner_token_digest = digest(token); session.owner_started_at = utcNow(); session.requests[input.requestId] = { digest: valueDigest, action: input.action, revision: session.revision + 1, at: utcNow(), status: "completed" }; delete session.reason; return session; }); } catch (error) { return replayAfterRace(error, registry, input, valueDigest); }
    return launchWorker(input.identity, reserved, registry, token);
  }
  if (input.action === "resume") {
    const binding = registry.readBinding(input.identity.repo); requireCondition(binding, "repository setup is incomplete");
    registry.admitProfile(input.identity, binding.profile_path, binding.state_dir);
    const current = registry.readSession(input.identity.repo);
    if (current.status === "stopped") {
      const unfinished = new FileStateStore(binding.state_dir).list(input.identity.repo).find((state) => state.claim_status === "active"); requireCondition(unfinished, "stopped repository runner has no unfinished delivery");
      const token = newToken(24);
      let reserved: RunnerSession; try { reserved = registry.mutateSession(input.identity.repo, input.expectedRevision, (session) => { session.generation += 1; session.status = "starting"; session.desired_state = "running"; session.owner_pid = null; delete session.owner_process_identity; session.owner_token_digest = digest(token); session.owner_started_at = utcNow(); session.delivery_id = unfinished.delivery_id; session.requests[input.requestId] = { digest: valueDigest, action: input.action, revision: session.revision + 1, at: utcNow() }; delete session.reason; return session; }); } catch (error) { return replayAfterRace(error, registry, input, valueDigest); }
      return launchWorker(input.identity, reserved, registry, token);
    }
  }
  try { return registry.mutateSession(input.identity.repo, input.expectedRevision, (session) => {
    session.requests[input.requestId] = { digest: valueDigest, action: input.action, revision: session.revision + 1, at: utcNow() };
    const observed = registry.observe(session);
    if (input.action === "pause") { requireCondition(observed.status === "running" && observed.observedState === "alive", "pause requires a live running repository runner"); session.desired_state = "paused"; session.status = "pausing"; }
    else if (input.action === "resume") { requireCondition(observed.status === "paused" && observed.observedState === "alive", "resume requires a live paused repository runner"); session.desired_state = "running"; session.status = "running"; }
    else { requireCondition(observed.observedState === "alive" || session.status === "blocked", "stop requires live ownership or an explicitly blocked runner"); session.desired_state = "stopped"; session.status = observed.observedState === "alive" ? "stopping" : "stopped"; if (session.status === "stopped") { session.owner_pid = null; delete session.owner_process_identity; } }
    return session;
  }); } catch (error) { return replayAfterRace(error, registry, input, valueDigest); }
}

export function requestOwnedRunnerStop(input: { identity: RepositoryIdentity; generation: number; token: string; ownerProcessIdentity: string; requestRevision: number; requestId: string }, registry = new RepositoryRegistry()): RunnerSession {
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId), "invalid request ID");
  const control: RunnerControlInput = { identity: input.identity, expectedRevision: 0, requestRevision: input.requestRevision, requestId: input.requestId, action: "stop" };
  const valueDigest = requestDigest(control), current = registry.readSession(input.identity.repo), prior = current.requests[input.requestId];
  if (prior) { requireCondition(prior.digest === valueDigest, "request ID was already used for different runner input", "REQUEST_CONFLICT"); return current; }
  return registry.mutateSession(input.identity.repo, current.revision, (session) => {
    requireCondition(session.generation === input.generation && session.owner_token_digest === digest(input.token) && session.owner_pid === process.pid && session.owner_process_identity === input.ownerProcessIdentity, "repository runner ownership changed");
    if (session.cancellation || session.desired_state === "stopped") return session;
    session.requests[input.requestId] = { digest: valueDigest, action: "stop", revision: session.revision + 1, at: utcNow() };
    session.desired_state = "stopped"; session.status = "stopping";
    return session;
  });
}


export function assertWorkerOwnership(registry: RepositoryRegistry, repo: string, generation: number, token: string): RunnerSession {
  const session = registry.readSession(repo); requireCondition(session.generation === generation && session.owner_token_digest === digest(token) && session.owner_pid === process.pid && session.owner_process_identity === processIdentity(process.pid), "repository runner ownership changed"); return session;
}

export function reserveRunnerTransition(registry: RepositoryRegistry, repo: string, generation: number, token: string, allowStopping = false): RunnerSession | undefined {
  const current = assertWorkerOwnership(registry, repo, generation, token);
  if (current.operation || current.cancellation || current.in_flight) return undefined;
  if (current.desired_state === "stopped" && !allowStopping) { registry.mutateSession(repo, current.revision, (session) => { session.status = "stopped"; session.owner_pid = null; delete session.owner_process_identity; session.stopped_drained_ack_digest = digest({ repo, generation, owner_token_digest: digest(token), at: utcNow() }); session.heartbeat_at = utcNow(); return session; }); return undefined; }
  if (current.desired_state === "paused") { if (current.status !== "paused") registry.mutateSession(repo, current.revision, (session) => { session.status = "paused"; session.heartbeat_at = utcNow(); return session; }); return undefined; }
  const reservation = newToken(16);
  return registry.reserveWorkerTransition(repo, generation, digest(token), reservation, allowStopping);
}

export function finishRunnerTransition(registry: RepositoryRegistry, repo: string, generation: number, token: string, reservation: string, deliveryId?: string): RunnerSession {
  assertWorkerOwnership(registry, repo, generation, token); return registry.finishReservation(repo, reservation, deliveryId);
}
