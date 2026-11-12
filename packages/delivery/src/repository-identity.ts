import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { requireCondition } from "./core.ts";

export interface RepositoryIdentity { repo: string; gitRoot: string; commonDir: string; worktree: string; branch: string | null; head: string }

function git(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error(`cannot resolve Git workspace (${args.join(" ")})`); }
}

function canonicalGithubRemote(remote: string): string {
  requireCondition(remote.startsWith("ssh://git@github.com/") || !/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(remote), "credential-bearing Git origin is unsupported");
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  requireCondition(match, "origin must be an uncredentialed GitHub SSH or HTTPS repository");
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function resolveRepository(directory: string): RepositoryIdentity {
  requireCondition(isAbsolute(directory) && resolve(directory) === directory, "workspace directory must be absolute and normalized");
  const canonicalDirectory = realpathSync(directory);
  const worktree = realpathSync(git(canonicalDirectory, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  const commonDir = realpathSync(git(canonicalDirectory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const remotes = git(canonicalDirectory, ["remote", "get-url", "--all", "origin"]).split(/\r?\n/).filter(Boolean);
  requireCondition(remotes.length === 1, "workspace must have exactly one origin URL");
  const repo = canonicalGithubRemote(remotes[0]!);
  const head = git(canonicalDirectory, ["rev-parse", "HEAD"]);
  requireCondition(/^[0-9a-f]{40}$/.test(head), "workspace HEAD is not a full commit SHA");
  let branch: string | null = null;
  try { branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: canonicalDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { branch = null; }
  return { repo, gitRoot: worktree, commonDir, worktree, branch, head };
}
