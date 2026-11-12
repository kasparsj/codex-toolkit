import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine } from "../src/engine.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";

async function waitFor(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("timed out waiting for store race fixture"); }

test("state writes are private, revision-fenced, and one claim is active", () => {
  const root = mkdtempSync(join(tmpdir(), "state-")); const store = new FileStateStore(root); const engine = new DeliveryEngine({ store });
  const state = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "one", policy: policy() });
  assert.equal(lstatSync(store.statePath(state.repo, state.delivery_id)).mode & 0o777, 0o600);
  assert.throws(() => engine.start({ repo: "OWNER/REPO", issue: 2, deliveryId: "two", policy: policy() }), /already claimed/);
  const next = store.mutate(state.repo, state.delivery_id, state.revision, (value) => value);
  assert.equal(next.revision, 2);
  assert.throws(() => store.mutate(state.repo, state.delivery_id, state.revision, (value) => value), /stale state revision/);
});

test("symlink state roots are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "state-link-")); const target = mkdtempSync(join(tmpdir(), "state-target-")); chmodSync(target, 0o700); const link = join(root, "link"); symlinkSync(target, link);
  assert.throws(() => new FileStateStore(link), /unsafe state path component|symbolic link/);
});

test("intermediate symlinks cannot redirect state creation", () => {
  const root = mkdtempSync(join(tmpdir(), "state-parent-link-")), target = mkdtempSync(join(tmpdir(), "state-parent-target-")), link = join(root, "link"), requested = join(link, "state");
  chmodSync(target, 0o700); symlinkSync(target, link);
  assert.throws(() => new FileStateStore(requested), /unsafe state path component/);
  assert.equal(existsSync(join(target, "state")), false);
});

test("state operations refuse a replaced root identity", () => {
  const parent = mkdtempSync(join(tmpdir(), "state-replaced-root-")), root = join(parent, "state"), displaced = join(parent, "displaced"), store = new FileStateStore(root);
  renameSync(root, displaced); mkdirSync(root, { mode: 0o700 });
  assert.throws(() => store.scan(), /state directory identity changed/);
  assert.throws(() => store.writeProtected(join(root, "protected.json"), { safe: false }), /state directory identity changed/);
  assert.equal(existsSync(join(root, "protected.json")), false);
});

test("protected reads refuse a child directory replaced by a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "state-child-link-swap-")), store = new FileStateStore(root), child = join(root, "child"), displaced = join(root, "child-displaced"), record = join(child, "record.json");
  store.writeProtected(record, { accepted: false }); renameSync(child, displaced); symlinkSync(displaced, child);
  assert.throws(() => store.readProtected(record), /unsafe state path component/);
});

test("state creation does not chmod an existing safe ancestor", () => {
  const root = mkdtempSync(join(tmpdir(), "state-existing-ancestor-")), ancestor = join(root, "shared"), state = join(ancestor, "state");
  mkdirSync(ancestor, { mode: 0o755 }); new FileStateStore(state);
  assert.equal(lstatSync(ancestor).mode & 0o777, 0o755);
});

test("two first-use processes tolerate the same private registry directory winning mkdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "state-first-use-race-")), shared = join(root, "registry", "locks"), barrier = join(root, "barrier"), moduleUrl = new URL("../src/store.ts", import.meta.url).href;
  const children = ["one", "two"].map((id) => {
    const ready = join(root, `ready-${id}`), code = `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.mkdirSync;fs.mkdirSync=(path,options)=>{if(path===${JSON.stringify(shared)}){fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(barrier)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return original(path,options)};syncBuiltinESMExports();const{FileStateStore}=await import(${JSON.stringify(`${moduleUrl}?${id}`)});new FileStateStore(${JSON.stringify(shared)});`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] }), exited = new Promise<number | null>((resolve) => child.once("exit", resolve)); let error = ""; child.stderr.setEncoding("utf8").on("data", (chunk) => { error += chunk; }); return { child, exited, ready, error: () => error };
  });
  await waitFor(() => children.every((child) => existsSync(child.ready))); writeFileSync(barrier, "go");
  const exits = await Promise.all(children.map((child) => child.exited)); assert.deepEqual(exits, [0, 0], children.map((child) => child.error()).join("\n")); const info = lstatSync(shared); assert.equal(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, true);
});

test("scan retains valid runs and returns sanitized corrupt-source diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "state-scan-")); const store = new FileStateStore(root); const engine = new DeliveryEngine({ store }); engine.start({ repo: "owner/repo", issue: 1, deliveryId: "good", policy: policy() });
  store.writeProtected(store.statePath("owner/repo", "bad"), { schema_version: 2, repo: "owner/repo", delivery_id: "bad" });
  const result = store.scan("owner/repo"); assert.deepEqual(result.states.map((state) => state.delivery_id), ["good"]); assert.deepEqual(result.diagnostics, [{ code: "INVALID_SOURCE", source: "bad", message: "A retained run source is invalid or unavailable." }]);
});

test("scans isolate repository and delivery directory identities while retaining valid records", () => {
  const root = mkdtempSync(join(tmpdir(), "state-scan-identity-")), store = new FileStateStore(root), engine = new DeliveryEngine({ store }), valid = engine.start({ repo: "owner/repo", issue: 1, deliveryId: "good", policy: policy() });
  const foreignStore = new FileStateStore(mkdtempSync(join(tmpdir(), "state-scan-foreign-"))), foreign = new DeliveryEngine({ store: foreignStore }).start({ repo: "other/repo", issue: 2, deliveryId: "foreign", policy: policy() });
  const deliveries = join(store.repoDir("owner/repo"), "deliveries");
  store.writeProtected(join(deliveries, "foreign", "state.json"), foreign);
  store.writeProtected(join(deliveries, "wrong-directory", "state.json"), valid);
  store.writeProtected(join(deliveries, "bad.name", "state.json"), valid);
  const expectedDiagnostics = ["bad?name", "foreign", "wrong-directory"].map((source) => ({ code: "INVALID_SOURCE", source, message: "A retained run source is invalid or unavailable." }));
  for (const result of [store.scan("OWNER/REPO"), store.scan()]) {
    assert.deepEqual(result.states.map((state) => state.delivery_id), ["good"]);
    assert.deepEqual(result.diagnostics, expectedDiagnostics);
  }
});
