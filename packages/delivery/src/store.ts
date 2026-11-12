import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { canonicalJson, DeliveryError, digest, newToken, repoIdentity, requireCondition, utcNow, validateDeliveryId } from "./core.ts";
import { acquireDirectoryLockSync, ensurePrivateDirectorySync, recoverDirectoryLockSync, releaseDirectoryLockSync, type DirectoryIdentity } from "./locks.ts";
import type { DeliveryState, JsonObject } from "./types.ts";

function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function isPrivate(mode: number): boolean { return (mode & 0o077) === 0; }
function validateExistingStateAncestors(path: string): void {
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

export class FileStateStore {
  readonly root: string;
  readonly #rootDirectoryIdentity: DirectoryIdentity;
  constructor(root: string) {
    this.root = resolve(root);
    this.#rootDirectoryIdentity = ensurePrivateDirectorySync(this.root);
  }
  private assertRoot(): void { ensurePrivateDirectorySync(this.root, this.#rootDirectoryIdentity); }
  private ensureDirectory(path: string): void {
    this.assertRoot(); ensurePrivateDirectorySync(path); this.assertRoot();
  }
  repoDir(repo: string): string { return join(this.root, "v2", "repos", digest(repoIdentity(repo))); }
  statePath(repo: string, deliveryId: string): string { validateDeliveryId(deliveryId); return join(this.repoDir(repo), "deliveries", deliveryId, "state.json"); }
  private readObject(path: string): Record<string, unknown> {
    this.assertRoot(); validateExistingStateAncestors(dirname(path));
    const info = lstatSync(path);
    requireCondition(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && isPrivate(info.mode), "protected state has unsafe ownership or permissions");
    requireCondition(info.size <= 8 * 1024 * 1024, "protected state exceeds size limit");
    try { this.assertRoot(); validateExistingStateAncestors(dirname(path)); const value = JSON.parse(readFileSync(path, "utf8")); requireCondition(value && typeof value === "object" && !Array.isArray(value), "state JSON object required"); return value; }
    catch (error) { if (error instanceof DeliveryError) throw error; throw new DeliveryError("protected state is invalid JSON"); }
  }
  private validateState(value: Record<string, unknown>, expectedRepo?: string, expectedDeliveryId?: string): DeliveryState {
    requireCondition(value.schema_version === 2, "legacy or unsupported state is not writable");
    requireCondition(typeof value.repo === "string" && typeof value.delivery_id === "string" && typeof value.repo_identity === "string", "state identity missing");
    validateDeliveryId(value.delivery_id); requireCondition(value.repo_identity === repoIdentity(value.repo), "state repository identity mismatch");
    if (expectedRepo !== undefined) requireCondition(value.repo === expectedRepo && value.delivery_id === expectedDeliveryId, "state identity mismatch");
    requireCondition(Number.isInteger(value.revision) && (value.revision as number) > 0 && typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at)), "invalid state revision or timestamp");
    const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
    const runner = value.runner, controls = value.controls, budget = value.budget, pins = value.pins;
    requireCondition(typeof value.status === "string" && typeof value.claim_status === "string" && Number.isInteger(value.attempt)
      && (value.issue === null || Number.isInteger(value.issue)) && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at))
      && object(runner) && typeof runner.status === "string" && object(controls) && typeof controls.paused === "boolean" && typeof controls.cancelled === "boolean" && object(controls.requests)
      && object(budget) && Number.isInteger(budget.max_attempts) && Number.isInteger(budget.attempts_used) && Number.isInteger(budget.max_elapsed_seconds) && typeof budget.token_cost_status === "string"
      && object(pins) && object(pins.skills) && object(pins.engine) && object(pins.locations) && object(pins.artifacts)
      && object(value.safeguards) && object((value.safeguards as Record<string, unknown>).publication) && object((value.safeguards as Record<string, unknown>).allowed_paths)
      && object(value.policy) && object(value.policy_values) && object(value.requirements) && object(value.manifests) && object(value.receipts) && object(value.publication) && object(value.handoffs) && object(value.scheduler)
      && Array.isArray(value.history) && Array.isArray(value.operations) && Array.isArray(value.executions) && Array.isArray(value.unresolved_effects), "invalid state structure");
    return value as unknown as DeliveryState;
  }
  readProtected(path: string): Record<string, unknown> { return this.readObject(path); }
  read(repo: string, deliveryId: string): DeliveryState {
    const value = this.readObject(this.statePath(repo, deliveryId));
    return this.validateState(value, repo, deliveryId);
  }
  private atomic(path: string, value: unknown): void {
    this.assertRoot();
    this.ensureDirectory(dirname(path));
    const temporary = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.${newToken(6)}`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    this.assertRoot(); ensurePrivateDirectorySync(dirname(path)); renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  writeProtected(path: string, value: unknown): void { this.atomic(path, value); }
  create(state: DeliveryState): void {
    const path = this.statePath(state.repo, state.delivery_id);
    requireCondition(!existsSync(path), "delivery ID already exists");
    this.atomic(path, state);
  }
  write(state: DeliveryState, expectedRevision: number, expectedClaimToken: string): DeliveryState {
    return this.withRepoLock(state.repo, () => {
      const current = this.read(state.repo, state.delivery_id);
      requireCondition(current.revision === expectedRevision, `stale state revision: current ${current.revision}`, "STALE_REVISION");
      requireCondition(current.claim_token === expectedClaimToken && current.claim_generation === state.claim_generation, "stale claim fencing token", "STALE_CLAIM");
      const next = { ...state, revision: current.revision + 1, updated_at: utcNow() };
      this.atomic(this.statePath(state.repo, state.delivery_id), next);
      return next;
    });
  }
  mutate(repo: string, deliveryId: string, expectedRevision: number | undefined, transform: (state: DeliveryState) => DeliveryState): DeliveryState {
    return this.withRepoLock(repo, () => {
      const current = this.read(repo, deliveryId);
      if (expectedRevision !== undefined) requireCondition(current.revision === expectedRevision, `stale state revision: current ${current.revision}`, "STALE_REVISION");
      const transformed = transform(structuredClone(current));
      requireCondition(transformed.repo === current.repo && transformed.delivery_id === current.delivery_id && transformed.claim_token === current.claim_token && transformed.claim_generation === current.claim_generation, "mutation changed fenced identity");
      const next = { ...transformed, revision: current.revision + 1, updated_at: utcNow() };
      this.atomic(this.statePath(repo, deliveryId), next);
      return next;
    });
  }
  claim(repo: string, state: DeliveryState): void {
    this.withRepoLock(repo, () => {
      const activePath = join(this.repoDir(repo), "active.json");
      const authoritative = this.authoritativeActive(repo);
      requireCondition(!authoritative, `active delivery already claimed: ${String(authoritative?.delivery_id)}`);
      this.create(state);
      this.atomic(activePath, { schema_version: 2, repo, delivery_id: state.delivery_id, status: "active", generation: state.claim_generation, token_digest: digest(state.claim_token), claimed_at: state.created_at });
    });
  }
  release(state: DeliveryState): void {
    this.withRepoLock(state.repo, () => {
      const activePath = join(this.repoDir(state.repo), "active.json");
      const authoritative = this.read(state.repo, state.delivery_id);
      requireCondition(authoritative.claim_status === "released" && authoritative.claim_generation === state.claim_generation && authoritative.claim_token === state.claim_token, "cannot release an active or different delivery claim");
      this.atomic(activePath, { schema_version: 2, repo: state.repo, delivery_id: state.delivery_id, status: "released", generation: state.claim_generation, token_digest: digest(state.claim_token), claimed_at: state.created_at, released_at: utcNow() });
    });
  }
  private authoritativeActive(repo: string): DeliveryState | undefined {
    this.assertRoot();
    const directory = join(this.repoDir(repo), "deliveries");
    if (!existsSync(directory)) return undefined;
    validateExistingStateAncestors(directory);
    let active: DeliveryState | undefined;
    for (const deliveryId of readdirSync(directory).sort()) {
      validateDeliveryId(deliveryId);
      const value = this.readObject(join(directory, deliveryId, "state.json"));
      const state = this.validateState(value);
      requireCondition(state.repo_identity === repoIdentity(repo) && state.delivery_id === deliveryId, "state identity mismatch");
      if (state.claim_status !== "active") continue;
      requireCondition(!active, "multiple authoritative active delivery claims exist", "CLAIM_CONFLICT");
      active = state;
    }
    return active;
  }
  scan(repo?: string): { states: DeliveryState[]; diagnostics: Array<{ code: string; source: string; message: string }> } {
    this.assertRoot();
    const repos = repo ? [this.repoDir(repo)] : (() => { const root = join(this.root, "v2", "repos"); if (!existsSync(root)) return []; validateExistingStateAncestors(root); return readdirSync(root).map((name) => join(root, name)); })();
    const states: DeliveryState[] = []; const diagnostics: Array<{ code: string; source: string; message: string }> = [];
    for (const repoPath of repos) {
      const directory = join(repoPath, "deliveries"); if (!existsSync(directory)) continue;
      validateExistingStateAncestors(directory);
      for (const deliveryId of readdirSync(directory).sort()) {
        try {
          validateDeliveryId(deliveryId); const value = this.readObject(join(directory, deliveryId, "state.json")), state = this.validateState(value);
          requireCondition(state.delivery_id === deliveryId && basename(repoPath) === digest(state.repo_identity), "state directory identity mismatch");
          if (repo !== undefined) requireCondition(state.repo_identity === repoIdentity(repo), "state repository identity mismatch");
          states.push(state);
        }
        catch { diagnostics.push({ code: "INVALID_SOURCE", source: deliveryId.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 80), message: "A retained run source is invalid or unavailable." }); }
      }
    }
    return { states: states.sort((a, b) => b.updated_at.localeCompare(a.updated_at)), diagnostics };
  }
  list(repo?: string): DeliveryState[] { return this.scan(repo).states; }
  withRepoLock<T>(repo: string, operation: () => T, timeoutMs = 10_000): T {
    this.assertRoot();
    const repoDir = this.repoDir(repo); this.ensureDirectory(repoDir);
    const lock = join(repoDir, ".mutation.lock"); const started = Date.now(); let owner;
    while (true) {
      try { owner = acquireDirectoryLockSync(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A dead PID is only an observation. Deleting a stale-looking directory here can
        // race another contender which has already installed a fresh owner. Ambiguous
        // locks therefore fail closed and require explicit operator recovery.
        try { this.readObject(join(lock, "owner.json")); } catch { /* timeout below */ }
        requireCondition(Date.now() - started < timeoutMs, "state mutation lock timed out", "LOCK_TIMEOUT"); sleep(20);
      }
    }
    try { return operation(); }
    finally { releaseDirectoryLockSync(lock, owner); }
  }

  recoverRepoLock(repo: string): boolean {
    this.assertRoot();
    const repoDir = this.repoDir(repo), lock = join(repoDir, ".mutation.lock");
    return recoverDirectoryLockSync(lock);
  }
}
