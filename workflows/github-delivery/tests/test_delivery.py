from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest


MODULE = Path(__file__).parents[1] / "delivery.py"
SPEC = importlib.util.spec_from_file_location("github_delivery", MODULE)
delivery = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(delivery)
sys.modules["delivery"] = delivery


POLICY = """\
version = 1
[delivery]
final_target = "main"
publisher_id = 900
policy_max_age_seconds = 3600
[eligibility]
required_labels = ["ready"]
excluded_labels = ["blocked"]
[branches]
default_parent = "main"
allowed_parent_prefixes = ["main", "stack/"]
plan_template = "codex/plan-{issue}"
implementation_template = "codex/issue-{issue}"
[tracking]
review_label = "status: review"
[approvals.plan]
minimum = 1
reviewer_ids = [101, 102]
[approvals.implementation]
minimum = 1
reviewer_ids = [101, 102]
"""


class FakeGitHub:
    """Test-only file transport with injectable post-acceptance failure."""
    def __init__(self, path):
        self.path = path
        if not path.exists():
            delivery.atomic_json(path, {"prs": [], "refs": {}, "issues": {}, "next_pr": 1, "failures": {}})
    def configure_failure(self, operation, mode):
        data = delivery.read_json(self.path); data["failures"][operation] = mode; delivery.atomic_json(self.path, data)
    def find_prs(self, expected):
        data = delivery.read_json(self.path)
        return [pr for pr in data["prs"] if all(pr.get(key) == expected.get(key)
            for key in ("repo", "head", "head_sha", "base", "delivery_id", "plan_revision"))]
    def apply(self, kind, payload):
        data = delivery.read_json(self.path)
        if kind == "create_pr":
            result = {**payload, "number": data["next_pr"], "draft": True, "state": "OPEN"}
            data["next_pr"] += 1; data["prs"].append(result)
        elif kind == "track_issue":
            delivery.require(payload["label"] in payload["existing_labels"], "publisher may not create a label")
            result = {"labels": [payload["label"]]}
        else:
            result = dict(payload)
        delivery.atomic_json(self.path, data)
        mode = data["failures"].pop(kind, None); delivery.atomic_json(self.path, data)
        if mode == "after_accept": raise delivery.DeliveryError(f"ambiguous {kind}: accepted before checkpoint")
        return result


class DeliveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.skills = self.root / "skills"
        for name in delivery.SKILLS:
            path = self.skills / name / "SKILL.md"
            path.parent.mkdir(parents=True)
            path.write_text(f"# {name}\n")
        self.policy_path = self.root / "delivery.toml"
        self.policy_path.write_text(POLICY)
        self.digest = delivery.digest_bytes(self.policy_path.read_bytes())
        self.now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

    def tearDown(self):
        self.temp.cleanup()

    def policy(self, *, fetched_at=None):
        return delivery.load_policy(
            self.policy_path,
            expected_digest=self.digest,
            source_ref="refs/remotes/origin/main",
            source_sha="a" * 40,
            fetched_at=fetched_at or self.now.isoformat(),
            now=self.now,
        )

    def start(self, issue=42, delivery_id="delivery-42"):
        return delivery.Coordinator(self.root / "state").start(
            repo="github.test/acme/widget", issue=issue, policy=self.policy(),
            skills_root=self.skills, delivery_id=delivery_id,
        )

    def test_all_four_gate_modes(self):
        expected = {
            (False, False): "publication_pending",
            (True, False): "plan_review",
            (False, True): "implementation_review",
            (True, True): "plan_review",
        }
        for gates, status in expected.items():
            with self.subTest(gates=gates):
                self.assertEqual(delivery.gate_route(*gates), status)
                self.assertEqual(
                    delivery.gate_route(*gates, plan_approved=True, implementation_approved=True),
                    "publication_pending",
                )

    def test_stale_policy_and_digest_are_fail_closed(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "stale"):
            self.policy(fetched_at=(self.now - dt.timedelta(hours=2)).isoformat())
        with self.assertRaisesRegex(delivery.DeliveryError, "digest"):
            delivery.load_policy(self.policy_path, expected_digest="0" * 64,
                source_ref="refs/remotes/origin/main", source_sha="a" * 40,
                fetched_at=self.now.isoformat(), now=self.now)

    def test_require_github_actions_must_be_a_boolean(self):
        for setting in ("false", '"false"'):
            policy = POLICY.replace("[delivery]", f"[delivery]\nrequire_github_actions = {setting}")
            self.policy_path.write_text(policy)
            self.digest = delivery.digest_bytes(self.policy_path.read_bytes())
            if setting == "false":
                self.assertIs(self.policy()["delivery"]["require_github_actions"], False)
            else:
                with self.assertRaisesRegex(delivery.DeliveryError, "require_github_actions must be a boolean"):
                    self.policy()

    def test_review_head_base_and_rejection(self):
        context = delivery.review_context(stage="plan", generation=1, issue=42,
            material_hashes={"plan.md": "1" * 64}, baseline_sha="b" * 40,
            base_repo="github.test/acme/widget", base_ref="stack/parent", base_sha="c" * 40,
            final_repo="github.test/acme/widget", final_ref="main", policy_digest=self.digest)
        body = delivery.review_body("plan", 1, context, "approve")
        reviews = [{"id": 1, "user": {"id": 101}, "state": "COMMENTED", "dismissed": False,
                    "commit_id": "d" * 40, "body": body, "submitted_at": "2026-01-01T00:00:00Z"}]
        accepted = delivery.evaluate_reviews(reviews, stage="plan", generation=1,
            context_digest=context, commit_id="d" * 40, authorized_ids=[101, 102],
            publisher_id=900, minimum=1)
        self.assertTrue(accepted["approved"])
        self.assertFalse(delivery.evaluate_reviews(reviews, stage="plan", generation=1,
            context_digest=context, commit_id="e" * 40, authorized_ids=[101, 102],
            publisher_id=900, minimum=1)["approved"])
        changed_base = delivery.review_context(stage="plan", generation=1, issue=42,
            material_hashes={"plan.md": "1" * 64}, baseline_sha="b" * 40,
            base_repo="github.test/acme/widget", base_ref="stack/other", base_sha="c" * 40,
            final_repo="github.test/acme/widget", final_ref="main", policy_digest=self.digest)
        self.assertNotEqual(context, changed_base)
        reviews.append({"id": 2, "user": {"id": 101}, "state": "COMMENTED", "dismissed": False,
            "commit_id": "d" * 40, "body": delivery.review_body("plan", 1, context, "reject"),
            "submitted_at": "2026-01-01T00:01:00Z"})
        rejected = delivery.evaluate_reviews(reviews, stage="plan", generation=1,
            context_digest=context, commit_id="d" * 40, authorized_ids=[101, 102],
            publisher_id=900, minimum=1)
        self.assertFalse(rejected["approved"]); self.assertEqual(rejected["rejectors"], [101])

    def test_malformed_dismissed_and_publisher_reviews_do_not_count(self):
        common = {"state": "COMMENTED", "commit_id": "a" * 40,
                  "submitted_at": "2026-01-01T00:00:00Z"}
        reviews = [
            {**common, "id": 1, "user": {"id": 101}, "dismissed": True,
             "body": "delivery-review plan 1 digest approve"},
            {**common, "id": 2, "user": {"id": 900}, "dismissed": False,
             "body": "delivery-review plan 1 digest approve"},
            {**common, "id": 3, "user": {"id": 102}, "dismissed": False, "body": "approve"},
        ]
        result = delivery.evaluate_reviews(reviews, stage="plan", generation=1,
            context_digest="digest", commit_id="a" * 40, authorized_ids=[101, 102],
            publisher_id=900, minimum=1)
        self.assertFalse(result["approved"]); self.assertEqual(result["approvers"], [])

    def test_ambiguous_create_after_acceptance_is_adopted_once(self):
        state = self.start()
        coordinator = delivery.Coordinator(self.root / "state")
        fake = FakeGitHub(self.root / "fake-gh.json")
        fake.configure_failure("create_pr", "after_accept")
        payload = {"repo": state["repo"], "head": "codex/issue-42", "head_sha": "d" * 40,
                   "base": "stack/parent", "body": "delivery-id: delivery-42",
                   "delivery_id": state["delivery_id"], "plan_revision": "c" * 40}
        with self.assertRaisesRegex(delivery.DeliveryError, "ambiguous"):
            coordinator.publish(state, fake, "create_pr", payload)
        recovered = coordinator.load(state["repo"], state["delivery_id"])
        receipt = coordinator.publish(recovered, fake, "create_pr", payload)
        self.assertEqual(receipt["number"], 1)
        self.assertEqual(len(delivery.read_json(fake.path)["prs"]), 1)

    def test_ambiguous_multiple_matches_block(self):
        state = self.start()
        fake_path = self.root / "fake-gh.json"
        fake = FakeGitHub(fake_path)
        payload = {"repo": state["repo"], "head": "codex/issue-42", "head_sha": "d" * 40,
                   "base": "main", "body": "x", "delivery_id": state["delivery_id"],
                   "plan_revision": None}
        first = fake.apply("create_pr", payload)
        data = delivery.read_json(fake_path); duplicate = dict(first); duplicate["number"] = 99
        data["prs"].append(duplicate); delivery.atomic_json(fake_path, data)
        with self.assertRaisesRegex(delivery.DeliveryError, "ambiguous"):
            delivery.Coordinator(self.root / "state").publish(state, fake, "create_pr", payload)

    def test_concurrent_start_allows_one_active_claim(self):
        coordinator = delivery.Coordinator(self.root / "state")
        barrier = threading.Barrier(2); results = []
        def attempt(index):
            barrier.wait()
            try:
                coordinator.start(repo="github.test/acme/widget", issue=40 + index,
                    policy=self.policy(), skills_root=self.skills, delivery_id=f"d-{index}")
                results.append("ok")
            except delivery.DeliveryError:
                results.append("blocked")
        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(results, ["ok", "blocked"])

    def test_stacked_refs_are_distinct_and_preserved(self):
        state = self.start()
        self.assertEqual(state["policy_values"]["branches"]["default_parent"], "main")
        context = delivery.review_context(stage="implementation", generation=1, issue=42,
            material_hashes={}, baseline_sha="a" * 40, base_repo=state["repo"],
            base_ref="stack/parent", base_sha="b" * 40, final_repo=state["repo"],
            final_ref="main", policy_digest=self.digest)
        other = delivery.review_context(stage="implementation", generation=1, issue=42,
            material_hashes={}, baseline_sha="a" * 40, base_repo=state["repo"],
            base_ref="main", base_sha="b" * 40, final_repo=state["repo"],
            final_ref="main", policy_digest=self.digest)
        self.assertNotEqual(context, other)

    def test_closeout_pending_failure_and_no_merge(self):
        self.assertEqual(delivery.closeout_verdict(["pending"], draft=False)["delivery_status"], "WAITING")
        self.assertEqual(delivery.closeout_verdict(["failure"], draft=False)["delivery_status"], "BLOCKED")
        ready = delivery.closeout_verdict(["success"], draft=False, merge_requested=True)
        self.assertEqual(ready["delivery_status"], "READY"); self.assertFalse(ready["merge_performed"])

    def test_closeout_cannot_release_claim_while_delivery_checks_are_pending(self):
        state = self.start()
        coordinator = delivery.Coordinator(self.root / "state")
        manifest = {"schema_version": 1, "kind": "closeout", "delivery_id": state["delivery_id"],
                    "repo": state["repo"], "result": {"status": "WAITING", "delivery_status": "READY",
                    "head_sha": "d" * 40, "base_sha": "c" * 40, "checks": ["pending"]}}
        with self.assertRaisesRegex(delivery.DeliveryError, "verified publication"):
            coordinator.accept_manifest(state, manifest)
        state["publication"] = {"final": {"pr": {"head_sha": "d" * 40, "base_sha": "c" * 40}}}
        for invalid in ([], ["bogus"], "success", ["no_required_checks", "pending"]):
            with self.subTest(checks=invalid):
                manifest["result"]["checks"] = invalid
                with self.assertRaisesRegex(delivery.DeliveryError, "known states"):
                    coordinator.accept_manifest(state, manifest)
        manifest["result"]["checks"] = ["pending"]
        with self.assertRaisesRegex(delivery.DeliveryError, "successful or confirmed absent"):
            coordinator.accept_manifest(state, manifest)
        manifest["result"]["delivery_status"] = "WAITING"
        coordinator.accept_manifest(state, manifest)
        self.assertEqual(state["status"], "ci_waiting")
        with self.assertRaisesRegex(delivery.DeliveryError, "already claimed"):
            self.start(issue=43, delivery_id="delivery-43")

    def test_privilege_and_manifest_validation(self):
        scratch = self.root / "scratch"; scratch.mkdir()
        clean = {"DELIVERY_AGENT_ISOLATED": "1", "HOME": str(scratch),
                 "GH_CONFIG_DIR": str(scratch / "gh")}
        delivery.validate_agent_environment(clean, scratch)
        with self.assertRaisesRegex(delivery.DeliveryError, "credentials"):
            delivery.validate_agent_environment({**clean, "GH_TOKEN": "secret"}, scratch)
        manifest = {"schema_version": 1, "kind": "rank", "delivery_id": "d", "repo": "o/r",
                    "result": {"winner": 42, "shortlist": [42]}}
        delivery.validate_manifest(manifest, "rank")
        with self.assertRaisesRegex(delivery.DeliveryError, "unexpected"):
            delivery.validate_manifest({**manifest, "result": {"shell": "rm -rf"}}, "rank")

    def test_resume_freezes_skill_sources_and_recover_waits_for_exit(self):
        package = self.skills / "plan-pr"
        reference = package / "references" / "publication.md"
        script = package / "scripts" / "render.cjs"
        for asset in (reference, script):
            asset.parent.mkdir()
            asset.write_text("pinned")
        state = self.start()
        coordinator = delivery.Coordinator(self.root / "state")
        coordinator.verify_resume(state, self.skills)
        for asset in (reference, script):
            with self.subTest(asset=asset):
                asset.write_text("changed")
                with self.assertRaisesRegex(delivery.DeliveryError, "changed"):
                    coordinator.verify_resume(state, self.skills)
                asset.write_text("pinned")
        coordinator.verify_resume(state, self.skills)
        (self.skills / "plan-pr" / "SKILL.md").write_text("changed")
        with self.assertRaisesRegex(delivery.DeliveryError, "changed"):
            coordinator.verify_resume(state, self.skills)
        state["runner_status"] = "running"; state["runner_pid"] = 99999999; coordinator.save(state)
        with self.assertRaisesRegex(delivery.DeliveryError, "still alive"):
            coordinator.recover(state, old_pid_alive=True)
        recovered = coordinator.recover(state, old_pid_alive=False)
        self.assertEqual(recovered["attempt"], 2)

    def test_invalid_startup_does_not_strand_claim(self):
        coordinator = delivery.Coordinator(self.root / "state")
        repo = "github.test/acme/widget"
        with self.assertRaisesRegex(delivery.DeliveryError, "missing pinned skill package"):
            coordinator.start(repo=repo, issue=42, policy=self.policy(), skills_root=self.root / "missing")
        self.assertFalse((coordinator._repo_dir(repo) / "active.json").exists())
        started = coordinator.start(repo=repo, issue=42, policy=self.policy(), skills_root=self.skills)
        self.assertEqual(started["status"], "plan_required")

    def test_operation_manifest_scope_and_existing_label(self):
        state = self.start(); coordinator = delivery.Coordinator(self.root / "state")
        fake = FakeGitHub(self.root / "fake-gh.json")
        with self.assertRaisesRegex(delivery.DeliveryError, "escapes"):
            coordinator.publish(state, fake, "push", {"repo": "evil/x", "head": "h", "sha": "a" * 40})
        with self.assertRaisesRegex(delivery.DeliveryError, "create a label"):
            coordinator.publish(state, fake, "track_issue", {"repo": state["repo"], "issue": 42,
                "label": "status: review", "existing_labels": []})

    def test_corrections_require_material_change_for_new_generation(self):
        state = self.start(); coordinator = delivery.Coordinator(self.root / "state")
        manifest = {"schema_version": 1, "kind": "plan", "delivery_id": state["delivery_id"],
                    "repo": state["repo"], "result": {"artifact_paths": ["docs/plan.md"],
                    "artifact_hashes": {"docs/plan.md": "a" * 64}, "plan_revision": "b" * 40,
                    "issue": 42, "baseline": {"repo": state["repo"], "ref": "main", "sha": "c" * 40}}}
        first = coordinator.accept_manifest(state, manifest)
        self.assertEqual(first["manifests"]["plan"]["generation"], 1)
        retry = coordinator.accept_manifest(first, manifest)
        self.assertEqual(retry["manifests"]["plan"]["generation"], 1)
        changed = json.loads(json.dumps(manifest)); changed["result"]["artifact_hashes"]["docs/plan.md"] = "d" * 64
        corrected = coordinator.accept_manifest(retry, changed)
        self.assertEqual(corrected["manifests"]["plan"]["generation"], 2)

    def test_implementation_verification_prose_does_not_advance_review_generation(self):
        state = self.start()
        coordinator = delivery.Coordinator(self.root / "state")
        manifest = {"schema_version": 1, "kind": "implement", "delivery_id": state["delivery_id"],
                    "repo": state["repo"], "result": {"candidate_sha": "d" * 40,
                    "artifact_paths": ["src/change.py"], "verification": ["test passed"],
                    "issue": 42, "base": {"repo": state["repo"], "ref": "main", "sha": "c" * 40}}}
        coordinator.accept_manifest(state, manifest)
        manifest["result"]["verification"] = ["test passed again"]
        coordinator.accept_manifest(state, manifest)
        self.assertEqual(state["manifests"]["implement"]["generation"], 1)

    def test_correction_replaces_publication_and_receipt_before_dispatch(self):
        state = self.start()
        coordinator = delivery.Coordinator(self.root / "state")
        manifest = {"schema_version": 1, "kind": "plan", "delivery_id": state["delivery_id"],
                    "repo": state["repo"], "result": {"artifact_paths": ["docs/plan.md"],
                    "artifact_hashes": {"docs/plan.md": "a" * 64}, "plan_revision": "b" * 40,
                    "issue": 42, "baseline": {"repo": state["repo"], "ref": "main", "sha": "c" * 40}}}
        coordinator.accept_manifest(state, manifest)
        record = state["manifests"]["plan"]
        publication = {"pr": {"head_sha": "b" * 40, "draft": True},
                       "generation": record["generation"], "manifest_digest": record["digest"]}
        state.update(publication={"plan": publication}, receipts={"plan": {"approved": False}},
                     runner_status="paused", runner_run_id="prior",
                     runner={"current_step_id": "plan-review"})
        corrected = json.loads(json.dumps(manifest))
        corrected["result"]["artifact_hashes"]["docs/plan.md"] = "d" * 64
        with self.assertRaisesRegex(delivery.DeliveryError, "new candidate commit"):
            coordinator.accept_correction(state, corrected)
        corrected["result"]["plan_revision"] = "d" * 40
        with self.assertRaisesRegex(delivery.DeliveryError, "paused review correction"):
            coordinator.accept_manifest(state, corrected)
        coordinator.accept_correction(state, corrected)
        self.assertEqual(state["runner_status"], "idle")
        self.assertEqual(state["corrections"]["plan"], publication)
        self.assertEqual(state["manifests"]["plan"]["generation"], 2)
        self.assertNotIn("plan", state["publication"])
        self.assertNotIn("plan", state["receipts"])

    def test_start_dispatches_exact_pinned_runner_with_managed_gate_inputs(self):
        state = self.start(); calls = []
        state["agent"] = {"launcher": "/tmp/launcher", "worktree": "/tmp/worktree",
                          "scratch": "/tmp/scratch", "skills_root": str(self.skills)}
        state["publisher_launcher"] = "/tmp/publisher"
        def runner(argv, **kwargs):
            calls.append((argv, kwargs))
            return SimpleNamespace(returncode=0, stdout=json.dumps({"run_id": "r1",
                "workflow_id": "github-delivery", "status": "paused",
                "current_step_id": "plan-review", "current_step_index": 1}), stderr="")
        result = delivery.run_spec_kit(state, self.root / "state", runner=runner)
        argv = calls[0][0]
        self.assertEqual(result["status"], "paused")
        self.assertIn(f"git+https://github.com/github/spec-kit.git@{delivery.SPEC_KIT_PIN}", argv)
        self.assertIn("plan_gate=true", argv); self.assertIn("implementation_gate=true", argv)

    def test_failed_runner_json_retains_actionable_run_id(self):
        state = self.start(); state["agent"] = {"launcher": "/tmp/launcher", "worktree": "/tmp/worktree",
            "scratch": "/tmp/scratch", "skills_root": str(self.skills)}
        state["publisher_launcher"] = "/tmp/publisher"
        def runner(*args, **kwargs):
            return SimpleNamespace(returncode=1, stdout=json.dumps({"run_id": "failed-run",
                "workflow_id": "github-delivery", "status": "failed", "current_step_id": "publish-plan",
                "current_step_index": 3, "error": "publisher failed"}), stderr="diagnostic")
        result = delivery.run_spec_kit(state, self.root / "state", runner=runner)
        self.assertEqual(result["run_id"], "failed-run"); self.assertEqual(result["error"], "publisher failed")

    def test_adapter_cli_runs_isolated_launcher_and_accepts_manifest(self):
        state = self.start(); launcher = self.root / "launcher.py"
        manifest = {"schema_version": 1, "kind": "plan", "delivery_id": state["delivery_id"],
            "repo": state["repo"], "result": {"artifact_paths": ["docs/plan.md"],
            "artifact_hashes": {"docs/plan.md": "a" * 64}, "plan_revision": "b" * 40,
            "issue": 42, "baseline": {"repo": state["repo"], "ref": "main", "sha": "c" * 40}}}
        launcher.write_text("#!/usr/bin/env python3\nimport json,sys\njson.load(sys.stdin)\nprint(" + repr(json.dumps(manifest)) + ")\n")
        launcher.chmod(0o700)
        completed = subprocess.run([sys.executable, str(MODULE.with_name("adapter.py")), "run",
            "--kind", "plan", "--state-dir", str(self.root / "state"), "--repo", state["repo"],
            "--delivery-id", state["delivery_id"], "--skills-root", str(self.skills),
            "--launcher", str(launcher), "--worktree", str(self.root),
            "--scratch", str(self.root / "scratch")], text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        accepted = delivery.Coordinator(self.root / "state").load(state["repo"], state["delivery_id"])
        self.assertEqual(accepted["status"], "plan_review")

    def test_completed_runner_can_resume_ci_wait_and_releases_claim(self):
        state = self.start(); launcher = self.root / "closeout.py"
        state["status"] = "ci_waiting"; state["runner_status"] = "completed"
        state["publication"] = {"final": {"pr": {"head_sha": "d" * 40, "base_sha": "c" * 40}}}
        state["agent"] = {"launcher": str(launcher), "worktree": str(self.root),
            "scratch": str(self.root / "scratch"), "skills_root": str(self.skills)}
        delivery.Coordinator(self.root / "state").save(state)
        manifest = {"schema_version": 1, "kind": "closeout", "delivery_id": state["delivery_id"],
            "repo": state["repo"], "result": {"status": "WAITING", "delivery_status": "READY", "head_sha": "d" * 40,
            "base_sha": "c" * 40, "checks": ["no_required_checks"]}}
        launcher.write_text("#!/usr/bin/env python3\nimport json,sys\njson.load(sys.stdin)\nprint(" +
                            repr(json.dumps(manifest)) + ")\n"); launcher.chmod(0o700)
        completed = subprocess.run([sys.executable, str(MODULE), "resume", "--state-dir", str(self.root / "state"),
            "--repo", state["repo"], "--delivery-id", state["delivery_id"], "--skills-root", str(self.skills)],
            text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "review_ready")
        self.assertEqual(result["merge_readiness"], "WAITING")
        next_state = delivery.Coordinator(self.root / "state").start(repo=state["repo"], issue=43,
            policy=self.policy(), skills_root=self.skills, delivery_id="delivery-43")
        self.assertEqual(next_state["issue"], 43)

    def test_public_cli_stage_sequence_with_fake_launchers(self):
        state = delivery.Coordinator(self.root / "state").start(repo="github.test/acme/widget",
            issue=None, policy=self.policy(), skills_root=self.skills, delivery_id="e2e")
        state["agent"] = {"launcher": str(self.root / "agent.py"), "worktree": str(self.root),
                          "scratch": str(self.root / "scratch"), "skills_root": str(self.skills)}
        delivery.Coordinator(self.root / "state").save(state)
        agent = self.root / "agent.py"
        agent.write_text("""#!/usr/bin/env python3
import json,sys
p=json.load(sys.stdin); k=p['kind']; repo=p['repo']; did=p['delivery_id']; issue=p.get('issue') or 42
if k=='rank': r={'winner':42,'shortlist':[42]}
elif k=='plan': r={'artifact_paths':['docs/plan.md'],'artifact_hashes':{'docs/plan.md':'a'*64},'plan_revision':'b'*40,'issue':issue,'baseline':{'repo':repo,'ref':'main','sha':'c'*40}}
elif k=='implement': r={'candidate_sha':'d'*40,'artifact_paths':['src/change.py'],'verification':['tests ok'],'issue':issue,'base':{'repo':repo,'ref':'main','sha':'c'*40}}
else: r={'status':'READY','delivery_status':'READY','head_sha':'d'*40,'base_sha':'c'*40,'checks':['success']}
print(json.dumps({'schema_version':1,'kind':k,'delivery_id':did,'repo':repo,'result':r}))
"""); agent.chmod(0o700)
        publisher_launcher = self.root / "publisher-launcher.py"
        publisher_launcher.write_text("""#!/usr/bin/env python3
import json,sys
p=json.load(sys.stdin); a=p['action']
if a.startswith('publish_'):
 e=p['expected']; out={'schema_version':1,'action':a,'pr':{'number':1 if a=='publish_plan' else 2,'repo':e['repo'],'head':e['head'],'head_sha':e['head_sha'],'base':e['base'],'base_sha':e['base_sha'],'draft':True,'state':'OPEN'}}
elif a=='list_reviews':
 pr=p['pr']; body=f\"delivery-review {p['stage']} {p['generation']} {p['context_digest']} approve\"
 out={'schema_version':1,'action':a,'paginated':True,'pr':pr,'reviews':[{'id':1,'user':{'id':101},'state':'COMMENTED','dismissed':False,'commit_id':pr['head_sha'],'body':body,'submitted_at':'2026-01-01T00:00:00Z'}]}
else:
 pr=dict(p['pr']); pr['draft']=False
 out={'schema_version':1,'action':a,'pr':pr,'issue':{'number':p['issue'],'labels':[p['existing_review_label']]}}
print(json.dumps(out))
"""); publisher_launcher.chmod(0o700)
        state["publisher_launcher"] = str(publisher_launcher)
        delivery.Coordinator(self.root / "state").save(state)
        base = ["--state-dir", str(self.root / "state"), "--repo", state["repo"], "--delivery-id", "e2e"]
        def command(script, args):
            result = subprocess.run([sys.executable, str(MODULE.with_name(script)), *args],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            return json.loads(result.stdout)
        def agent_stage(kind):
            return command("adapter.py", ["run", "--kind", kind, *base, "--skills-root", str(self.skills),
                "--launcher", str(agent), "--worktree", str(self.root),
                "--scratch", str(self.root / "scratch" / kind)])
        def publisher_stage(action):
            return command("publisher_adapter.py", [action, *base, "--launcher", str(publisher_launcher)])
        agent_stage("rank"); agent_stage("plan"); publisher_stage("publish-plan")
        self.assertEqual(publisher_stage("check-plan")["verdict"], "approve")
        command("delivery.py", ["advance", *base, "--stage", "plan"])
        agent_stage("implement"); publisher_stage("publish-implementation")
        self.assertEqual(publisher_stage("check-implementation")["verdict"], "approve")
        command("delivery.py", ["advance", *base, "--stage", "implementation"])
        publisher_stage("finalize"); agent_stage("closeout")
        final = delivery.Coordinator(self.root / "state").load(state["repo"], "e2e")
        self.assertEqual(final["status"], "review_ready")
        self.assertFalse(final["publication"]["final"]["pr"]["draft"])


if __name__ == "__main__":
    unittest.main()
