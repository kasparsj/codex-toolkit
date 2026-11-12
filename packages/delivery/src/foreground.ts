import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { DeliveryError, newToken, requireCondition, utcNow } from "./core.ts";
import { DeliveryEngine, enginePreEffectTransientReadOutcome } from "./engine.ts";
import type { DeliveryPolicy, DeliveryState, PublicationMode } from "./types.ts";
import { join } from "node:path";
import { ProposalSpool } from "./proposals.ts";
import { GitHubUnavailable } from "./github.ts";
import { processIdentity } from "./process-identity.ts";

export const FOREGROUND_POLL_MS = 15_000;
export const FOREGROUND_BACKOFF_CAP_MS = 300_000;
export interface ForegroundPolicy { schema_version: 1; repository: string; repository_id: number; auto_schedule: boolean; pr_publication: PublicationMode; issue_publication: PublicationMode; allowed_paths?: { plan?: string[]; implementation?: string[] } }
export interface ForegroundOptions { engine: DeliveryEngine; repo: string; policy: DeliveryPolicy; policyConfig: ForegroundPolicy; pinLocations?: Record<string, string>; skillHashes?: Record<string, string>; engineHashes?: Record<string, string>; onStatus?: (status: string, state?: DeliveryState, message?: string) => void; sleep?: (milliseconds: number) => Promise<void>; propagateOperatorHold?: boolean; sessionGuard?: (acquire: () => void) => () => void; reconcileCancellation?: () => Promise<boolean> }
export type ForegroundTransition = "none" | "collect" | "dispatch" | "verify_candidate" | "publish_plan" | "publish_implementation" | "refresh_reviews" | "recheck_ready";

export function foregroundTransition(state: DeliveryState, policy: ForegroundPolicy): ForegroundTransition {
  if (state.controls.paused || state.controls.cancelled || state.status === "blocked" || state.runner.status === "failed") return "none";
  if (state.runner.status === "running") return "collect";
  if (["rank_required", "plan_required", "implementation_required"].includes(state.status)) return "dispatch";
  if (state.status === "plan_review" || state.status === "implementation_review") {
    const stage = state.status === "plan_review" ? "plan" : "implementation";
    if (stage === "implementation" && !state.receipts.engineering) return "verify_candidate";
    if (!state.publication[stage]) return policy.pr_publication === "automatic" ? stage === "plan" ? "publish_plan" : "publish_implementation" : "none";
    return "refresh_reviews";
  }
  if (state.status === "publication_pending" && !state.receipts.engineering) return "verify_candidate";
  if (["publication_pending", "pre_ready_ci_waiting", "manual_ready_pending", "tracking_pending"].includes(state.status)) return "recheck_ready";
  return "none";
}

export function validateForegroundPolicy(value: unknown, repo: string): ForegroundPolicy {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "foreground policy must be an object");
  const policy = value as Record<string, unknown>;
  requireCondition(Object.keys(policy).every((key) => ["schema_version", "repository", "repository_id", "auto_schedule", "pr_publication", "issue_publication", "allowed_paths"].includes(key)), "foreground policy has unsupported fields");
  requireCondition(policy.schema_version === 1 && policy.repository === repo && Number.isInteger(policy.repository_id) && (policy.repository_id as number) > 0, "foreground policy repository identity mismatch");
  requireCondition(typeof policy.auto_schedule === "boolean", "foreground auto_schedule must be explicit");
  for (const key of ["pr_publication", "issue_publication"] as const) requireCondition(["off", "explicit", "automatic"].includes(policy[key] as string), `invalid ${key}`);
  if (policy.allowed_paths !== undefined) {
    requireCondition(policy.allowed_paths !== null && typeof policy.allowed_paths === "object" && !Array.isArray(policy.allowed_paths), "foreground allowed_paths must be an object");
    requireCondition(Object.keys(policy.allowed_paths as object).every((key) => ["plan", "implementation"].includes(key)), "foreground allowed_paths has unsupported fields");
    for (const paths of Object.values(policy.allowed_paths as Record<string, unknown>)) requireCondition(Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string" && path.length > 0), "foreground allowed_paths entries must be non-empty path arrays");
  }
  return policy as unknown as ForegroundPolicy;
}
export function loadForegroundPolicy(path: string, repo: string): ForegroundPolicy { return validateForegroundPolicy(JSON.parse(readFileSync(path, "utf8")), repo); }

export function nextBackoff(previousMs: number): number { return Math.min(previousMs <= 0 ? FOREGROUND_POLL_MS : previousMs * 2, FOREGROUND_BACKOFF_CAP_MS); }

export function foregroundSessionPath(store: DeliveryEngine["store"], repo: string): string { return join(store.repoDir(repo), "foreground", "session.lock"); }
export function assertNoForegroundSession(store: DeliveryEngine["store"], repo: string): void {
  const path = foregroundSessionPath(store, repo);
  requireCondition(!existsSync(path), `legacy foreground ownership for ${repo} is active or ambiguous; stop it cleanly before repository setup or Start`, "RUNNER_BARRIER");
}

class ServedIssueLedger {
  private readonly engine: DeliveryEngine;
  private readonly repo: string;
  constructor(engine: DeliveryEngine, repo: string) { this.engine = engine; this.repo = repo; }
  private get path(): string { return join(this.engine.store.repoDir(this.repo), "foreground", "served.json"); }
  read(): number[] { try { const value = this.engine.store.readProtected(this.path); requireCondition(value.schema_version === 1 && Array.isArray(value.issue_ids) && value.issue_ids.every((item) => Number.isInteger(item) && item > 0), "invalid served issue ledger"); return value.issue_ids as number[]; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  record(issue: number): void { this.engine.store.withRepoLock(this.repo, () => { const values = this.read(); if (!values.includes(issue)) values.push(issue); this.engine.store.writeProtected(this.path, { schema_version: 1, repo: this.repo, issue_ids: values.sort((a, b) => a - b), updated_at: new Date().toISOString() }); }); }
}

export class ForegroundSupervisor {
  readonly options: ForegroundOptions;
  #stopping = false;
  #inFlight: Promise<unknown> | null = null;
  #backoff = 0;
  #retryNotBefore = 0;
  #sessionToken: string | null = null;
  #sessionRelease: (() => void) | null = null;
  constructor(options: ForegroundOptions) { requireCondition(options.policyConfig.repository === options.repo, "foreground repository mismatch"); this.options = options; }
  stop(): void { this.#stopping = true; this.options.onStatus?.(this.#inFlight ? "draining" : "stopped"); }
  get draining(): boolean { return this.#stopping && this.#inFlight !== null; }
  transitionRequired(state: DeliveryState): boolean { return foregroundTransition(state, this.options.policyConfig) !== "none"; }
  retryDelayMs(now = Date.now()): number { return Math.max(0, this.#retryNotBefore - now); }
  private active(): DeliveryState | undefined { return this.options.engine.store.list(this.options.repo).find((item) => item.claim_status === "active" && !["completed", "review_ready", "cancelled"].includes(item.status)); }
  async tick(): Promise<DeliveryState | undefined> {
    requireCondition(!this.#inFlight, "foreground transition already in flight");
    if (this.#stopping) return this.active();
    if (this.options.reconcileCancellation) { try { if (await this.options.reconcileCancellation()) return undefined; } catch (error) { this.options.onStatus?.("operator_hold", undefined, (error instanceof Error ? error.message : String(error)).slice(0, 500)); } }
    let state = this.active();
    if (!state) {
      const publisher = this.options.engine.publisherPort();
      const proposal = new ProposalSpool(this.options.engine.store).list(this.options.repo).find((item) => item.status === "authorized" || this.options.policyConfig.issue_publication === "automatic" && item.status === "queued");
      if (proposal && publisher && this.options.policyConfig.issue_publication !== "off") { await new ProposalSpool(this.options.engine.store).publish(this.options.repo, proposal.id, publisher, this.options.policyConfig.issue_publication); this.options.onStatus?.("issue_published"); return undefined; }
      if (!this.options.policyConfig.auto_schedule) { this.options.onStatus?.("idle"); return undefined; }
      const ledger = new ServedIssueLedger(this.options.engine, this.options.repo);
      state = this.options.engine.start({ repo: this.options.repo, issue: null, policy: this.options.policy, excludedIssues: ledger.read(), pinLocations: this.options.pinLocations, skillHashes: this.options.skillHashes, engineHashes: this.options.engineHashes, safeguards: { publication: { pr: this.options.policyConfig.pr_publication, issue: this.options.policyConfig.issue_publication }, ...(this.options.policyConfig.allowed_paths ? { allowedPaths: this.options.policyConfig.allowed_paths } : {}) } });
    }
    let cancellationWatch: Promise<boolean> | undefined, watching = false;
    const watchCancellation = (): void => { if (!this.options.reconcileCancellation || watching) return; watching = true; cancellationWatch = this.options.reconcileCancellation().catch((error) => { this.options.onStatus?.("operator_hold", state, (error instanceof Error ? error.message : String(error)).slice(0, 500)); return false; }).finally(() => { watching = false; }); };
    const cancellationTimer = this.options.reconcileCancellation ? setInterval(watchCancellation, 25) : undefined; cancellationTimer?.unref();
    const transition = foregroundTransition(state, this.options.policyConfig);
    this.#inFlight = this.step(state, transition);
    try { state = await this.#inFlight as DeliveryState; this.#backoff = 0; this.#retryNotBefore = 0; if (state.issue && ["completed", "review_ready"].includes(state.status)) new ServedIssueLedger(this.options.engine, this.options.repo).record(state.issue); this.options.onStatus?.(state.status, state); return state; }
    catch (error) {
      if (cancellationWatch) await cancellationWatch;
      const latest = this.options.engine.store.list(this.options.repo).find((candidate) => candidate.delivery_id === state!.delivery_id); if (latest?.controls.cancellation?.phase === "complete") { this.options.onStatus?.("cancelled", latest); return latest; }
      if (error instanceof DeliveryError && ["LOCK_TIMEOUT", "STALE_REVISION"].includes(error.code)) { this.#backoff = nextBackoff(this.#backoff); this.#retryNotBefore = Date.now() + this.#backoff; this.options.onStatus?.("read_backoff", state); return state; }
      const engineRead = enginePreEffectTransientReadOutcome(error), expectedStage = state.status === "rank_required" ? "rank" : state.status === "plan_required" ? "plan" : undefined;
      const exactEngineRead = engineRead?.repo === state.repo && engineRead.delivery_id === state.delivery_id && engineRead.expected_revision === state.revision;
      const safeEngineRead = exactEngineRead && transition === "dispatch" && expectedStage !== undefined && engineRead.transition === "dispatch" && engineRead.stage === expectedStage ? engineRead
        : exactEngineRead && transition === "recheck_ready" && engineRead.transition === "recheck_ready" && engineRead.stage === "readiness" && engineRead.workflow_status === state.status ? engineRead : undefined;
      this.#backoff = Math.max(nextBackoff(this.#backoff), error instanceof GitHubUnavailable ? error.retryAfterSeconds * 1000 : 0, safeEngineRead?.retry_after_ms ?? 0);
      this.#retryNotBefore = Date.now() + this.#backoff;
      const message = safeEngineRead?.message ?? (error instanceof Error ? error.message : String(error));
      if (safeEngineRead) { this.options.onStatus?.("read_backoff", state, message.slice(0, 500)); return state; }
      if (error instanceof GitHubUnavailable && ["refresh_reviews", "recheck_ready"].includes(transition)) { this.options.onStatus?.("read_backoff", state, message.slice(0, 500)); return state; }
      this.options.onStatus?.("operator_hold", state, message.slice(0, 500));
      if (this.options.propagateOperatorHold) throw error;
      return state;
    } finally { if (cancellationTimer) clearInterval(cancellationTimer); if (cancellationWatch) await cancellationWatch; this.#inFlight = null; if (this.#stopping) this.options.onStatus?.("stopped"); }
  }
  private async step(state: DeliveryState, transition: ForegroundTransition): Promise<DeliveryState> {
    if (transition === "collect") return this.options.engine.collect(state.repo, state.delivery_id, state.revision);
    if (transition === "dispatch") return this.options.engine.dispatch(state.repo, state.delivery_id, state.revision);
    if (transition === "verify_candidate") return this.options.engine.verifyCandidate(state.repo, state.delivery_id, state.revision);
    if (transition === "publish_plan" || transition === "publish_implementation") {
      const stage = transition === "publish_plan" ? "plan" : "implementation";
      return this.options.engine.publishStage(state.repo, state.delivery_id, stage, state.revision, state.handoffs[stage]?.digest);
    }
    if (transition === "refresh_reviews") {
      const stage = state.status === "plan_review" ? "plan" : "implementation";
      return this.options.engine.refreshReviews(state.repo, state.delivery_id, stage, state.revision);
    }
    if (transition === "recheck_ready") return this.options.engine.recheckReady(state.repo, state.delivery_id, state.revision);
    return state;
  }
  private sessionPath(): string { return foregroundSessionPath(this.options.engine.store, this.options.repo); }
  private acquireSession(): void {
    const path = this.sessionPath(); const token = newToken(24); mkdirSync(join(this.options.engine.store.repoDir(this.options.repo), "foreground"), { recursive: true, mode: 0o700 });
    const acquire = () => {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; throw new DeliveryError(`foreground session already running or ownership is ambiguous for ${this.options.repo}; automatic PID reclaim is disabled`, "RUNNER_BARRIER"); }
      const identity = processIdentity(process.pid); requireCondition(identity, "foreground process identity is unavailable");
      this.options.engine.store.writeProtected(join(path, "owner.json"), { schema_version: 1, repo: this.options.repo, pid: process.pid, process_identity: identity, token, started_at: utcNow() });
    };
    if (this.options.sessionGuard) this.#sessionRelease = this.options.sessionGuard(acquire); else acquire();
    this.#sessionToken = token;
  }
  private releaseSession(): void {
    if (!this.#sessionToken) return;
    const path = this.sessionPath(), ownerPath = join(path, "owner.json");
    try {
      const owner = this.options.engine.store.readProtected(ownerPath);
      if (owner.token !== this.#sessionToken) return;
      unlinkSync(ownerPath); rmdirSync(path);
      this.#sessionRelease?.();
      this.#sessionToken = null; this.#sessionRelease = null;
    } catch { /* preserve local and repository-wide ownership when exact release cannot be proven */ }
  }
  async run(signal?: AbortSignal): Promise<void> {
    const sleeper = this.options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const abort = () => this.stop(); signal?.addEventListener("abort", abort, { once: true }); this.acquireSession();
    try { while (!this.#stopping) { await this.tick(); if (!this.#stopping) await sleeper(this.#backoff || FOREGROUND_POLL_MS); } if (this.#inFlight) await this.#inFlight; }
    finally { signal?.removeEventListener("abort", abort); this.releaseSession(); }
  }
}
