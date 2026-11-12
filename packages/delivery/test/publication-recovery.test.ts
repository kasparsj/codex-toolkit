import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { canonicalJson } from "../src/core.ts";
import { acquireDirectoryLockSync, readDirectoryLockOwnerSync, recoverDirectoryLockSync, releaseDirectoryLockSync } from "../src/locks.ts";
import { Publisher, publicationAuthorizationDigest } from "../src/publisher.ts";

const publisherModule = new URL("../src/publisher.ts", import.meta.url).href;

async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for fixture condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function childExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

function killChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
}

async function pullFixture(): Promise<{ root: string; remote: string; work: string; base: string; first: string; second: string; firstBundle: string; secondBundle: string }> {
  const root = await mkdtemp(join(tmpdir(), "delivery-pull-refusal-")), remote = join(root, "remote.git"), work = join(root, "work");
  mkdirSync(work); git(root, "init", "--bare", remote); git(work, "init");
  writeFileSync(join(work, "README.md"), "base\n"); git(work, "add", "README.md"); git(work, "commit", "-m", "base"); const base = git(work, "rev-parse", "HEAD"); git(work, "remote", "add", "origin", remote); git(work, "push", "origin", `${base}:refs/heads/main`);
  writeFileSync(join(work, "README.md"), "first\n"); git(work, "commit", "-am", "first"); const first = git(work, "rev-parse", "HEAD"), firstBundle = join(root, "first.bundle"); git(work, "branch", "first-bundle", first); git(work, "bundle", "create", firstBundle, "first-bundle"); chmodSync(firstBundle, 0o600);
  writeFileSync(join(work, "README.md"), "second\n"); git(work, "commit", "-am", "second"); const second = git(work, "rev-parse", "HEAD"), secondBundle = join(root, "second.bundle"); git(work, "branch", "second-bundle", second); git(work, "bundle", "create", secondBundle, "second-bundle"); chmodSync(secondBundle, 0o600);
  return { root, remote, work, base, first, second, firstBundle, secondBundle };
}

test("SIGKILL after accepted issue create is explicitly recovered without duplicate POST", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-publication-recovery-")), stateRoot = join(root, "state");
  let posts = 0, issue: Record<string, unknown> | null = null, accepted!: () => void;
  const acceptedPost = new Promise<void>((resolve) => { accepted = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (request.url?.startsWith("/repos/acme/tool/issues?") && request.method === "GET") return response.end(JSON.stringify(issue ? [issue] : []));
    if (request.url === "/repos/acme/tool/issues" && request.method === "POST") {
      posts += 1; let raw = ""; for await (const chunk of request) raw += chunk; const value = JSON.parse(raw);
      issue = { id: 1, node_id: "I_1", number: 1, title: value.title, body: value.body, repository_url: "https://api.github.com/repos/acme/tool", url: "https://api.github.com/repos/acme/tool/issues/1", html_url: "https://github.com/acme/tool/issues/1", user: { id: 7, login: "developer", type: "User" } };
      accepted();
      return;
    }
    if (request.url === "/repos/acme/tool/issues/1") return response.end(JSON.stringify(issue));
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const config = { repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot, remoteUrl: "https://github.com/acme/tool.git", transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true };
  const packet: Record<string, unknown> = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: "killed-create", operation_id: "issue-op", payload: { title: "Recovered", body: "Exact packet" } };
  packet.authorized_digest = publicationAuthorizationDigest(packet);
  const childCode = `const {Publisher}=await import(${JSON.stringify(publisherModule)});const config=${JSON.stringify(config)};config.tokenResolver=async()=>"fixture-token";await new Publisher(config).execute(${canonicalJson(packet)});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childCode], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = childExit(child);
  try {
    await acceptedPost; killChild(child); await exited;
    assert.equal(existsSync(join(stateRoot, "publisher.lock", "owner.json")), true);

    const publisher = new Publisher({ ...config, tokenResolver: async () => "fixture-token" });
    await publisher.recoverLock();
    const result = await publisher.execute(packet);
    assert.equal(result.status, "published"); assert.equal(posts, 1);
    const quarantines = readdirSync(stateRoot).filter((name) => name.startsWith("publisher.lock.recovery-"));
    assert.equal(quarantines.length, 1); assert.equal(existsSync(join(stateRoot, quarantines[0]!, "owner.json")), true);
  } finally { killChild(child); await exited; server.close(); await rm(root, { recursive: true, force: true }); }
});

test("a killed reclaimer leaves a permanent tombstone and does not wedge a fresh owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-reclaimer-recovery-")), lock = join(root, "publisher.lock"), renamed = join(root, "renamed");
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "owner.json"), canonicalJson({ schema_version: 1, pid: 99_999_999, process_identity: "dead", token: "dead-token", at: new Date(0).toISOString() }), { mode: 0o600 });
  const helper = new URL("../src/locks.ts", import.meta.url).href;
  const code = `import fs from"node:fs";import{syncBuiltinESMExports}from"node:module";const original=fs.renameSync;fs.renameSync=(from,to)=>{original(from,to);if(from===${JSON.stringify(lock)}){fs.writeFileSync(${JSON.stringify(renamed)},String(to));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60_000);}};syncBuiltinESMExports();const{recoverDirectoryLockSync}=await import(${JSON.stringify(`${helper}?killed`)});recoverDirectoryLockSync(${JSON.stringify(lock)});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: "ignore" });
  const exited = childExit(child);
  try {
    await waitFor(() => existsSync(renamed) && readFileSync(renamed, "utf8").length > 0); killChild(child); await exited;
    const quarantine = readFileSync(renamed, "utf8");
    assert.equal(existsSync(lock), false); assert.equal(existsSync(join(quarantine, "owner.json")), true);
    assert.equal(recoverDirectoryLockSync(lock), false);
    const fresh = acquireDirectoryLockSync(lock); releaseDirectoryLockSync(lock, fresh);
    assert.equal(existsSync(lock), false); assert.equal(existsSync(join(quarantine, "owner.json")), true);
  } finally { killChild(child); await exited; await rm(root, { recursive: true, force: true }); }
});

test("a crash before staged lock publication leaves the canonical lock available", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-staged-acquire-")), lock = join(root, "publisher.lock"), staged = join(root, "staged");
  const helper = new URL("../src/locks.ts", import.meta.url).href;
  const code = `import fs from"node:fs";import{syncBuiltinESMExports}from"node:module";const original=fs.renameSync;fs.renameSync=(from,to)=>{if(to===${JSON.stringify(lock)}&&String(from).startsWith(${JSON.stringify(`${lock}.acquire-`)})){fs.writeFileSync(${JSON.stringify(staged)},String(from));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60_000);}return original(from,to);};syncBuiltinESMExports();const{acquireDirectoryLockSync}=await import(${JSON.stringify(`${helper}?staged`)});acquireDirectoryLockSync(${JSON.stringify(lock)});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: "ignore" });
  const exited = childExit(child);
  try {
    await waitFor(() => existsSync(staged) && readFileSync(staged, "utf8").length > 0); killChild(child); await exited;
    assert.equal(existsSync(lock), false);
    const owner = acquireDirectoryLockSync(lock); releaseDirectoryLockSync(lock, owner); assert.equal(existsSync(lock), false);
  } finally { killChild(child); await exited; await rm(root, { recursive: true, force: true }); }
});

test("concurrent staged acquisitions publish exactly one canonical owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-concurrent-acquire-")), lock = join(root, "publisher.lock"), barrier = join(root, "barrier"), release = join(root, "release"), helper = new URL("../src/locks.ts", import.meta.url).href;
  const children = ["one", "two"].map((id) => {
    const ready = join(root, `ready-${id}`), outcome = join(root, `outcome-${id}`);
    const code = `import fs from"node:fs";const{acquireDirectoryLockSync,releaseDirectoryLockSync}=await import(${JSON.stringify(`${helper}?${id}`)});fs.writeFileSync(${JSON.stringify(ready)},"");while(!fs.existsSync(${JSON.stringify(barrier)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);try{const owner=acquireDirectoryLockSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(outcome)},"winner");while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);releaseDirectoryLockSync(${JSON.stringify(lock)},owner);}catch(error){fs.writeFileSync(${JSON.stringify(outcome)},"loser-"+String(error.code));}`;
    const spawned = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: "ignore" });
    return { process: spawned, exited: childExit(spawned), ready, outcome };
  });
  try {
    await waitFor(() => children.every((child) => existsSync(child.ready))); writeFileSync(barrier, "go");
    await waitFor(() => children.every((child) => existsSync(child.outcome) && readFileSync(child.outcome, "utf8").length > 0));
    const outcomes = children.map((child) => readFileSync(child.outcome, "utf8")).sort();
    assert.deepEqual(outcomes, ["loser-EEXIST", "winner"]);
    writeFileSync(release, "release"); await Promise.all(children.map((child) => child.exited));
  } finally {
    if (!existsSync(release)) writeFileSync(release, "release");
    for (const child of children) killChild(child.process);
    await Promise.all(children.map((child) => child.exited)); await rm(root, { recursive: true, force: true });
  }
});

test("a retiring owner cannot remove a freshly published successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-release-retirement-")), lock = join(root, "publisher.lock"), ready = join(root, "ready"), start = join(root, "start"), retired = join(root, "retired"), finish = join(root, "finish"), helper = new URL("../src/locks.ts", import.meta.url).href;
  const code = `import fs from"node:fs";import{syncBuiltinESMExports}from"node:module";const{acquireDirectoryLockSync}=await import(${JSON.stringify(`${helper}?acquire`)});const owner=acquireDirectoryLockSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(ready)},"");while(!fs.existsSync(${JSON.stringify(start)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);const original=fs.renameSync;fs.renameSync=(from,to)=>{const result=original(from,to);if(from===${JSON.stringify(lock)}&&String(to).startsWith(${JSON.stringify(`${lock}.release-`)})){fs.writeFileSync(${JSON.stringify(retired)},String(to));while(!fs.existsSync(${JSON.stringify(finish)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return result;};syncBuiltinESMExports();const{releaseDirectoryLockSync}=await import(${JSON.stringify(`${helper}?release`)});releaseDirectoryLockSync(${JSON.stringify(lock)},owner);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: "ignore" }), exited = childExit(child);
  let successor: ReturnType<typeof acquireDirectoryLockSync> | undefined;
  try {
    await waitFor(() => existsSync(ready)); writeFileSync(start, "start"); await waitFor(() => existsSync(retired));
    successor = acquireDirectoryLockSync(lock); writeFileSync(finish, "finish"); await exited;
    assert.equal(readDirectoryLockOwnerSync(lock).token, successor.token);
    assert.equal(existsSync(readFileSync(retired, "utf8")), false);
  } finally {
    if (!existsSync(finish)) writeFileSync(finish, "finish"); killChild(child); await exited;
    if (successor) releaseDirectoryLockSync(lock, successor);
    await rm(root, { recursive: true, force: true });
  }
});

test("a live PID with changed identity is never treated as dead", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-live-lock-")), lock = join(root, "publisher.lock");
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "owner.json"), canonicalJson({ schema_version: 1, pid: process.pid, process_identity: "not-the-current-start", token: "live-token", at: new Date().toISOString() }), { mode: 0o600 });
  assert.throws(() => recoverDirectoryLockSync(lock), /still alive/);
  assert.equal(existsSync(join(lock, "owner.json")), true);
  await rm(root, { recursive: true, force: true });
});

test("a legacy publisher lockfile is preserved and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-legacy-publisher-lock-"));
  writeFileSync(join(root, "publisher.lock"), canonicalJson({ pid: 99_999_999, started_at: new Date(0).toISOString() }), { mode: 0o600 });
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: root, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token" });
  await assert.rejects(() => publisher.recoverLock());
  assert.equal(existsSync(join(root, "publisher.lock")), true);
  await rm(root, { recursive: true, force: true });
});

test("confirmed pull create and update refusals remain terminal and are not replayed", { timeout: 20_000 }, async () => {
  const fixture = await pullFixture(); git(fixture.work, "push", "origin", `${fixture.first}:refs/heads/delivery/update`);
  let creates = 0, updates = 0;
  const prior = { number: 8, node_id: "PR_8", html_url: "https://github.com/acme/tool/pull/8", state: "open", draft: true, title: "old", body: "old", user: { id: 7, login: "developer" }, head: { ref: "delivery/update", sha: fixture.first, repo: { id: 42 } }, base: { ref: "main", sha: fixture.base, repo: { id: 42 } } };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" }));
    if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false }));
    if (request.url?.startsWith("/repos/acme/tool/pulls?") && request.method === "GET") { const head = new URL(request.url, "http://fixture").searchParams.get("head"); return response.end(JSON.stringify(head === "acme:delivery/update" ? [prior] : [])); }
    if (request.url === "/repos/acme/tool/pulls/8" && request.method === "GET") return response.end(JSON.stringify(prior));
    if (request.url === "/repos/acme/tool/pulls" && request.method === "POST") { creates += 1; response.statusCode = 422; return response.end(JSON.stringify({ message: "validation failed" })); }
    if (request.url === "/repos/acme/tool/pulls/8" && request.method === "PATCH") { updates += 1; response.statusCode = 422; return response.end(JSON.stringify({ message: "validation failed" })); }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, stateRoot: join(fixture.root, "state"), remoteUrl: fixture.remote, allowLocalRemote: true, transportBaseUrl: `http://127.0.0.1:${address.port}`, testOnly: true, tokenResolver: async () => "fixture-token" });
  const createPacket: Record<string, unknown> = { schema_version: 1, action: "publish_plan", repo: "acme/tool", delivery_id: "create-refused", operation_id: "op", expected: { head: "delivery/create", head_sha: fixture.first, base: "main", base_sha: fixture.base, previous_sha: null }, payload: { title: "new", body: "new", bundle: fixture.firstBundle, allowed_paths: ["README.md"] } }; createPacket.authorized_digest = publicationAuthorizationDigest(createPacket);
  await assert.rejects(() => publisher.execute(createPacket), (error: unknown) => (error as { code?: string }).code === "GITHUB_REFUSED");
  await assert.rejects(() => publisher.execute(createPacket)); assert.equal(creates, 1);
  const updatePacket: Record<string, unknown> = { schema_version: 1, action: "publish_implementation", repo: "acme/tool", delivery_id: "update-refused", operation_id: "op", expected: { number: 8, head: "delivery/update", head_sha: fixture.second, base: "main", base_sha: fixture.base, previous_sha: fixture.first }, payload: { title: "new", body: "new", bundle: fixture.secondBundle, allowed_paths: ["README.md"] } }; updatePacket.authorized_digest = publicationAuthorizationDigest(updatePacket);
  await assert.rejects(() => publisher.execute(updatePacket), (error: unknown) => (error as { code?: string }).code === "GITHUB_REFUSED");
  await assert.rejects(() => publisher.execute(updatePacket)); assert.equal(updates, 1);
  server.close(); await rm(fixture.root, { recursive: true, force: true });
});

test("publisher rejects a state-root symlink and detects retargeting before protected writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-publisher-root-")), actual = join(root, "actual"), linked = join(root, "linked");
  mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, linked);
  const base = { repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token", testOnly: true };
  const packet: Record<string, unknown> = { schema_version: 1, action: "publish_issue", repo: "acme/tool", delivery_id: "symlink-root", operation_id: "op", payload: { title: "T", body: "B" } }; packet.authorized_digest = publicationAuthorizationDigest(packet);
  assert.throws(() => new Publisher({ ...base, stateRoot: linked }), /symbolic link|unsafe state path/);

  const stateRoot = join(root, "state"), displaced = join(root, "displaced"), target = join(root, "target"); mkdirSync(stateRoot, { mode: 0o700 }); mkdirSync(target, { mode: 0o700 });
  let releaseUser!: () => void; const userRelease = new Promise<void>((resolve) => { releaseUser = resolve; }); let userSeen!: () => void; const sawUser = new Promise<void>((resolve) => { userSeen = resolve; });
  const server = createServer(async (request, response) => { response.setHeader("content-type", "application/json"); if (request.url === "/user") { userSeen(); await userRelease; return response.end(JSON.stringify({ id: 7, login: "developer", type: "User" })); } if (request.url === "/repos/acme/tool") return response.end(JSON.stringify({ id: 42, full_name: "acme/tool", private: false })); response.end("[]"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
  const publisher = new Publisher({ ...base, stateRoot, transportBaseUrl: `http://127.0.0.1:${address.port}` });
  const exactPacket: Record<string, unknown> = { ...packet, delivery_id: "retarget-root" }; exactPacket.authorized_digest = publicationAuthorizationDigest(exactPacket);
  const raced = publisher.execute(exactPacket); await sawUser; renameSync(stateRoot, displaced); symlinkSync(target, stateRoot); releaseUser();
  await assert.rejects(raced, /symbolic link|unsafe state path|identity changed/);
  assert.deepEqual(readdirSync(target), []);
  server.close(); await rm(root, { recursive: true, force: true });
});

test("publisher constructor rejects a writable non-sticky future parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "delivery-publisher-parent-")), unsafe = join(root, "unsafe"), sticky = join(root, "sticky");
  mkdirSync(unsafe, { mode: 0o700 }); chmodSync(unsafe, 0o777); mkdirSync(sticky, { mode: 0o700 }); chmodSync(sticky, 0o1777);
  const config = { repo: "acme/tool", repositoryId: 42, login: "developer", actorId: 7, remoteUrl: "https://github.com/acme/tool.git", tokenResolver: async () => "fixture-token" };
  assert.throws(() => new Publisher({ ...config, stateRoot: join(unsafe, "state") }), /writable by other users/);
  assert.doesNotThrow(() => new Publisher({ ...config, stateRoot: join(sticky, "state") }));
  await rm(root, { recursive: true, force: true });
});
