import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { canonicalJson, DeliveryError, digest, newToken, requireCondition, utcNow } from "./core.ts";

export interface DirectoryIdentity { dev: number; ino: number }

export interface DirectoryLockOwner {
  schema_version?: 1;
  pid: number;
  process_identity: string;
  token: string;
  at: string;
  context?: Readonly<Record<string, string>>;
}

function isPrivate(mode: number): boolean { return (mode & 0o077) === 0; }

function processIdentity(pid: number): string | undefined {
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return started ? digest({ pid, started }) : undefined;
  } catch { return undefined; }
}

function atomicPrivateJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${path.split(sep).pop()}.${process.pid}.${newToken(6)}`);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, canonicalJson(value), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function occupiedLockError(): NodeJS.ErrnoException {
  return Object.assign(new Error("lock path already exists"), { code: "EEXIST" });
}

function validateOwner(value: unknown): DirectoryLockOwner {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "lock owner must be an object");
  const owner = value as Partial<DirectoryLockOwner>;
  requireCondition((owner.schema_version === undefined || owner.schema_version === 1) && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0
    && typeof owner.process_identity === "string" && owner.process_identity.length > 0
    && typeof owner.token === "string" && owner.token.length > 0
    && typeof owner.at === "string" && Number.isFinite(Date.parse(owner.at)), "lock owner identity is incomplete");
  if (owner.context !== undefined) {
    requireCondition(owner.context !== null && typeof owner.context === "object" && !Array.isArray(owner.context), "lock owner context must be an object");
    const entries = Object.entries(owner.context);
    requireCondition(entries.length > 0 && entries.length <= 32 && entries.every(([key, entry]) => /^[a-z][a-z0-9_]{0,63}$/.test(key) && typeof entry === "string" && entry.length > 0 && entry.length <= 4096), "lock owner context is invalid");
  }
  return owner as DirectoryLockOwner;
}

export function readDirectoryLockOwnerSync(lockPath: string): DirectoryLockOwner {
  const ownerPath = join(lockPath, "owner.json"), info = lstatSync(ownerPath), euid = process.geteuid?.();
  requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid) && isPrivate(info.mode), "lock owner record is unsafe");
  requireCondition(info.size > 0 && info.size <= 16 * 1024, "lock owner record has invalid size");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(ownerPath, "utf8")); }
  catch { throw new DeliveryError("lock owner record is invalid"); }
  return validateOwner(parsed);
}

function sameOwner(left: DirectoryLockOwner, right: DirectoryLockOwner): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function acquireDirectoryLockSync(lockPath: string, context?: Readonly<Record<string, string>>): DirectoryLockOwner {
  const identity = processIdentity(process.pid);
  requireCondition(identity !== undefined, "cannot establish current process identity");
  if (context !== undefined) validateOwner({ schema_version: 1, pid: process.pid, process_identity: identity, token: "validation", at: utcNow(), context });
  const owner: DirectoryLockOwner = { schema_version: 1, pid: process.pid, process_identity: identity, token: newToken(), at: utcNow(), ...(context ? { context: { ...context } } : {}) };
  const staging = `${lockPath}.acquire-${owner.token}`;
  mkdirSync(staging, { mode: 0o700 });
  atomicPrivateJson(join(staging, "owner.json"), owner);
  try {
    try { lstatSync(lockPath); throw occupiedLockError(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameSync(staging, lockPath);
    const parent = openSync(dirname(lockPath), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) {
    releaseDirectoryLockSync(staging, owner);
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw occupiedLockError();
    throw error;
  }
  return owner;
}

export function releaseDirectoryLockSync(lockPath: string, expected: DirectoryLockOwner): void {
  try {
    // Only the process that created this owner may perform ordinary retirement.
    // Explicit dead-owner recovery uses the separate permanent .recovery-* path.
    const identity = processIdentity(process.pid);
    if (expected.pid !== process.pid || identity === undefined || expected.process_identity !== identity) return;
    const current = readDirectoryLockOwnerSync(lockPath);
    if (!sameOwner(current, expected)) return;
    const retired = `${lockPath}.release-${digest(expected.token).slice(0, 16)}`;
    renameSync(lockPath, retired);
    const frozen = readDirectoryLockOwnerSync(retired);
    if (!sameOwner(frozen, expected)) return;
    unlinkSync(join(retired, "owner.json"));
    rmdirSync(retired);
    const parent = openSync(dirname(lockPath), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch {
    // An ambiguous release must preserve a possible different owner.
  }
}

function requireProvenDead(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new DeliveryError("lock owner liveness is unknown");
  }
  throw new DeliveryError("lock owner is still alive");
}

export function recoverDirectoryLockSync(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const owner = readDirectoryLockOwnerSync(lockPath);
  requireProvenDead(owner.pid);
  if (!existsSync(lockPath)) return false;
  const current = readDirectoryLockOwnerSync(lockPath);
  requireCondition(sameOwner(current, owner), "lock owner changed during recovery");
  const quarantine = `${lockPath}.recovery-${digest(owner.token).slice(0, 16)}`;
  try { renameSync(lockPath, quarantine); }
  catch (error) {
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new DeliveryError("another exact lock recovery is already in progress or was recorded", "LOCK_TIMEOUT");
    throw error;
  }
  const frozen = readDirectoryLockOwnerSync(quarantine);
  requireCondition(sameOwner(frozen, owner), "quarantined lock owner differs from recovered owner");
  return true;
}

function validateAncestor(path: string): void {
  const info = lstatSync(path), euid = process.geteuid?.();
  let effective = info;
  if (info.isSymbolicLink()) {
    requireCondition(info.uid === 0, `unsafe state path component: ${path}`);
    effective = statSync(path);
    requireCondition(effective.isDirectory(), `unsafe state path component: ${path}`);
  } else requireCondition(effective.isDirectory(), `unsafe state path component: ${path}`);
  requireCondition(euid === undefined || effective.uid === euid || effective.uid === 0, `state path component has unsafe ownership: ${path}`);
  requireCondition((effective.mode & 0o022) === 0 || (effective.mode & 0o1000) !== 0, `state path component is writable by other users: ${path}`);
}

export function ensurePrivateDirectorySync(path: string, expected?: DirectoryIdentity): DirectoryIdentity {
  requireCondition(isAbsolute(path) && resolve(path) === path, "state directory must be absolute and canonical");
  const root = parse(path).root;
  let current = root;
  validateAncestor(current);
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) {
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    validateAncestor(current);
  }
  const info = lstatSync(path), euid = process.geteuid?.();
  requireCondition(info.isDirectory() && !info.isSymbolicLink(), "state directory must not be a symbolic link");
  requireCondition(euid === undefined || info.uid === euid, "state directory must be owned by the current user");
  requireCondition(isPrivate(info.mode), "state directory must be private");
  const identity = { dev: info.dev, ino: info.ino };
  if (expected) requireCondition(identity.dev === expected.dev && identity.ino === expected.ino, "state directory identity changed");
  return identity;
}
