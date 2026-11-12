import assert from "node:assert/strict";
import test from "node:test";
import { applyMutationSnapshot, mutationOrigin, type DeliveryQueryKey } from "../client/mutation-scope.ts";
import type { DeliverySnapshot } from "../shared/rpc.ts";

const SHA = "a".repeat(40);

function snapshot(repo: string, root: string, scope: string, runnerStatus: "running" | "stopped"): DeliverySnapshot {
  return {
    schemaVersion: 1, generatedAt: "2026-11-11T18:00:00Z", scopeDigest: scope,
    identity: { repo, gitRoot: root, commonDir: `${root}/.git`, worktree: root, branch: "main", head: SHA },
    setup: { configured: true, revision: 1, defaultProfilePath: "/protected/profile.json", problems: [] },
    runner: { revision: 1, status: runnerStatus, desiredState: runnerStatus, observedState: runnerStatus === "running" ? "alive" : "not_running", deliveryId: "same-delivery" },
    runs: [{ repo, deliveryId: "same-delivery", status: runnerStatus, revision: 1, updatedAt: "2026-11-11T18:00:00Z", stale: false, evidenceStale: false, stages: [], blockers: [], evidence: [], history: [], unresolvedEffects: [], availableActions: [] }],
    operatorActions: [], warnings: [],
  };
}

function cacheId(key: DeliveryQueryKey): string { return key.join("|"); }

test("a delayed response from another host cannot alter current controls or selection", () => {
  const keyA = ["toolkit-delivery", "host-a", "workspace-a"] as const, keyB = ["toolkit-delivery", "host-b", "workspace-b"] as const;
  const beforeA = snapshot("owner/repo-a", "/repo-a", "a".repeat(64), "stopped"), afterA = snapshot("owner/repo-a", "/repo-a", "a".repeat(64), "running");
  const currentB = snapshot("owner/repo-b", "/repo-b", "b".repeat(64), "stopped");
  const originA = mutationOrigin("host-a", "workspace-a", keyA, beforeA), originB = mutationOrigin("host-b", "workspace-b", keyB, currentB);
  const cache = new Map([[cacheId(keyA), beforeA], [cacheId(keyB), currentB]]); const selection = { scope: originB.scopeDigest, deliveryId: "same-delivery" }; let currentUncertainty = "repo-b-network-state";
  const result = applyMutationSnapshot({ origin: originA, snapshot: afterA, current: originB, cached: cache.get(cacheId(keyA)), write: (value) => cache.set(cacheId(keyA), value), clearCurrentFeedback: () => { currentUncertainty = ""; } });
  assert.equal(result, "background");
  assert.equal(cache.get(cacheId(keyA))?.runner.status, "running");
  assert.equal(cache.get(cacheId(keyB))?.identity.repo, "owner/repo-b");
  assert.equal(cache.get(cacheId(keyB))?.runner.status, "stopped");
  assert.deepEqual(selection, { scope: originB.scopeDigest, deliveryId: "same-delivery" });
  assert.equal(currentUncertainty, "repo-b-network-state");
});

test("a delayed response cannot overwrite a rebound repository sharing one workspace key", () => {
  const key = ["toolkit-delivery", "host-a", "workspace-shared"] as const;
  const beforeA = snapshot("owner/repo-a", "/repo-a", "a".repeat(64), "stopped"), afterA = snapshot("owner/repo-a", "/repo-a", "a".repeat(64), "running");
  const reboundB = snapshot("owner/repo-b", "/repo-b", "b".repeat(64), "stopped");
  const originA = mutationOrigin("host-a", "workspace-shared", key, beforeA), originB = mutationOrigin("host-a", "workspace-shared", key, reboundB);
  let cached = reboundB, selection = { scope: originB.scopeDigest, deliveryId: "same-delivery" }, cleared = false;
  const result = applyMutationSnapshot({ origin: originA, snapshot: afterA, current: originB, cached, write: (value) => { cached = value; selection = { scope: value.scopeDigest, deliveryId: value.runs[0]?.deliveryId ?? "" }; }, clearCurrentFeedback: () => { cleared = true; } });
  assert.equal(result, "stale");
  assert.equal(cached.identity.repo, "owner/repo-b");
  assert.equal(cached.runner.status, "stopped");
  assert.deepEqual(selection, { scope: originB.scopeDigest, deliveryId: "same-delivery" });
  assert.equal(cleared, false);
});
