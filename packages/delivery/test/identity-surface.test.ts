import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RepositoryIdentity } from "../src/repository-identity.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, GIT_AUTHOR_NAME: "Delivery fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Delivery fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  } }).trim();
}

function resolveInProcess(directory: string): { code: number | null; identity?: RepositoryIdentity; error?: string } {
  const module = new URL("../src/repository-identity.ts", import.meta.url).href;
  const script = `import{resolveRepository}from ${JSON.stringify(module)};try{console.log(JSON.stringify({identity:resolveRepository(process.argv[1])}))}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=2}`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, directory], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return { code: result.status, ...JSON.parse(result.stdout) };
}

test("identity processes retain canonical checkout provenance and explicit detached HEAD", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-identity-surface-"))), work = join(root, "work"); mkdirSync(work);
  try {
    git(work, "init", "-b", "main"); git(work, "commit", "--allow-empty", "-m", "fixture");
    git(work, "remote", "add", "origin", "https://github.com/Owner/Repository.git");
    const head = git(work, "rev-parse", "HEAD"), nested = join(work, "nested"); mkdirSync(nested);
    for (const remote of ["https://github.com/Owner/Repository.git", "https://github.com/Owner/Repository/", "git@github.com:Owner/Repository.git", "ssh://git@github.com/Owner/Repository.git"]) {
      git(work, "remote", "set-url", "origin", remote);
      const result = resolveInProcess(nested); assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(result.identity, { repo: "owner/repository", gitRoot: work, worktree: work, commonDir: join(work, ".git"), branch: "main", head });
    }
    const related = join(root, "related"); git(work, "worktree", "add", "-b", "related", related);
    const sibling = resolveInProcess(related); assert.equal(sibling.code, 0);
    assert.equal(sibling.identity?.commonDir, join(work, ".git")); assert.equal(sibling.identity?.worktree, related);
    assert.equal(sibling.identity?.branch, "related"); assert.equal(sibling.identity?.repo, "owner/repository");
    git(work, "checkout", "--detach", head);
    const detached = resolveInProcess(work); assert.equal(detached.code, 0);
    assert.equal(detached.identity?.branch, null); assert.equal(detached.identity?.head, head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("identity processes refuse missing, ambiguous, malformed and credential-bearing origins", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delivery-invalid-origin-"))), work = join(root, "work"), empty = join(root, "empty"); mkdirSync(work); mkdirSync(empty);
  try {
    git(work, "init", "-b", "main"); git(work, "commit", "--allow-empty", "-m", "fixture");
    assert.equal(resolveInProcess(empty).code, 2);
    const missing = resolveInProcess(work); assert.equal(missing.code, 2); assert.match(missing.error!, /cannot resolve Git workspace/);
    git(work, "remote", "add", "origin", "https://github.com/owner/repository.git");
    for (const remote of ["https://token@github.com/owner/repository.git", "https://user:password@github.com/owner/repository.git", "ssh://other@github.com/owner/repository.git", "https://gitlab.com/owner/repository.git", "https://github.com/owner", "https://github.com/owner/repository/extra", "https://github.com/owner/repository.git?token=fixture", "/tmp/local-only.git"]) {
      git(work, "remote", "set-url", "origin", remote);
      const result = resolveInProcess(work); assert.equal(result.code, 2, remote);
      assert.match(result.error!, /credential-bearing|origin must be/);
    }
    git(work, "remote", "set-url", "origin", "https://github.com/owner/repository.git");
    git(work, "config", "--add", "remote.origin.url", "https://github.com/owner/another.git");
    const multiple = resolveInProcess(work); assert.equal(multiple.code, 2); assert.match(multiple.error!, /exactly one origin URL/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
