import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FOREGROUND_BACKOFF_CAP_MS, FOREGROUND_POLL_MS, ForegroundSupervisor, nextBackoff, validateForegroundPolicy } from "../src/foreground.ts";
import { DeliveryEngine } from "../src/engine.ts";
import { GitHubUnavailable } from "../src/github.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";

test("foreground scheduling defaults and protected switches are explicit", () => {
  assert.equal(FOREGROUND_POLL_MS, 15_000); assert.equal(nextBackoff(240_000), FOREGROUND_BACKOFF_CAP_MS);
  const value = validateForegroundPolicy({ schema_version: 1, repository: "owner/repo", repository_id: 10, auto_schedule: false, pr_publication: "explicit", issue_publication: "off" }, "owner/repo");
  assert.equal(value.auto_schedule, false);
  assert.throws(() => validateForegroundPolicy({ ...value, executable: "/tmp/run" }, "owner/repo"), /unsupported/);
});

test("server retry deadlines override the ordinary polling backoff cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-retry-deadline-"));
  try {
    const engine = new DeliveryEngine({ store: new FileStateStore(root) });
    const p = policy(); engine.start({ repo: "owner/repo", issue: 1, policy: p });
    engine.dispatch = async () => { throw new GitHubUnavailable("fixture rate limit", 1000); };
    const delays: number[] = [];
    const supervisor = new ForegroundSupervisor({ engine, repo: "owner/repo", policy: p, policyConfig: { schema_version: 1, repository: "owner/repo", repository_id: 10, auto_schedule: false, pr_publication: "off", issue_publication: "off" }, sleep: async (delay) => { delays.push(delay); supervisor.stop(); } });
    await supervisor.run();
    assert.deepEqual(delays, [1_000_000]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("foreground shares cancellation reconciliation and contains observer rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-foreground-cancel-"));
  try {
    const engine = new DeliveryEngine({ store: new FileStateStore(root) }), p = policy(); let calls = 0;
    const completed = new ForegroundSupervisor({ engine, repo: "owner/repo", policy: p, policyConfig: { schema_version: 1, repository: "owner/repo", repository_id: 10, auto_schedule: false, pr_publication: "off", issue_publication: "off" }, reconcileCancellation: async () => { calls += 1; return true; } });
    assert.equal(await completed.tick(), undefined); assert.equal(calls, 1);
    const statuses: string[] = [], held = new ForegroundSupervisor({ engine, repo: "owner/repo", policy: p, policyConfig: { schema_version: 1, repository: "owner/repo", repository_id: 10, auto_schedule: false, pr_publication: "off", issue_publication: "off" }, reconcileCancellation: async () => { throw new Error("observer changed"); }, onStatus(status) { statuses.push(status); } });
    assert.equal(await held.tick(), undefined); assert.deepEqual(statuses, ["operator_hold", "idle"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
