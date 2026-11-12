import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, digest, requireCondition } from "./core.ts";
import { acquireDirectoryLockSync, ensurePrivateDirectorySync, recoverDirectoryLockSync, releaseDirectoryLockSync, type DirectoryIdentity, type DirectoryLockOwner } from "./locks.ts";
import type { AdapterOutcome, AdapterOutcomeExpectedContext, AdapterOutcomeProofResolution, AdapterRole } from "./ports.ts";

const MAX_RECEIPT_BYTES = 256 * 1024;
const REFERENCE = /^ar_[0-9a-f]{32}$/;
const ACCEPTED_NONTERMINAL_STATUSES = new Set(["running", "permission", "timeout", "uncertain"]);

export interface AdapterReceipt {
  schema_version: 1;
  adapter: "pi" | "paseo" | "executable";
  reference: string;
  role: AdapterRole;
  repo: string;
  delivery_id: string;
  task_id: string;
  packet_digest: string;
  execution_id: string;
  state: "intent" | "accepted" | "terminal";
  created_at: string;
  updated_at: string;
  proof_kind?: "preflight_refusal" | "run_receipt" | "process_exit" | "archive_ack" | "no_ordinary_run";
  outcome?: AdapterOutcome;
  private?: Record<string, unknown>;
}

function privateFile(path: string): void {
  const info = lstatSync(path);
  requireCondition(info.isFile() && !info.isSymbolicLink(), "adapter receipt must be a regular file");
  requireCondition(process.geteuid?.() === undefined || info.uid === process.geteuid?.(), "adapter receipt has unsafe ownership");
  requireCondition((info.mode & 0o077) === 0 && info.size <= MAX_RECEIPT_BYTES, "adapter receipt is unsafe");
}

function validate(value: unknown, reference: string): AdapterReceipt {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "adapter receipt must be an object");
  const receipt = value as Partial<AdapterReceipt>;
  requireCondition(receipt.schema_version === 1 && receipt.reference === reference && ["pi", "paseo", "executable"].includes(String(receipt.adapter)), "adapter receipt identity is invalid");
  requireCondition(receipt.role === "agent" || receipt.role === "reviewer", "adapter receipt role is invalid");
  for (const field of ["repo", "delivery_id", "task_id", "packet_digest", "execution_id", "created_at", "updated_at"] as const) requireCondition(typeof receipt[field] === "string" && receipt[field]!.length > 0, `adapter receipt ${field} is invalid`);
  requireCondition(["intent", "accepted", "terminal"].includes(String(receipt.state)), "adapter receipt state is invalid");
  if (receipt.state === "terminal") {
    requireCondition(receipt.outcome !== undefined && receipt.proof_kind !== undefined && receipt.outcome.execution_id === receipt.execution_id
      && receipt.outcome.terminal !== "nonterminal" && receipt.outcome.proof?.reference === receipt.reference && receipt.outcome.proof.kind === receipt.proof_kind, "adapter terminal receipt proof is invalid");
  } else requireCondition(receipt.outcome === undefined && receipt.proof_kind === undefined, "adapter nonterminal receipt cannot contain terminal proof");
  return receipt as AdapterReceipt;
}

function sameReceiptIdentity(left: AdapterReceipt, right: AdapterReceipt): boolean {
  return ["schema_version", "adapter", "reference", "role", "repo", "delivery_id", "task_id", "packet_digest", "execution_id", "created_at"]
    .every((field) => left[field as keyof AdapterReceipt] === right[field as keyof AdapterReceipt]);
}

function sameTerminal(left: AdapterReceipt, right: AdapterReceipt): boolean {
  if (left.state !== "terminal" || right.state !== "terminal") return false;
  return canonicalJson({ ...left, updated_at: right.updated_at }) === canonicalJson(right);
}

function lifecycleShape(outcome: AdapterOutcome | undefined): AdapterOutcome | undefined {
  if (!outcome) return undefined;
  return {
    status: outcome.status,
    effect: outcome.effect,
    terminal: outcome.terminal,
    ...(outcome.execution_id ? { execution_id: outcome.execution_id } : {}),
    ...(outcome.provider ? { provider: outcome.provider } : {}),
    ...(outcome.proof ? { proof: outcome.proof } : {}),
    ...(outcome.result ? { result: outcome.result } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

function requirePiTerminalQuiescence(receipt: AdapterReceipt): void {
  if (receipt.adapter !== "pi" || receipt.state !== "terminal" || receipt.proof_kind !== "run_receipt") return;
  const child = receipt.private?.pi_child as { pid?: unknown; process_identity?: unknown } | undefined;
  const settlement = receipt.private?.pi_settlement as { aborted?: unknown } | undefined;
  const quiescence = receipt.private?.pi_quiescence as { schema_version?: unknown; child_pid?: unknown; child_process_identity?: unknown; settlement_digest?: unknown; exit?: unknown } | undefined;
  requireCondition(Number.isInteger(child?.pid) && typeof child?.process_identity === "string" && settlement !== undefined && typeof settlement.aborted === "boolean", "Pi terminal receipt lacks protected child or settlement evidence");
  requireCondition(receipt.private?.pi_settlement_digest === digest(settlement) && quiescence?.schema_version === 1 && quiescence.child_pid === child!.pid && quiescence.child_process_identity === child!.process_identity && quiescence.settlement_digest === receipt.private.pi_settlement_digest, "Pi terminal receipt quiescence identity is invalid");
  const exit = quiescence.exit as { kind?: unknown; code?: unknown; signal?: unknown } | undefined;
  requireCondition(exit?.kind === "proven_lost" || exit?.kind === "observed_exit" && (exit.code === null || Number.isInteger(exit.code)) && (exit.signal === null || typeof exit.signal === "string"), "Pi terminal receipt lacks corroborated exact-child exit evidence");
  requireCondition(receipt.outcome?.terminal !== "cancelled" || settlement.aborted === true, "Pi cancelled receipt lacks an aborted settlement");
}

export class AdapterReceiptStore {
  readonly root: string;
  readonly role: AdapterRole;
  readonly #identity: DirectoryIdentity;
  constructor(root: string, role: AdapterRole) {
    requireCondition(resolve(root) === root, "adapter receipt root must be absolute and canonical");
    this.#identity = ensurePrivateDirectorySync(root);
    this.root = root;
    this.role = role;
  }
  newReference(): string { return `ar_${randomBytes(16).toString("hex")}`; }
  findOrCreate(adapter: AdapterReceipt["adapter"], context: Pick<AdapterReceipt, "repo" | "delivery_id" | "task_id" | "packet_digest">, create: (reference: string) => AdapterReceipt): { receipt: AdapterReceipt; created: boolean } {
    const key = digest({ adapter, role: this.role, ...context }), path = join(this.root, `.context-${key}`), owner = this.#acquireExclusive(path, { context_digest: key, receipt_role: this.role });
    try {
      const matches = this.find(adapter, context);
      requireCondition(matches.length <= 1, "multiple protected adapter receipts exist for one exact context");
      if (matches.length === 1) return { receipt: matches[0]!, created: false };
      const receipt = create(this.newReference());
      requireCondition(receipt.adapter === adapter && receipt.role === this.role && receipt.repo === context.repo && receipt.delivery_id === context.delivery_id && receipt.task_id === context.task_id && receipt.packet_digest === context.packet_digest, "adapter context reservation attempted a mismatched receipt");
      return { receipt: this.write(receipt), created: true };
    } finally { releaseDirectoryLockSync(path, owner); }
  }
  path(reference: string): string {
    ensurePrivateDirectorySync(this.root, this.#identity);
    requireCondition(REFERENCE.test(reference), "invalid adapter proof reference");
    return join(this.root, `${reference}.json`);
  }
  write(receipt: AdapterReceipt): AdapterReceipt {
    requireCondition(receipt.role === this.role, "adapter receipt role differs from configured role");
    validate(receipt, receipt.reference);
    const path = this.path(receipt.reference), transitionPath = join(this.root, `.transition-${receipt.reference}`);
    const acquired = this.#acquireTransition(transitionPath, receipt);
    if (!("owner" in acquired)) {
      requireCondition(sameReceiptIdentity(acquired, receipt), "adapter receipt immutable identity changed during transition convergence");
      return acquired;
    }
    const { owner, contended } = acquired;
    try {
      if (existsSync(path)) {
        const current = this.read(receipt.reference);
        requireCondition(sameReceiptIdentity(current, receipt), "adapter receipt immutable identity changed");
        if (current.state === "terminal") {
          if (sameTerminal(current, receipt)) return current;
          this.#recordConflict(current, receipt, "terminal receipt is immutable");
          if (contended) return current;
          requireCondition(false, "adapter terminal receipt is immutable");
        }
        requireCondition(!(current.state === "accepted" && receipt.state === "intent"), "adapter receipt cannot transition from accepted to intent");
      }
      const temporary = join(dirname(path), `.${receipt.reference}.${process.pid}.${randomBytes(6).toString("hex")}`);
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(fd, canonicalJson(receipt), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return receipt;
    } finally { releaseDirectoryLockSync(transitionPath, owner); }
  }
  read(reference: string): AdapterReceipt {
    const path = this.path(reference);
    requireCondition(existsSync(path), "adapter proof receipt is missing");
    privateFile(path);
    const receipt = validate(JSON.parse(readFileSync(path, "utf8")), reference);
    requireCondition(receipt.role === this.role, "adapter receipt role differs from configured role");
    return receipt;
  }
  find(adapter: AdapterReceipt["adapter"], context: Pick<AdapterReceipt, "repo" | "delivery_id" | "task_id" | "packet_digest">): AdapterReceipt[] {
    ensurePrivateDirectorySync(this.root, this.#identity);
    const found: AdapterReceipt[] = [];
    for (const name of readdirSync(this.root)) {
      const match = /^(ar_[0-9a-f]{32})\.json$/.exec(name); if (!match) continue;
      const receipt = this.read(match[1]!);
      if (receipt.adapter === adapter && receipt.repo === context.repo && receipt.delivery_id === context.delivery_id && receipt.task_id === context.task_id && receipt.packet_digest === context.packet_digest) found.push(receipt);
    }
    return found.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }
  findPiSession(sessionFile: string): AdapterReceipt[] {
    ensurePrivateDirectorySync(this.root, this.#identity);
    const found: AdapterReceipt[] = [];
    for (const name of readdirSync(this.root)) {
      const match = /^(ar_[0-9a-f]{32})\.json$/.exec(name); if (!match) continue;
      const receipt = this.read(match[1]!);
      if (receipt.adapter === "pi" && receipt.private?.session_file === sessionFile) found.push(receipt);
    }
    return found.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }
  resolve(outcome: AdapterOutcome, expected: AdapterOutcomeExpectedContext): AdapterOutcomeProofResolution {
    try {
      const proof = outcome.proof;
      requireCondition(proof && REFERENCE.test(proof.reference), "adapter outcome has no protected proof reference");
      const receipt = this.read(proof.reference);
      if (outcome.terminal === "nonterminal") requireCondition(receipt.state === "accepted" && proof.kind === "run_receipt", "adapter receipt is not matching accepted-run proof");
      else requireCondition(receipt.state === "terminal" && receipt.proof_kind === proof.kind, "adapter receipt is not matching terminal proof");
      requireCondition(receipt.repo === expected.repo && receipt.delivery_id === expected.delivery_id && receipt.role === expected.role && receipt.task_id === expected.task_id && receipt.packet_digest === expected.packet_digest, "adapter proof context mismatch");
      requireCondition(!expected.execution_id || receipt.execution_id === expected.execution_id, "adapter proof execution mismatch");
      if (outcome.terminal !== "nonterminal") { requirePiTerminalQuiescence(receipt); requireCondition(canonicalJson(lifecycleShape(receipt.outcome)) === canonicalJson(lifecycleShape(outcome)), "adapter outcome differs from protected receipt"); }
      else requireCondition(outcome.execution_id === receipt.execution_id && ACCEPTED_NONTERMINAL_STATUSES.has(outcome.status) && outcome.effect === "accepted", "adapter accepted outcome is contradictory");
      return { trusted: true, proof_digest: digest(receipt) };
    } catch (error) { return { trusted: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  #recordConflict(current: AdapterReceipt, attempted: AdapterReceipt, reason: string): void {
    const root = join(this.root, "diagnostics");
    if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
    ensurePrivateDirectorySync(root);
    const path = join(root, `${current.reference}.${Date.now()}.${randomBytes(6).toString("hex")}.json`);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, canonicalJson({ schema_version: 1, reference: current.reference, reason, current_digest: digest(current), attempted_digest: digest(attempted) }), "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  #acquireTransition(path: string, attempted: AdapterReceipt): { owner: DirectoryLockOwner; contended: boolean } | AdapterReceipt {
    const deadline = Date.now() + 2_000, sleeper = new Int32Array(new SharedArrayBuffer(4));
    let contended = false;
    for (;;) {
      try { return { owner: acquireDirectoryLockSync(path, { receipt_reference: attempted.reference, receipt_role: this.role }), contended }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        contended = true;
      }
      const receiptPath = this.path(attempted.reference);
      if (existsSync(receiptPath)) {
        const current = this.read(attempted.reference);
        if (current.state === "terminal") return current;
      }
      try { if (recoverDirectoryLockSync(path)) continue; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/owner is still alive|liveness is unknown|ENOENT|no such file/i.test(message)) throw error;
      }
      requireCondition(Date.now() < deadline, "adapter receipt transition remained busy without an observable terminal winner");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  #acquireExclusive(path: string, context: Readonly<Record<string, string>>): DirectoryLockOwner {
    const deadline = Date.now() + 2_000, sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try { return acquireDirectoryLockSync(path, context); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      try { if (recoverDirectoryLockSync(path)) continue; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/owner is still alive|liveness is unknown|ENOENT|no such file/i.test(message)) throw error;
      }
      requireCondition(Date.now() < deadline, "adapter exact-context reservation remained busy");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
}
