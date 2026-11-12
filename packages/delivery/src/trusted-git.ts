import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DeliveryError, requireCondition, validateRef, validateSha } from "./core.ts";

const execFileAsync = promisify(execFile);

export interface TrustedGitOptions { root: string; remoteUrl: string; token?: string; allowLocalRemote?: boolean; timeoutMs?: number }

export class TrustedGit {
  readonly root: string; readonly remoteUrl: string;
  #repo = ""; #token?: string; #allowLocal: boolean; #timeout: number;
  constructor(options: TrustedGitOptions) {
    requireCondition(resolve(options.root) === options.root, "trusted Git root must be absolute and canonical");
    const local = options.remoteUrl.startsWith("file://") || options.remoteUrl.startsWith("/");
    requireCondition(local ? options.allowLocalRemote === true : /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(options.remoteUrl), "invalid canonical Git remote");
    this.root = options.root; this.remoteUrl = options.remoteUrl; if (options.token !== undefined) this.#token = options.token; this.#allowLocal = local; this.#timeout = options.timeoutMs ?? 30_000;
  }
  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.#repo = await mkdtemp(join(this.root, "git-"));
    await this.#run(["init", "--bare", this.#repo], undefined, false);
  }
  async close(): Promise<void> { if (this.#repo) await rm(this.#repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); this.#repo = ""; }
  async #run(args: string[], cwd = this.#repo, gitDir = true): Promise<string> {
    requireCondition(this.#repo || !gitDir, "trusted Git is not open");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", HOME: this.#repo || this.root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PROTOCOL_FROM_USER: "0", GIT_ALLOW_PROTOCOL: this.#allowLocal ? "file:https" : "https" };
    if (this.#token) {
      const askpass = join(this.#repo, "askpass.mjs");
      try { await lstat(askpass); } catch { await writeFile(askpass, "#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]?.toLowerCase().includes('username')?'x-access-token':process.env.CODEX_TOOLKIT_GIT_TOKEN||'')\n", { mode: 0o700 }); }
      env.GIT_ASKPASS = askpass; env.CODEX_TOOLKIT_GIT_TOKEN = this.#token;
    }
    // This checkout is disposable; background maintenance must not outlive the command or race cleanup.
    try { const result = await execFileAsync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, env, timeout: this.#timeout, maxBuffer: 16 * 1024 * 1024 }); return result.stdout.trim(); }
    catch (error) { throw new DeliveryError(`trusted Git command failed: ${args[0]} ${args[1] ?? ""}`, "GIT_FAILED"); }
  }
  async fetchBase(ref: string, sha: string): Promise<void> { validateRef(ref); validateSha(sha); await this.#run(["fetch", "--no-tags", "--depth=1", this.remoteUrl, `${sha}:refs/base/${ref}`]); requireCondition(await this.hasObject(sha), "base SHA was not fetched"); }
  async hasObject(sha: string): Promise<boolean> { validateSha(sha); try { await this.#run(["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; } }
  async importCandidate(bundle: string, sha: string): Promise<void> {
    validateSha(sha); const path = resolve(bundle); requireCondition(path === bundle, "bundle path must be canonical");
    const info = await lstat(path); const euid = process.geteuid?.(); requireCondition(info.isFile() && !info.isSymbolicLink() && (euid === undefined || info.uid === euid) && (info.mode & 0o022) === 0, "candidate bundle is not protected");
    await this.#run(["bundle", "verify", path]); await this.#run(["fetch", "--no-tags", path, `+${sha}:refs/candidate`]); requireCondition(await this.hasObject(sha), "candidate SHA is absent from bundle");
  }
  async requireAncestor(baseSha: string, candidateSha: string): Promise<void> { validateSha(baseSha); validateSha(candidateSha); await this.#run(["merge-base", "--is-ancestor", baseSha, candidateSha]); }
  async verifyCandidate(baseSha: string, candidateSha: string, allowedPaths: string[]): Promise<void> {
    validateSha(baseSha); validateSha(candidateSha);
    await this.requireAncestor(baseSha, candidateSha);
    const commits = (await this.#run(["rev-list", "--reverse", `${baseSha}..${candidateSha}`])).split("\n").filter(Boolean);
    requireCondition(commits.length > 0, "candidate has no material change");
    const allowed = allowedPaths.map((path) => { requireCondition(path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === ""), "unsafe allowed path"); return path; });
    for (const commit of commits) {
      const names = (await this.#run(["diff-tree", "--no-commit-id", "--name-only", "-r", `${commit}^`, commit])).split("\n").filter(Boolean);
      requireCondition(names.every((name) => allowed.some((path) => name === path || name.startsWith(path.endsWith("/") ? path : `${path}/`))), `candidate changes path outside allowlist: ${names.find((name) => !allowed.some((path) => name === path || name.startsWith(`${path}/`)))}`);
      const commitTree = await this.#run(["ls-tree", "-r", commit]);
      for (const line of commitTree.split("\n").filter(Boolean)) requireCondition(/^(100644|100755) blob /.test(line), "candidate history contains unsafe tree entry");
    }
    requireCondition((await this.#run(["diff", "--name-only", baseSha, candidateSha])).length > 0, "candidate has no material tree change");
    const tree = await this.#run(["ls-tree", "-r", candidateSha]);
    for (const line of tree.split("\n").filter(Boolean)) requireCondition(/^(100644|100755) blob /.test(line), "candidate contains unsafe tree entry");
  }
  async remoteHead(branch: string): Promise<string | null> { validateRef(branch, "branch"); const output = await this.#run(["ls-remote", "--heads", this.remoteUrl, `refs/heads/${branch}`]); return output ? output.split(/\s+/)[0]! : null; }
  async push(branch: string, sha: string, expected: string | null): Promise<void> {
    validateRef(branch, "branch"); validateSha(sha); if (expected !== null) validateSha(expected, "expected remote SHA");
    const observed = await this.remoteHead(branch); requireCondition(observed === expected, "publication branch changed before push", "GIT_LEASE_CONFLICT");
    const lease = expected ?? "0000000000000000000000000000000000000000";
    await this.#run(["push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${lease}`, this.remoteUrl, `${sha}:refs/heads/${branch}`]);
    requireCondition(await this.remoteHead(branch) === sha, "published branch readback differs from candidate");
  }
}
