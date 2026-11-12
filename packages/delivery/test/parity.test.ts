import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalJson, repoIdentity } from "../src/core.ts";
import { evaluateReviews, gateRoute, reviewContext } from "../src/reviews.ts";

interface OracleCase {
  function: string;
  input: unknown;
  output?: unknown;
  error?: string;
}
const corpus = JSON.parse(readFileSync(new URL("./fixtures/legacy-parity.json", import.meta.url), "utf8")) as { sourceSha256: string; cases: OracleCase[] };
const supported = new Set(["canonical_json", "repo_identity", "gate_route", "review_context", "evaluate_reviews"]);

function call(item: OracleCase): unknown {
  if (item.function === "canonical_json") return canonicalJson(item.input);
  if (item.function === "repo_identity") return repoIdentity(item.input as string);
  if (item.function === "review_context") return reviewContext(item.input as Parameters<typeof reviewContext>[0]);
  if (item.function === "evaluate_reviews") return evaluateReviews(item.input as Parameters<typeof evaluateReviews>[0]);
  const input = item.input as Record<string, boolean>;
  return gateRoute(input.plan_gate, input.implementation_gate, {
    planApproved: input.plan_approved,
    implementationApproved: input.implementation_approved,
  });
}

test("the differential oracle is pinned to an exact original source", () => {
  assert.match(corpus.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(corpus.cases.length, 116);
});

for (const [index, item] of corpus.cases.entries()) {
  if (!supported.has(item.function)) continue;
  test(`original-source differential ${index}: ${item.function}`, () => {
    if (item.error !== undefined) assert.throws(() => call(item));
    else assert.deepEqual(call(item), item.output);
  });
}

test("canonical ordering remains lexical for integer-like property names", () => {
  assert.equal(canonicalJson({ "2": "two", "10": "ten", a: "a" }), '{"10":"ten","2":"two","a":"a"}');
});
