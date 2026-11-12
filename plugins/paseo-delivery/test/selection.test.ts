import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRunSelection, storedRunSelection } from "../client/selection.ts";

test("empty run lists settle without manufacturing a selection", () => {
  assert.equal(reconcileRunSelection(undefined, []), undefined);
  assert.equal(reconcileRunSelection(undefined, []), undefined);
});

test("selection reconciliation preserves a visible run and replaces a stale one once", () => {
  assert.equal(reconcileRunSelection("run-2", ["run-1", "run-2"]), "run-2");
  assert.equal(reconcileRunSelection("old-repository-run", ["run-1", "run-2"]), "run-1");
  assert.equal(reconcileRunSelection("run-1", ["run-1", "run-2"]), "run-1");
});

test("stored selection is accepted only as a string", () => {
  assert.equal(storedRunSelection({ selected: "run-1" }), "run-1");
  assert.equal(storedRunSelection({ scope: "repo-scope-a", selected: "run-1" }, "repo-scope-a"), "run-1");
  assert.equal(storedRunSelection({ scope: "repo-scope-a", selected: "run-1" }, "repo-scope-b"), undefined);
  assert.equal(storedRunSelection({ selected: 1 }), undefined);
  assert.equal(storedRunSelection(undefined), undefined);
});
