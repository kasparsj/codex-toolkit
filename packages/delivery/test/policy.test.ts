import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../src/core.ts";
import { loadPolicy } from "../src/policy.ts";

const TOML = `version = 1
[delivery]
final_target = "main"
publisher_id = 7
require_github_actions = true
[branches]
default_parent = "main"
plan_template = "plan/{issue}"
implementation_template = "impl/{issue}"
allowed_parent_prefixes = ["main"]
[eligibility]
required_labels = []
excluded_labels = []
[approvals.plan]
minimum = 1
reviewer_ids = [7]
[approvals.implementation]
minimum = 0
reviewer_ids = []
`;
test("policy verifies raw provenance and local developer may also be reviewer", () => {
  const root = mkdtempSync(join(tmpdir(), "policy-")); const path = join(root, "delivery.toml"); writeFileSync(path, TOML);
  const fetchedAt = new Date().toISOString();
  const policy = loadPolicy(path, { expectedDigest: digest(Buffer.from(TOML)), sourceRef: "refs/heads/main", sourceSha: "1".repeat(40), fetchedAt });
  assert.equal(policy.approvals.plan.reviewer_ids[0], 7);
  assert.throws(() => loadPolicy(path, { expectedDigest: "0".repeat(64), sourceRef: "refs/heads/main", sourceSha: "1".repeat(40), fetchedAt }), /digest mismatch/);
  assert.throws(() => loadPolicy(path, { expectedDigest: digest(Buffer.from(TOML)), sourceRef: "refs/heads/main", sourceSha: "1".repeat(40), fetchedAt: new Date(Date.now() + 1000).toISOString() }), /future/);
});
