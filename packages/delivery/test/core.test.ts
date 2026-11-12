import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, digest, repoIdentity } from "../src/core.ts";
import { evaluateReviews, gateRoute, reviewBody } from "../src/reviews.ts";

test("canonical JSON matches Python ASCII and lexical-key semantics", () => {
  assert.equal(canonicalJson({ z: "Rīga 😀", "2": 2, "10": 10 }), '{"10":10,"2":2,"z":"R\\u012bga \\ud83d\\ude00"}');
  assert.equal(digest({ b: 2, a: 1 }), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  assert.equal(repoIdentity("Owner/Repo"), "github.com/owner/repo");
});

test("latest exact review wins and reject vetoes", () => {
  const body = reviewBody("plan", 2, "a".repeat(64), "approve");
  const verdict = evaluateReviews({ reviews: [
    { id: 1, user: { id: 9, type: "User" }, state: "COMMENTED", commit_id: "b".repeat(40), body, submitted_at: "2026-01-01T00:00:00Z" },
    { id: 2, user: { id: 9, type: "User" }, state: "COMMENTED", commit_id: "b".repeat(40), body: reviewBody("plan", 2, "a".repeat(64), "reject"), submitted_at: "2026-01-02T00:00:00Z" },
  ], stage: "plan", generation: 2, context_digest: "a".repeat(64), commit_id: "b".repeat(40), authorized_ids: [9], publisher_id: 7, minimum: 1, require_human: true });
  assert.deepEqual(verdict.rejectors, [9]); assert.equal(verdict.approved, false);
  assert.equal(gateRoute(false, false), "publication_pending");
  assert.equal(gateRoute(true, false), "plan_review");
  assert.equal(gateRoute(false, true), "implementation_review");
});

test("local developer mode may count the allowlisted human publisher review", () => {
  const body = reviewBody("plan", 1, "a".repeat(64), "approve"); const review = { id: 3, user: { id: 7, type: "User" }, state: "COMMENTED", commit_id: "b".repeat(40), body, submitted_at: "2026-01-01T00:00:00Z" };
  const common = { reviews: [review], stage: "plan", generation: 1, context_digest: "a".repeat(64), commit_id: "b".repeat(40), authorized_ids: [7], publisher_id: 7, minimum: 1, require_human: true };
  assert.equal(evaluateReviews(common).approved, false);
  assert.equal(evaluateReviews({ ...common, allow_publisher_review: true }).approved, true);
});
