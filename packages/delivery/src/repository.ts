import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { DeliveryError, digest, newToken, repoIdentity, requireCondition, utcNow } from "./core.ts";
import { defaultProfilePath, loadBoundProfile, loadLocalProfile, loadPublisherConfig, profileResources, type ConfiguredRepositorySource, type LocalProfile } from "./config.ts";
import { FileStateStore } from "./store.ts";
import { assertNoForegroundSession, foregroundSessionPath, loadForegroundPolicy } from "./foreground.ts";
export { processIdentity, processOwnershipLost } from "./process-identity.ts";
import { processIdentity, processOwnership, processOwnershipLost } from "./process-identity.ts";
import { resolveRepository, type RepositoryIdentity } from "./repository-identity.ts";
import type { RepositoryCancellationFence } from "./ports.ts";
import { hashPackage } from "./pins.ts";
import { ensurePrivateDirectorySync, type DirectoryIdentity } from "./locks.ts";
export { resolveRepository, type RepositoryIdentity } from "./repository-identity.ts";

export function repositoryScopeDigest(identity: RepositoryIdentity, bindingRevision: number): string { return digest({ repo: identity.repo, worktree: identity.worktree, common_dir: identity.commonDir, binding_revision: bindingRevision }); }

export interface RepositoryBinding {
  schema_version: 1;
  repo: string;
  revision: number;
  profile_path: string;
  state_dir: string;
  publisher_state_root?: string;
  configured_sources?: { executor?: ConfiguredRepositorySource; reviewer?: ConfiguredRepositorySource };
  created_at: string;
  updated_at: string;
  requests?: Record<string, string>;
}

export interface ReservationOwner { token: string; started_at: string; owner_pid: number; owner_process_identity: string }
export interface WorkerReservation extends ReservationOwner { kind: "worker"; generation: number; owner_token_digest: string; phase: "reserved" | "effect"; effect_admission?: "running" | "stopping_drain"; delivery_id?: string; operation_id?: string }
export interface CommandReservation extends ReservationOwner { kind: "command"; action: string; delivery_id: string; request_id: string; input_digest: string; expected_revision?: number; draft_digest?: string; phase: "reserved" | "effect"; effect_admission?: "running" | "stopped_explicit"; operation_id?: string }
export type OperationReservation = WorkerReservation | CommandReservation;
export interface CancellationReservation extends ReservationOwner { kind: "cancellation"; delivery_id: string; request_id: string; input_digest: string; expected_revision: number; epoch: string; phase: "requested" | "reconciling" | "draining" | "complete"; generation: number; owner_token_digest: string; acknowledgement_digest?: string; completed_at?: string }
export interface CommandReservationInput { action: string; delivery_id: string; request_id: string; input_digest: string; expected_revision?: number; draft_digest?: string; allow_stopped?: boolean; reconcile_effect?: boolean }
export interface CancellationRollbackSnapshot extends Pick<RunnerSession, "status" | "desired_state" | "reason" | "cancellation" | "stopped_drained_ack_digest"> { reserved_revision: number }
export interface CancellationReservationResult extends RunnerSession { reservation: CancellationReservation; rollback_snapshot?: CancellationRollbackSnapshot; replayed?: boolean }
export type CancellationFenceExpectation = Omit<RepositoryCancellationFence, "stopped_drained_ack_digest">;
export interface DeadCancellationRecoveryExpectation {
  recovery_token: string;
  request_id: string;
  operation_token: string;
  operation_id: string;
  delivery_id: string;
  generation: number;
  owner_token_digest: string;
  owner_pid: number;
  owner_process_identity: string;
  cancellation_token: string;
  cancellation_request_id: string;
  cancellation_input_digest: string;
  cancellation_expected_revision: number;
  cancellation_epoch: string;
}
export interface ProfileAdmission { schema_version: 1; repo: string; profile_path: string; publisher_config_path?: string; state_dir: string; publisher_state_root: string; configured_sources: { executor?: ConfiguredRepositorySource; reviewer?: ConfiguredRepositorySource }; admitted_at: string }

interface LegacyForegroundOwner {
  schema_version: 1;
  repo: string;
  state_dir: string;
  pid: number;
  process_identity: string;
  token: string;
  started_at: string;
}

export type RunnerStatus = "starting" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "blocked" | "uncertain";
export interface RunnerSession {
  schema_version: 1;
  repo: string;
  revision: number;
  generation: number;
  status: RunnerStatus;
  desired_state: "running" | "paused" | "stopped";
  owner_pid: number | null;
  owner_process_identity?: string;
  owner_token_digest?: string;
  owner_started_at?: string;
  heartbeat_at?: string;
  delivery_id?: string;
  issue?: number | null;
  in_flight?: { token: string; started_at: string };
  operation?: OperationReservation;
  cancellation?: CancellationReservation;
  cancellation_history?: CancellationReservation[];
  stopped_drained_ack_digest?: string;
  recovery?: { token: string; started_at: string; owner_pid: number; owner_process_identity: string };
  reason?: string;
  requests: Record<string, { digest: string; action: string; revision: number; at: string; status?: "intent" | "reconciled" | "completed" }>;
}

function validateExistingRegistryAncestors(path: string): void {
  const filesystemRoot = parse(path).root, euid = process.geteuid?.(); let current = filesystemRoot;
  for (const component of path.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
    current = join(current, component); if (!existsSync(current)) return;
    const info = lstatSync(current); let effective = info;
    if (info.isSymbolicLink()) { requireCondition(info.uid === 0, `unsafe state path component: ${current}`); effective = statSync(current); }
    requireCondition(effective.isDirectory(), `unsafe state path component: ${current}`);
    requireCondition(euid === undefined || effective.uid === euid || effective.uid === 0, `state path component has unsafe ownership: ${current}`);
    requireCondition((effective.mode & 0o022) === 0 || (effective.mode & 0o1000) !== 0, `state path component is writable by other users: ${current}`);
  }
}

export class RepositoryRegistry {
  readonly root: string;
  #rootDirectoryIdentity: DirectoryIdentity | undefined;
  constructor(root = process.env.DELIVERY_REGISTRY_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "codex-toolkit", "delivery-v2")) {
    requireCondition(isAbsolute(root), "repository registry path must be absolute");
    this.root = resolve(root);
    validateExistingRegistryAncestors(this.root);
    if (existsSync(this.root)) this.#rootDirectoryIdentity = ensurePrivateDirectorySync(this.root);
  }
  private assertRoot(create = false): boolean {
    if (this.#rootDirectoryIdentity) { ensurePrivateDirectorySync(this.root, this.#rootDirectoryIdentity); return true; }
    validateExistingRegistryAncestors(this.root);
    if (!existsSync(this.root) && !create) return false;
    this.#rootDirectoryIdentity = ensurePrivateDirectorySync(this.root); return true;
  }
  private ensureDirectory(path: string): void { this.assertRoot(true); ensurePrivateDirectorySync(path); this.assertRoot(); }
  private atomic(path: string, value: unknown): void {
    this.assertRoot(true); this.ensureDirectory(dirname(path));
    const temporary = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.${newToken(6)}`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    this.assertRoot(); ensurePrivateDirectorySync(dirname(path)); renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private readPrivate(path: string): Record<string, unknown> {
    requireCondition(this.assertRoot(), "repository registry does not exist"); validateExistingRegistryAncestors(dirname(path)); const stat = lstatSync(path);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 256 * 1024, "repository registry record is unsafe");
    this.assertRoot(); validateExistingRegistryAncestors(dirname(path)); const value = JSON.parse(readFileSync(path, "utf8"));
    requireCondition(value && typeof value === "object" && !Array.isArray(value), "repository registry record must be an object");
    return value as Record<string, unknown>;
  }
  private lockStore(): FileStateStore { this.assertRoot(true); return new FileStateStore(join(this.root, "locks")); }
  private repoDir(repo: string): string { repoIdentity(repo); return join(this.root, "repositories", digest(repoIdentity(repo))); }
  bindingPath(repo: string): string { return join(this.repoDir(repo), "binding.json"); }
  sessionPath(repo: string): string { return join(this.repoDir(repo), "runner.json"); }
  piSessionOwnersDir(): string { return join(this.root, "pi-session-owners"); }
  private admissionPath(root: string): string { return join(this.root, "resource-admissions", `${digest(root)}.json`); }
  legacyForegroundPath(repo: string): string { return join(this.repoDir(repo), "legacy-foreground.json"); }
  generatedProfilePath(repo: string): string { return join(this.repoDir(repo), "configuration", "profile.json"); }
  generatedForegroundPath(repo: string): string { return join(this.repoDir(repo), "configuration", "foreground.json"); }
  generatedStateDir(repo: string): string { return join(this.repoDir(repo), "state"); }
  writeConfiguration(path: string, value: unknown): void { this.atomic(path, value); }
  recoverMutationLock(repo: string): boolean { return this.lockStore().recoverRepoLock(repo); }
  readBinding(repo: string): RepositoryBinding | undefined {
    if (!this.assertRoot()) return undefined;
    const path = this.bindingPath(repo); if (!existsSync(path)) return undefined;
    const value = this.readPrivate(path); requireCondition(value.schema_version === 1 && value.repo === repo && Number.isInteger(value.revision) && typeof value.profile_path === "string" && typeof value.state_dir === "string", "invalid repository binding");
    return value as unknown as RepositoryBinding;
  }
  private readAdmission(root: string): ProfileAdmission | undefined {
    if (!this.assertRoot()) return undefined;
    const path = this.admissionPath(root); if (!existsSync(path)) return undefined;
    const value = this.readPrivate(path);
    requireCondition(value.schema_version === 1 && typeof value.repo === "string" && typeof value.profile_path === "string" && (value.publisher_config_path === undefined || typeof value.publisher_config_path === "string") && typeof value.state_dir === "string" && value.publisher_state_root === root && typeof value.admitted_at === "string", "invalid shared resource admission");
    return value as unknown as ProfileAdmission;
  }
  private bindings(): RepositoryBinding[] {
    if (!this.assertRoot()) return [];
    const root = join(this.root, "repositories"); if (!existsSync(root)) return [];
    validateExistingRegistryAncestors(root);
    const result: RepositoryBinding[] = [];
    for (const name of readdirSync(root)) {
      const path = join(root, name, "binding.json"); if (!existsSync(path)) continue;
      try { result.push(this.readPrivate(path) as unknown as RepositoryBinding); }
      catch { throw new Error("an unreadable legacy binding prevents shared resource admission until explicit recovery"); }
    }
    return result;
  }
  private assertPublisherRootAvailable(root: string, repo: string, profilePath: string, publisherConfigPath?: string): void {
    for (const binding of this.bindings()) {
      let protectedRoot = binding.publisher_state_root;
      if (!protectedRoot) {
        try {
          const legacy = loadLocalProfile(binding.profile_path);
          requireCondition(legacy.repository === binding.repo && legacy.state_dir === binding.state_dir, "legacy binding profile identity changed", "RUNNER_BARRIER");
          const scan = new FileStateStore(binding.state_dir).scan(binding.repo), currentPublisherDigest = hashPackage(legacy.publisher_config);
          requireCondition(scan.diagnostics.length === 0, "legacy binding state inventory is unreadable", "RUNNER_BARRIER");
          const historicalPins = scan.states.filter((state) => state.pins.locations.profile === binding.profile_path), resources = profileResources(legacy, binding.repo);
          if (historicalPins.length) requireCondition(historicalPins.every((state) => state.pins.locations.publisher_config === legacy.publisher_config && state.pins.artifacts.publisher_config === currentPublisherDigest), "legacy binding historical publisher provenance changed", "RUNNER_BARRIER");
          else {
            const proposals = join(new FileStateStore(binding.state_dir).repoDir(binding.repo), "proposals"), protectedSetupLedger = binding.requests !== undefined && Object.keys(binding.requests).length > 0 && Object.values(binding.requests).every((value) => typeof value === "string" && value.length > 0);
            const noProposalResidue = !existsSync(proposals) || readdirSync(proposals).length === 0, noPublisherResidue = !existsSync(resources.publisher_state_root) || readdirSync(resources.publisher_state_root).length === 0;
            requireCondition(protectedSetupLedger && !existsSync(this.sessionPath(binding.repo)) && scan.states.length === 0 && noProposalResidue && noPublisherResidue, "legacy binding lacks exact historical publisher provenance; protected never-started provenance is absent and explicit recovery is required", "RUNNER_BARRIER");
          }
          protectedRoot = resources.publisher_state_root;
        } catch (error) {
          if (error instanceof DeliveryError) throw error;
          throw new Error(`legacy binding for ${binding.repo} has unknown publisher ownership; explicit same-profile migration is required before shared resource admission`);
        }
      }
      if (protectedRoot !== root) continue;
      requireCondition(binding.repo === repo && binding.profile_path === profilePath, `publisher state root is already frozen for ${binding.repo}`, "RUNNER_BARRIER");
    }
    const admitted = this.readAdmission(root);
    const requestedSource = publisherConfigPath ?? profilePath, admittedSource = admitted?.publisher_config_path ?? admitted?.profile_path;
    requireCondition(!admitted || admitted.repo === repo && admittedSource === requestedSource, `publisher state root is already admitted for ${admitted?.repo ?? "another repository"}`, "RUNNER_BARRIER");
  }
  private resolvedAdmission(identity: RepositoryIdentity, profilePath: string, expectedStateDir?: string): { profile: LocalProfile; admission: ProfileAdmission } {
    const canonical = realpathSync(profilePath), local = loadLocalProfile(canonical);
    const profile = loadBoundProfile(canonical, identity, expectedStateDir ?? local.state_dir), resources = profileResources(profile, identity.repo);
    return { profile, admission: { schema_version: 1, repo: identity.repo, profile_path: canonical, publisher_config_path: profile.publisher_config, state_dir: profile.state_dir, publisher_state_root: resources.publisher_state_root, configured_sources: resources.configured_sources, admitted_at: utcNow() } };
  }
  admitProfile(identity: RepositoryIdentity, profilePath: string, expectedStateDir?: string): { profile: LocalProfile; admission: ProfileAdmission } {
    return this.lockStore().withRepoLock("registry/bindings", () => this.lockStore().withRepoLock(identity.repo, () => {
      const resolved = this.resolvedAdmission(identity, profilePath, expectedStateDir), binding = this.readBinding(identity.repo);
      if (binding) {
        requireCondition(binding.profile_path === resolved.admission.profile_path && binding.state_dir === resolved.admission.state_dir, "profile does not match the frozen repository binding", "RUNNER_BARRIER");
        requireCondition(typeof binding.publisher_state_root === "string", "legacy repository binding requires explicit same-profile migration before effects", "RUNNER_BARRIER");
        requireCondition(binding.publisher_state_root === resolved.admission.publisher_state_root, "bound publisher state root changed", "RUNNER_BARRIER");
        requireCondition(JSON.stringify(binding.configured_sources ?? {}) === JSON.stringify(resolved.admission.configured_sources), "bound configured source identity changed", "RUNNER_BARRIER");
      }
      this.assertPublisherRootAvailable(resolved.admission.publisher_state_root, identity.repo, resolved.admission.profile_path, resolved.profile.publisher_config);
      const prior = this.readAdmission(resolved.admission.publisher_state_root);
      if (!prior) this.atomic(this.admissionPath(resolved.admission.publisher_state_root), resolved.admission);
      return { profile: resolved.profile, admission: prior ?? resolved.admission };
    }));
  }
  admitPublisherConfig(identity: RepositoryIdentity, publisherConfigPath: string, stateDir: string): ProfileAdmission {
    return this.lockStore().withRepoLock("registry/bindings", () => this.lockStore().withRepoLock(identity.repo, () => {
      requireCondition(!this.readBinding(identity.repo), "repository is managed by the durable runner; use runner-control or workspace-command", "RUNNER_BARRIER");
      this.assertNoLegacyForeground(identity.repo);
      const selected = loadPublisherConfig(realpathSync(publisherConfigPath), identity.repo), protectedStateDir = new FileStateStore(stateDir).root;
      this.assertPublisherRootAvailable(selected.publisher_state_root, identity.repo, selected.publisher_config_path, selected.publisher_config_path);
      const prior = this.readAdmission(selected.publisher_state_root);
      const admission: ProfileAdmission = { schema_version: 1, repo: identity.repo, profile_path: selected.publisher_config_path, publisher_config_path: selected.publisher_config_path, state_dir: protectedStateDir, publisher_state_root: selected.publisher_state_root, configured_sources: {}, admitted_at: utcNow() };
      if (!prior) this.atomic(this.admissionPath(selected.publisher_state_root), admission);
      return prior ?? admission;
    }));
  }
  validateBoundProfile(identity: RepositoryIdentity, binding: RepositoryBinding): { profile: LocalProfile; admission: ProfileAdmission } {
    const resolved = this.resolvedAdmission(identity, binding.profile_path, binding.state_dir);
    requireCondition(typeof binding.publisher_state_root === "string", "legacy repository binding requires explicit same-profile migration before effects", "RUNNER_BARRIER");
    requireCondition(binding.publisher_state_root === resolved.admission.publisher_state_root, "bound publisher state root changed", "RUNNER_BARRIER");
    requireCondition(JSON.stringify(binding.configured_sources ?? {}) === JSON.stringify(resolved.admission.configured_sources), "bound configured source identity changed", "RUNNER_BARRIER");
    return resolved;
  }
  bindingForStateDir(stateDir: string): RepositoryBinding | undefined {
    if (!this.assertRoot()) return undefined;
    const root = join(this.root, "repositories"); if (!existsSync(root)) return undefined;
    validateExistingRegistryAncestors(root);
    const canonical = resolve(stateDir); let found: RepositoryBinding | undefined;
    for (const name of readdirSync(root)) {
      const path = join(root, name, "binding.json"); if (!existsSync(path)) continue;
      const value = this.readPrivate(path) as unknown as RepositoryBinding;
      if (value.state_dir !== canonical) continue;
      requireCondition(!found || found.repo === value.repo, "state root is bound to multiple repositories"); found = value;
    }
    return found;
  }
  readLegacyForeground(repo: string): LegacyForegroundOwner | undefined {
    if (!this.assertRoot()) return undefined;
    const path = this.legacyForegroundPath(repo); if (!existsSync(path)) return undefined;
    const value = this.readPrivate(path);
    requireCondition(value.schema_version === 1 && value.repo === repo && typeof value.state_dir === "string" && Number.isInteger(value.pid) && typeof value.process_identity === "string" && typeof value.token === "string" && typeof value.started_at === "string", "invalid repository legacy foreground owner");
    return value as unknown as LegacyForegroundOwner;
  }
  assertNoLegacyForeground(repo: string): void {
    const owner = this.readLegacyForeground(repo);
    requireCondition(!owner, `legacy foreground ownership is active or ambiguous for ${repo}${owner ? ` at ${owner.state_dir}` : ""}; cleanly stop it before repository runner setup or Start`, "RUNNER_BARRIER");
  }
  private assertLegacyStateClear(owner: LegacyForegroundOwner): void {
    const scan = new FileStateStore(owner.state_dir).scan(owner.repo);
    requireCondition(scan.diagnostics.length === 0, "legacy foreground state is unreadable; recover it with the original protected profile before ownership recovery", "RUNNER_BARRIER");
    const unresolved = scan.states.find((state) => state.claim_status === "active" || state.unresolved_effects.length > 0
      || state.executions.some((execution) => ["dispatching", "running", "uncertain"].includes(execution.status))
      || state.operations.some((operation) => ["intent", "accepted", "uncertain"].includes(operation.status)));
    requireCondition(!unresolved, `legacy foreground state ${unresolved?.delivery_id ?? "unknown"} is unfinished or has unresolved external effects; recover or cancel it with the original protected profile before changing repository state roots`, "RUNNER_BARRIER");
  }
  recoverLegacyForeground(repo: string): boolean {
    const locks = this.lockStore();
    // A foreground killed inside its guarded acquire callback can leave both
    // registry mutexes behind. Explicit recovery first proves and quarantines
    // the global owner, then holds the replacement global mutex while doing the
    // same for the repository mutex, preserving the normal lock order.
    locks.recoverRepoLock("registry/bindings");
    return locks.withRepoLock("registry/bindings", () => {
      locks.recoverRepoLock(repo);
      return locks.withRepoLock(repo, () => {
      const owner = this.readLegacyForeground(repo); if (!owner) return false;
      requireCondition(processOwnership(owner.pid, owner.process_identity) === "lost", "legacy foreground recovery requires proven lost process ownership", "RUNNER_BARRIER");
      requireCondition(isAbsolute(owner.state_dir) && resolve(owner.state_dir) === owner.state_dir, "legacy foreground state root is invalid");
      this.assertLegacyStateClear(owner);
      const store = new FileStateStore(owner.state_dir), session = foregroundSessionPath(store, repo), ownerPath = join(session, "owner.json");
      if (existsSync(session)) {
        if (existsSync(ownerPath)) {
          const local = store.readProtected(ownerPath);
          requireCondition(local.schema_version === 1 && local.repo === repo && local.pid === owner.pid && local.process_identity === owner.process_identity && typeof local.token === "string", "legacy foreground local ownership does not match the repository reservation", "RUNNER_BARRIER");
          unlinkSync(ownerPath);
        }
        requireCondition(readdirSync(session).length === 0, "legacy foreground session contains unresolved ownership data", "RUNNER_BARRIER");
        // The exact dead owner was proven above and no local data remains.
        // rmdirSync is intentionally used instead of recursive deletion.
        rmdirSync(session);
      }
      const current = this.readLegacyForeground(repo); requireCondition(current?.token === owner.token && current.process_identity === owner.process_identity, "legacy foreground reservation changed during recovery", "RUNNER_BARRIER");
      unlinkSync(this.legacyForegroundPath(repo)); return true;
      });
    });
  }
  private legacyMigrationProven(binding: RepositoryBinding, profile: LocalProfile): boolean {
    const sessionPersisted = existsSync(this.sessionPath(binding.repo)), session = this.readSession(binding.repo);
    requireCondition(!session.operation && !session.cancellation && !session.in_flight && !session.recovery && !session.owner_pid, "active runner or reservation blocks legacy binding migration", "RUNNER_BARRIER");
    const store = new FileStateStore(binding.state_dir), scan = store.scan(binding.repo);
    requireCondition(scan.diagnostics.length === 0, "legacy state inventory is unreadable; migration requires protected provenance", "RUNNER_BARRIER");
    const publisherDigest = hashPackage(profile.publisher_config);
    const historical = scan.states.some((state) => state.pins.locations.profile === binding.profile_path
      && state.pins.locations.publisher_config === profile.publisher_config
      && state.pins.artifacts.publisher_config === publisherDigest);
    if (historical) return true;
    const proposals = join(store.repoDir(binding.repo), "proposals"), publisherRoot = profileResources(profile, binding.repo).publisher_state_root;
    const noProposalResidue = !existsSync(proposals) || readdirSync(proposals).length === 0;
    const noPublisherResidue = !existsSync(publisherRoot) || readdirSync(publisherRoot).length === 0;
    const protectedSetupLedger = binding.requests !== undefined && Object.keys(binding.requests).length > 0 && Object.values(binding.requests).every((value) => typeof value === "string" && value.length > 0);
    const neverStarted = protectedSetupLedger && !sessionPersisted && session.generation === 0 && Object.keys(session.requests).length === 0 && scan.states.length === 0 && noProposalResidue && noPublisherResidue;
    requireCondition(neverStarted, "legacy binding lacks exact historical publisher provenance; protected never-started provenance is absent and explicit recovery is required", "RUNNER_BARRIER");
    return true;
  }
  bind(identity: RepositoryIdentity, profilePath: string, expectedRevision: number, requestId?: string, configure?: () => void): RepositoryBinding {
    // Binding is registry-global because two repositories must never acquire the
    // same durable state root concurrently.
    try { this.lockStore().recoverRepoLock("registry/bindings"); }
    catch (error) {
      // A live setup/legacy owner is ordinary contention: wait on the lock so
      // the subsequent checks observe its committed reservation. Unknown lock
      // ownership remains fail-closed, and a proven dead owner is recovered.
      if (!(error instanceof Error) || error.message !== "lock owner is still alive") throw error;
    }
    return this.lockStore().withRepoLock("registry/bindings", () => this.lockStore().withRepoLock(identity.repo, () => {
      const requested = resolve(profilePath), current = this.readBinding(identity.repo);
      if (current && requestId && current.requests?.[requestId]) {
        const profile = loadBoundProfile(current.profile_path, identity, current.state_dir), requestDigest = digest({ repo: identity.repo, profile_path: realpathSync(requested), state_dir: profile.state_dir, ...(current.publisher_state_root ? { publisher_state_root: current.publisher_state_root } : {}) });
        requireCondition(current.requests[requestId] === requestDigest, "request ID was already used for different setup input", "REQUEST_CONFLICT"); return current;
      }
      requireCondition((current?.revision ?? 0) === expectedRevision, `stale setup revision: current ${current?.revision ?? 0}`, "STALE_REVISION");
      requireCondition(!current?.publisher_state_root, "repository setup is immutable; use its existing protected binding");
      this.assertNoLegacyForeground(identity.repo);
      if (!current) configure?.();
      const canonical = realpathSync(requested);
      const loaded = loadLocalProfile(canonical), profile = loadBoundProfile(canonical, identity, loaded.state_dir);
      const resources = profileResources(profile, identity.repo);
      const foreground = loadForegroundPolicy(profile.foreground_policy, identity.repo); requireCondition(foreground.auto_schedule === false, "repository setup requires unattended scheduling off");
      assertNoForegroundSession(new FileStateStore(profile.state_dir), identity.repo);
      const collision = this.bindingForStateDir(profile.state_dir); requireCondition(!collision || collision.repo === identity.repo, "state root is already bound to another repository");
      this.assertPublisherRootAvailable(resources.publisher_state_root, identity.repo, canonical, profile.publisher_config);
      const requestDigest = digest({ repo: identity.repo, profile_path: canonical, state_dir: profile.state_dir, publisher_state_root: resources.publisher_state_root }), now = utcNow();
      if (current) {
        requireCondition(current.profile_path === canonical && current.state_dir === profile.state_dir, "legacy migration requires the exact bound profile and state root", "RUNNER_BARRIER");
        this.legacyMigrationProven(current, profile);
      }
      const next: RepositoryBinding = { schema_version: 1, repo: identity.repo, revision: (current?.revision ?? 0) + 1, profile_path: canonical, state_dir: profile.state_dir,
        publisher_state_root: resources.publisher_state_root, configured_sources: resources.configured_sources,
        created_at: current?.created_at ?? now, updated_at: now, requests: { ...(current?.requests ?? {}), ...(requestId ? { [requestId]: requestDigest } : {}) } };
      this.atomic(this.bindingPath(identity.repo), next); return next;
    }));
  }
  withLegacyForegroundGuard(repo: string, stateDir: string, acquire: () => void): () => void {
    const token = newToken(24), identity = processIdentity(process.pid);
    requireCondition(identity, "foreground process identity is unavailable");
    const owner: LegacyForegroundOwner = { schema_version: 1, repo, state_dir: resolve(stateDir), pid: process.pid, process_identity: identity, token, started_at: utcNow() };
    this.lockStore().withRepoLock("registry/bindings", () => this.lockStore().withRepoLock(repo, () => {
      requireCondition(!this.readBinding(repo), "repository is managed by the durable runner; use runner-control", "RUNNER_BARRIER");
      this.assertNoLegacyForeground(repo);
      this.atomic(this.legacyForegroundPath(repo), owner);
      try { acquire(); }
      catch (error) { const current = this.readLegacyForeground(repo); if (current?.token === token && current.process_identity === identity) unlinkSync(this.legacyForegroundPath(repo)); throw error; }
    }));
    return () => this.lockStore().withRepoLock("registry/bindings", () => this.lockStore().withRepoLock(repo, () => {
      const current = this.readLegacyForeground(repo);
      requireCondition(current?.token === token && current.pid === process.pid && current.process_identity === identity, "legacy foreground ownership changed; preserving ambiguous reservation", "RUNNER_BARRIER");
      this.assertLegacyStateClear(current);
      unlinkSync(this.legacyForegroundPath(repo));
    }));
  }
  readSession(repo: string): RunnerSession {
    if (!this.assertRoot()) return { schema_version: 1, repo, revision: 0, generation: 0, status: "stopped", desired_state: "stopped", owner_pid: null, requests: {} };
    const path = this.sessionPath(repo); if (!existsSync(path)) return { schema_version: 1, repo, revision: 0, generation: 0, status: "stopped", desired_state: "stopped", owner_pid: null, requests: {} };
    const value = this.readPrivate(path); requireCondition(value.schema_version === 1 && value.repo === repo && Number.isInteger(value.revision) && Number.isInteger(value.generation) && typeof value.status === "string" && typeof value.desired_state === "string" && value.requests && typeof value.requests === "object", "invalid repository runner state");
    return value as unknown as RunnerSession;
  }
  mutateSession(repo: string, expectedRevision: number | undefined, update: (session: RunnerSession) => RunnerSession): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo); if (expectedRevision !== undefined) requireCondition(current.revision === expectedRevision, `stale runner revision: current ${current.revision}`, "STALE_REVISION");
      const next = update(structuredClone(current)); requireCondition(next.repo === repo && next.generation >= current.generation, "runner mutation changed repository or generation"); next.revision = current.revision + 1; this.atomic(this.sessionPath(repo), next); return next;
    });
  }
  heartbeatRecovery(repo: string, token: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), recovery = current.recovery;
      requireCondition(recovery?.token === token && recovery.owner_pid === process.pid && recovery.owner_process_identity === processIdentity(process.pid), "runner recovery ownership changed", "RUNNER_BARRIER");
      current.heartbeat_at = utcNow(); this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  heartbeatWorker(repo: string, generation: number, ownerTokenDigest: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo);
      requireCondition(current.generation === generation && current.owner_token_digest === ownerTokenDigest && current.owner_pid === process.pid && current.owner_process_identity === processIdentity(process.pid), "repository runner ownership changed");
      current.heartbeat_at = utcNow(); this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  recordWorkerDiagnostic(repo: string, generation: number, ownerTokenDigest: string, ownerProcessIdentity: string, error: unknown): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo);
      requireCondition(current.generation === generation && current.owner_token_digest === ownerTokenDigest && current.owner_pid === process.pid && current.owner_process_identity === ownerProcessIdentity, "repository runner ownership changed", "RUNNER_BARRIER");
      const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500), status = current.cancellation && current.desired_state === "stopped" ? "stopping" : current.status;
      if (current.reason === reason && current.status === status) return current;
      current.reason = reason; current.status = status; current.heartbeat_at = utcNow();
      current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  recordWorkerExitFailure(repo: string, generation: number, ownerTokenDigest: string, ownerProcessIdentity: string, error: unknown): RunnerSession | undefined {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo);
      if (current.generation !== generation || current.owner_token_digest !== ownerTokenDigest || current.owner_pid !== process.pid || current.owner_process_identity !== ownerProcessIdentity) return undefined;
      current.reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 500);
      current.heartbeat_at = utcNow();
      if (current.operation || current.cancellation) current.status = "uncertain";
      else {
        current.owner_pid = null; delete current.owner_process_identity;
        current.status = current.desired_state === "stopped" ? "stopped" : "blocked";
        if (current.status === "stopped") delete current.reason;
      }
      current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  acknowledgeWorkerReady(repo: string, generation: number, ownerTokenDigest: string, deliveryId: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo);
      requireCondition(current.generation === generation && current.owner_token_digest === ownerTokenDigest && current.owner_pid === process.pid && current.owner_process_identity === processIdentity(process.pid), "repository runner ownership changed");
      requireCondition(current.delivery_id === deliveryId, "repository runner delivery changed", "RUNNER_BARRIER");
      if (current.status !== "starting" || current.desired_state !== "running" || current.operation || current.cancellation || current.recovery || current.in_flight) return current;
      current.revision += 1; current.status = "running"; current.heartbeat_at = utcNow(); this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  reserveWorkerTransition(repo: string, generation: number, ownerTokenDigest: string, reservation: string, allowStopping = false): RunnerSession | undefined {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo);
      requireCondition(current.generation === generation && current.owner_token_digest === ownerTokenDigest && current.owner_pid === process.pid && current.owner_process_identity === processIdentity(process.pid), "repository runner ownership changed");
      if (current.desired_state !== "running" && !(allowStopping && current.desired_state === "stopped") || current.operation || current.cancellation || current.in_flight) return undefined;
      const effectAdmission = current.desired_state === "stopped" ? "stopping_drain" : "running";
      current.revision += 1; current.status = current.desired_state === "stopped" ? "stopping" : "running"; current.heartbeat_at = utcNow(); current.operation = { kind: "worker", token: reservation, started_at: utcNow(), owner_pid: process.pid, owner_process_identity: current.owner_process_identity!, generation, owner_token_digest: ownerTokenDigest, phase: "reserved", effect_admission: effectAdmission, ...(current.delivery_id ? { delivery_id: current.delivery_id } : {}) }; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  reserveCommand(repo: string, input: CommandReservationInput): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo); const observed = this.observe(current);
      const coordinated = current.desired_state === "running" && observed.status === "running" || input.allow_stopped === true && current.desired_state === "stopped" && observed.status === "stopped";
      requireCondition(!current.cancellation && !current.recovery && !current.in_flight, `repository runner barrier blocks command reconciliation (${current.status}/${current.desired_state}/${observed.status}/${observed.observedState})`, "RUNNER_BARRIER");
      if (current.operation) {
        requireCondition(current.operation.kind === "command" && current.operation.request_id === input.request_id && current.operation.input_digest === input.input_digest, "another repository operation is reserved", "RUNNER_BARRIER");
        requireCondition(coordinated || input.reconcile_effect === true && ["paused", "stopped"].includes(current.desired_state), `repository runner barrier blocks new external effects (${current.status}/${current.desired_state}/${observed.status}/${observed.observedState})`, "RUNNER_BARRIER");
        const ownership = processOwnership(current.operation.owner_pid, current.operation.owner_process_identity);
        requireCondition(ownership === "lost", ownership === "match" ? "command reservation owner is still live" : "command reservation ownership is ambiguous", "RUNNER_BARRIER");
        requireCondition(current.operation.expected_revision === input.expected_revision && current.operation.draft_digest === input.draft_digest, "command reconciliation semantic input changed", "REQUEST_CONFLICT");
        requireCondition(current.operation.phase === "reserved" || input.reconcile_effect === true, "effect-phase command requires authoritative journal reconciliation", "RUNNER_BARRIER");
        const successorIdentity = processIdentity(process.pid); requireCondition(successorIdentity, "command process identity is unavailable");
        if (current.operation.phase === "reserved") current.operation.effect_admission = current.desired_state === "stopped" ? "stopped_explicit" : "running";
        current.operation.token = newToken(24); current.operation.started_at = utcNow(); current.operation.owner_pid = process.pid; current.operation.owner_process_identity = successorIdentity; current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
      }
      requireCondition(coordinated, `repository runner barrier blocks new external effects (${current.status}/${current.desired_state}/${observed.status}/${observed.observedState})`, "RUNNER_BARRIER");
      const ownerIdentity = processIdentity(process.pid); requireCondition(ownerIdentity, "command process identity is unavailable");
      const effectAdmission = current.desired_state === "stopped" ? "stopped_explicit" : "running";
      current.revision += 1; current.operation = { kind: "command", token: newToken(24), started_at: utcNow(), owner_pid: process.pid, owner_process_identity: ownerIdentity, action: input.action, delivery_id: input.delivery_id, request_id: input.request_id, input_digest: input.input_digest, ...(input.expected_revision === undefined ? {} : { expected_revision: input.expected_revision }), ...(input.draft_digest === undefined ? {} : { draft_digest: input.draft_digest }), phase: "reserved", effect_admission: effectAdmission }; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  markCommandEffect(repo: string, token: string, operationId?: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), operation = current.operation;
      requireCondition(operation?.kind === "command" && operation.token === token && operation.owner_pid === process.pid && operation.owner_process_identity === processIdentity(process.pid), "command reservation changed");
      requireCondition(operation.phase === "reserved", "command reservation already entered effect phase", "RUNNER_BARRIER");
      const observed = this.observe(current);
      const admitted = !current.cancellation && !current.recovery && !current.in_flight &&
        (operation.effect_admission === "running" && current.desired_state === "running" && observed.status === "running" && observed.observedState === "alive" ||
          operation.effect_admission === "stopped_explicit" && current.desired_state === "stopped" && observed.status === "stopped" && observed.observedState === "not_running");
      if (!admitted) {
        delete current.operation; current.revision += 1; current.heartbeat_at = utcNow(); this.atomic(this.sessionPath(repo), current);
        throw new DeliveryError(`repository lifecycle changed before command effect admission (${current.status}/${current.desired_state}/${observed.status}/${observed.observedState})`, "RUNNER_BARRIER");
      }
      operation.phase = "effect"; if (operationId) operation.operation_id = operationId; current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  markWorkerEffect(repo: string, token: string, operationId?: string): RunnerSession | undefined {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), operation = current.operation;
      requireCondition(operation?.kind === "worker" && operation.token === token && operation.owner_pid === process.pid && operation.owner_process_identity === processIdentity(process.pid), "worker reservation changed");
      requireCondition(operation.phase === "reserved", "worker reservation already entered effect phase", "RUNNER_BARRIER");
      const admitted = !current.cancellation && !current.recovery && !current.in_flight &&
        (operation.effect_admission === "running" && current.desired_state === "running" && current.status === "running" ||
          operation.effect_admission === "stopping_drain" && current.desired_state === "stopped" && current.status === "stopping");
      if (!admitted) { delete current.operation; current.revision += 1; current.heartbeat_at = utcNow(); this.atomic(this.sessionPath(repo), current); return undefined; }
      operation.phase = "effect"; if (operationId) operation.operation_id = operationId; current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  reserveCancellation(repo: string, input: { delivery_id: string; request_id: string; input_digest: string; expected_revision: number; generation: number; owner_token_digest: string }): CancellationReservationResult {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo);
      requireCondition(!current.in_flight && !current.recovery, "legacy or recovery reservation blocks cancellation", "RUNNER_BARRIER");
      const historical = current.cancellation_history?.find((item) => item.request_id === input.request_id);
      if (historical) {
        requireCondition(historical.input_digest === input.input_digest && historical.delivery_id === input.delivery_id && historical.expected_revision === input.expected_revision, "completed cancellation request ID was used for different input", "REQUEST_CONFLICT");
        return Object.assign(current, { reservation: structuredClone(historical), replayed: true }) as CancellationReservationResult;
      }
      if (current.cancellation?.phase === "complete" && (current.cancellation.request_id !== input.request_id || current.cancellation.input_digest !== input.input_digest)) { (current.cancellation_history ??= []).push(structuredClone(current.cancellation)); delete current.cancellation; delete current.stopped_drained_ack_digest; }
      if (current.cancellation) {
        requireCondition(current.cancellation.request_id === input.request_id && current.cancellation.input_digest === input.input_digest, "another cancellation request is active", "RUNNER_BARRIER");
        if (current.cancellation.phase === "complete") return Object.assign(current, { reservation: current.cancellation }) as CancellationReservationResult;
        const ownership = processOwnership(current.cancellation.owner_pid, current.cancellation.owner_process_identity);
        if (ownership === "match") { requireCondition(current.cancellation.owner_pid === process.pid && current.cancellation.owner_process_identity === processIdentity(process.pid), "cancellation observer is still live", "RUNNER_BARRIER"); return Object.assign(current, { reservation: current.cancellation }) as CancellationReservationResult; }
        requireCondition(ownership === "lost", "cancellation observer ownership is ambiguous", "RUNNER_BARRIER");
        const successorIdentity = processIdentity(process.pid); requireCondition(successorIdentity, "cancellation process identity is unavailable");
        current.cancellation.owner_pid = process.pid; current.cancellation.owner_process_identity = successorIdentity; current.cancellation.started_at = utcNow(); current.revision += 1; this.atomic(this.sessionPath(repo), current); return Object.assign(current, { reservation: current.cancellation }) as CancellationReservationResult;
      }
      const previous: Omit<CancellationRollbackSnapshot, "reserved_revision"> = { status: current.status, desired_state: current.desired_state, ...(current.reason === undefined ? {} : { reason: current.reason }), ...(current.cancellation === undefined ? {} : { cancellation: structuredClone(current.cancellation) }), ...(current.stopped_drained_ack_digest === undefined ? {} : { stopped_drained_ack_digest: current.stopped_drained_ack_digest }) };
      const ownerIdentity = processIdentity(process.pid); requireCondition(ownerIdentity, "cancellation process identity is unavailable");
      const token = newToken(24);
      current.revision += 1;
      current.cancellation = { kind: "cancellation", token, started_at: utcNow(), owner_pid: process.pid, owner_process_identity: ownerIdentity, delivery_id: input.delivery_id, request_id: input.request_id, input_digest: input.input_digest, expected_revision: input.expected_revision, epoch: `pending:${token}`, phase: "requested", generation: input.generation, owner_token_digest: input.owner_token_digest };
      current.status = "stopping"; current.desired_state = "stopped"; current.reason = "Cancellation is reconciling exact owned operations.";
      this.atomic(this.sessionPath(repo), current); return Object.assign(current, { reservation: current.cancellation, rollback_snapshot: { ...previous, reserved_revision: current.revision } }) as CancellationReservationResult;
    });
  }
  bindCancellationEpoch(repo: string, token: string, epoch: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => { const current = this.readSession(repo), cancellation = current.cancellation; requireCondition(cancellation?.token === token && cancellation.owner_pid === process.pid && cancellation.owner_process_identity === processIdentity(process.pid), "cancellation reservation changed"); requireCondition(cancellation.epoch === `pending:${token}` || cancellation.epoch === epoch, "cancellation epoch changed"); cancellation.epoch = epoch; cancellation.phase = "reconciling"; current.revision += 1; this.atomic(this.sessionPath(repo), current); return current; });
  }
  rollbackPendingCancellation(repo: string, token: string, previous: CancellationRollbackSnapshot): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), cancellation = current.cancellation;
      requireCondition(cancellation?.token === token && cancellation.owner_pid === process.pid && cancellation.owner_process_identity === processIdentity(process.pid), "cancellation observer changed; preserving it", "RUNNER_BARRIER");
      if (current.revision === previous.reserved_revision) {
        current.status = previous.status; current.desired_state = previous.desired_state;
        if (previous.reason === undefined) delete current.reason; else current.reason = previous.reason;
        if (previous.cancellation === undefined) delete current.cancellation; else current.cancellation = structuredClone(previous.cancellation);
        if (previous.stopped_drained_ack_digest === undefined) delete current.stopped_drained_ack_digest; else current.stopped_drained_ack_digest = previous.stopped_drained_ack_digest;
      } else {
        delete current.cancellation;
        if (current.reason === "Cancellation is reconciling exact owned operations.") delete current.reason;
      }
      current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  updateCancellationPhase(repo: string, token: string, phase: CancellationReservation["phase"], acknowledgementDigest?: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), cancellation = current.cancellation; requireCondition(cancellation?.token === token, "cancellation reservation changed");
      const phases: CancellationReservation["phase"][] = ["requested", "reconciling", "draining", "complete"];
      if (phases.indexOf(phase) <= phases.indexOf(cancellation.phase)) return current;
      cancellation.phase = phase; if (acknowledgementDigest) cancellation.acknowledgement_digest = acknowledgementDigest; if (phase === "complete") cancellation.completed_at = utcNow(); current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  acknowledgeCancellationDrain(repo: string, generation: number, ownerTokenDigest: string, cancellationToken: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), cancellation = current.cancellation;
      requireCondition(cancellation?.token === cancellationToken && cancellation.generation === generation && cancellation.owner_token_digest === ownerTokenDigest, "cancellation drain ownership changed");
      if (cancellation.phase === "complete") { requireCondition(typeof current.stopped_drained_ack_digest === "string" && cancellation.acknowledgement_digest === current.stopped_drained_ack_digest, "completed cancellation lacks exact drain acknowledgement"); return current; }
      requireCondition(cancellation.phase === "draining", "cancellation drain ownership changed"); requireCondition(!current.operation && !current.in_flight, "repository operation has not drained"); const workerOwned = current.owner_pid === process.pid && current.owner_process_identity === processIdentity(process.pid); const stoppedObserver = current.owner_pid === null && cancellation.owner_pid === process.pid && cancellation.owner_process_identity === processIdentity(process.pid); requireCondition(workerOwned || stoppedObserver, "cancellation drain acknowledgement requires exact live owner");
      const acknowledgement = digest({ repo, generation, owner_token_digest: ownerTokenDigest, cancellation_token: cancellationToken, epoch: cancellation.epoch });
      if (current.stopped_drained_ack_digest === acknowledgement && current.status === "stopping") return current;
      current.stopped_drained_ack_digest = acknowledgement; current.revision += 1; current.status = "stopping"; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  retireDeadWorkerForCancellation(repo: string, expectation: DeadCancellationRecoveryExpectation): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo), operation = current.operation, cancellation = current.cancellation, request = current.requests[expectation.request_id];
      requireCondition(current.recovery?.token === expectation.recovery_token && current.recovery.owner_pid === process.pid && current.recovery.owner_process_identity === processIdentity(process.pid), "runner recovery ownership changed", "RUNNER_BARRIER");
      requireCondition(request?.action === "recover" && request.status === "intent", "runner recovery request changed", "RUNNER_BARRIER");
      requireCondition(current.generation === expectation.generation && current.owner_token_digest === expectation.owner_token_digest && current.owner_pid === expectation.owner_pid
        && current.owner_process_identity === expectation.owner_process_identity && processOwnershipLost(current.owner_pid, current.owner_process_identity), "dead runner identity changed", "RUNNER_BARRIER");
      requireCondition(operation?.kind === "worker" && operation.token === expectation.operation_token && operation.phase === "effect" && operation.operation_id === expectation.operation_id
        && operation.delivery_id === expectation.delivery_id && operation.generation === expectation.generation && operation.owner_token_digest === expectation.owner_token_digest
        && operation.owner_pid === expectation.owner_pid && operation.owner_process_identity === expectation.owner_process_identity, "dead worker reservation changed", "RUNNER_BARRIER");
      requireCondition(cancellation?.token === expectation.cancellation_token && cancellation.delivery_id === expectation.delivery_id && cancellation.request_id === expectation.cancellation_request_id
        && cancellation.input_digest === expectation.cancellation_input_digest && cancellation.expected_revision === expectation.cancellation_expected_revision
        && cancellation.epoch === expectation.cancellation_epoch && !cancellation.epoch.startsWith("pending:") && cancellation.generation === expectation.generation
        && cancellation.owner_token_digest === expectation.owner_token_digest && processOwnershipLost(cancellation.owner_pid, cancellation.owner_process_identity), "dead cancellation identity changed", "RUNNER_BARRIER");
      requireCondition(!current.in_flight, "repository operation has not drained", "RUNNER_BARRIER");
      delete current.operation; delete current.recovery; current.owner_pid = null; delete current.owner_process_identity;
      current.status = "stopping"; current.desired_state = "stopped"; cancellation.phase = "draining"; request.status = "reconciled";
      current.reason = "Recovered exact terminal cancellation; finalization is pending."; current.heartbeat_at = utcNow(); current.revision += 1; this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  withCancellationFinalization<T>(expectation: CancellationFenceExpectation, finalize: (fence: RepositoryCancellationFence) => T): T {
    return this.lockStore().withRepoLock(expectation.repo, () => {
      const current = this.readSession(expectation.repo), cancellation = current.cancellation;
      requireCondition(cancellation?.token === expectation.reservation_token && cancellation.delivery_id === expectation.delivery_id && cancellation.request_id === expectation.request_id && cancellation.input_digest === expectation.input_digest && cancellation.epoch === expectation.epoch && cancellation.generation === expectation.generation && cancellation.owner_token_digest === expectation.owner_token_digest, "cancellation repository fence changed", "RUNNER_BARRIER");
      if (cancellation.phase === "complete") {
        requireCondition(typeof current.stopped_drained_ack_digest === "string" && cancellation.acknowledgement_digest === current.stopped_drained_ack_digest && current.status === "stopped" && current.desired_state === "stopped", "completed cancellation repository fence is incomplete", "RUNNER_BARRIER");
        const fence: RepositoryCancellationFence = { ...expectation, stopped_drained_ack_digest: current.stopped_drained_ack_digest }, result = finalize(fence);
        requireCondition(!(result && typeof result === "object" && "then" in result), "cancellation finalization must remain synchronous"); return result;
      }
      requireCondition(!current.operation && !current.in_flight && cancellation.phase === "draining" && typeof current.stopped_drained_ack_digest === "string", "repository owner has not durably drained for cancellation", "RUNNER_BARRIER");
      const fence: RepositoryCancellationFence = { ...expectation, stopped_drained_ack_digest: current.stopped_drained_ack_digest };
      const result = finalize(fence);
      requireCondition(!(result && typeof result === "object" && "then" in result), "cancellation finalization must remain synchronous");
      cancellation.phase = "complete"; cancellation.completed_at = utcNow(); cancellation.acknowledgement_digest = current.stopped_drained_ack_digest; current.revision += 1; current.status = "stopped"; current.desired_state = "stopped"; current.owner_pid = null; delete current.owner_process_identity; delete current.reason; this.atomic(this.sessionPath(expectation.repo), current);
      return result;
    });
  }
  finishReservation(repo: string, reservation: string, deliveryId?: string): RunnerSession {
    return this.lockStore().withRepoLock(repo, () => {
      const current = this.readSession(repo); requireCondition(current.operation?.token === reservation, "repository runner reservation changed");
      current.revision += 1; delete current.operation; current.heartbeat_at = utcNow(); if (deliveryId) current.delivery_id = deliveryId;
      current.status = current.desired_state === "paused" ? "paused" : current.desired_state === "stopped" ? current.owner_pid ? "stopping" : "stopped" : "running";
      this.atomic(this.sessionPath(repo), current); return current;
    });
  }
  observe(session: RunnerSession, now = Date.now()): { status: RunnerStatus; observedState: "alive" | "not_running" | "lost" | "unknown" } {
    if (session.status === "stopped") return { status: "stopped", observedState: "not_running" };
    if (!session.owner_pid) { const launchExpired = session.status === "starting" && session.owner_started_at !== undefined && now - Date.parse(session.owner_started_at) > 5_000; return { status: launchExpired ? "uncertain" : session.status === "starting" ? "starting" : session.status === "blocked" ? "blocked" : "uncertain", observedState: launchExpired || session.status === "uncertain" && session.reason?.startsWith("Runner launch did not establish") ? "lost" : "unknown" }; }
    if (!session.owner_process_identity) return { status: "uncertain", observedState: "unknown" };
    const ownership = processOwnership(session.owner_pid, session.owner_process_identity);
    if (ownership !== "match") return { status: "uncertain", observedState: ownership === "lost" ? "lost" : "unknown" };
    if (session.status === "starting") return { status: "starting", observedState: "alive" };
    if (session.status === "paused") return { status: "paused", observedState: "alive" };
    const fresh = session.heartbeat_at && now - Date.parse(session.heartbeat_at) <= 45_000;
    return { status: fresh ? session.status : "uncertain", observedState: fresh ? "alive" : "unknown" };
  }
}

export function workspaceSetup(identity: RepositoryIdentity, registry: RepositoryRegistry): { configured: boolean; revision: number; defaultProfilePath: string; problems: string[] } {
  const binding = registry.readBinding(identity.repo); const problems: string[] = [];
  if (binding) { try { const profile = registry.validateBoundProfile(identity, binding).profile; requireCondition(loadForegroundPolicy(profile.foreground_policy, identity.repo).auto_schedule === false, "repository runner requires unattended scheduling off"); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); } }
  return { configured: Boolean(binding) && problems.length === 0, revision: binding?.revision ?? 0, defaultProfilePath: defaultProfilePath(identity.repo), problems };
}
