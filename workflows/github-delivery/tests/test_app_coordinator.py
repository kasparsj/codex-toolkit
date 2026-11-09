"""App coordinator regression tests with no GitHub transport."""

import os
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import delivery
import publisher_adapter


class AppCoordinatorTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.coordinator = delivery.Coordinator(self.root / "state")
        self.skills = Path(__file__).resolve().parents[3] / "skills"
        self.repo = "owner/fixture"
        self.base_sha, self.plan_sha, self.impl_sha = "a" * 40, "b" * 40, "c" * 40
        self.policy = {
            "_source": {"ref": "refs/heads/main", "sha": self.base_sha, "digest": "d" * 64},
            "branches": {"default_parent": "main", "plan_template": "codex/issue-{issue}",
                         "implementation_template": "codex/issue-{issue}"},
            "delivery": {"final_target": "main", "publisher_id": 700},
            "approvals": {stage: {"minimum": 1, "reviewer_ids": [101]}
                          for stage in ("plan", "implementation")},
            "tracking": {"review_label": "status: in review"},
        }
        self.state = self.coordinator.start(
            repo=self.repo, issue=1, policy=self.policy, skills_root=self.skills,
            publisher_launcher="/fixture/publisher",
            agent={"launcher": "/fixture/agent", "worktree": "/fixture/checkout",
                   "scratch": str(self.root / "scratch"), "skills_root": str(self.skills)},
            app={"digest": "a" * 64, "config": "/fixture/app.json", "publisher_root": "/fixture/publisher-root"},
        )
        self.active = self.coordinator._repo_dir(self.repo) / "active.json"

    def publish_locally(self):
        base = {"repo": self.repo, "ref": "main", "sha": self.base_sha}
        for kind, stage, result in [
            ("plan", "plan", {"issue": 1, "baseline": base, "plan_revision": self.plan_sha,
                             "artifact_paths": ["docs/plan.md"], "artifact_hashes": {"docs/plan.md": "e" * 64}}),
            ("implement", "implementation", {"issue": 1, "base": base, "candidate_sha": self.impl_sha,
                                             "artifact_paths": ["docs/greeting.md"], "verification": []}),
        ]:
            self.coordinator.accept_manifest(
                self.state, {"schema_version": 1, "kind": kind, "repo": self.repo,
                             "delivery_id": self.state["delivery_id"], "result": result},
            )
            expected = publisher_adapter.expected_publication(self.state, stage)
            pr = {key: expected[key] for key in ("repo", "head", "head_sha", "base", "base_sha")}
            pr.update(number=7, node_id="PR_fixture", draft=True, state="OPEN")
            self.state.setdefault("publication", {})[stage] = {
                "pr": pr, "generation": expected["generation"], "manifest_digest": expected["manifest_digest"],
            }
            self.state["status"] = "implementation_required" if stage == "plan" else "publication_pending"
        self.state["receipts"]["implementation"] = {"approved": True}
        self.coordinator.save(self.state)
        return pr

    def test_forged_agent_closeout_cannot_advance_or_release_even_on_resume(self):
        pr = self.publish_locally()
        self.state.update(status="pre_ready_ci_waiting", runner_status="completed")
        self.coordinator.save(self.state)
        forged = {"schema_version": 1, "kind": "closeout", "repo": self.repo,
                  "delivery_id": self.state["delivery_id"],
                  "result": {"status": "READY", "delivery_status": "READY",
                             "head_sha": pr["head_sha"], "base_sha": pr["base_sha"],
                             "checks": ["no_required_checks"]}}
        with self.assertRaisesRegex(delivery.DeliveryError, "only accepts plan and implementation"):
            self.coordinator.accept_manifest(self.state, forged)
        result = self.root / "forged.json"
        delivery.atomic_json(result, forged)
        args = SimpleNamespace(repo=self.repo, delivery_id=self.state["delivery_id"],
                               command="resume", skills_root=self.skills, result=result)
        with patch.object(delivery, "app_preflight"), self.assertRaisesRegex(
                delivery.DeliveryError, "correction must be a plan or implementation"):
            delivery.resume_app(self.coordinator, args)
        self.assertEqual(delivery.read_json(self.active)["status"], "active")
        self.assertEqual(self.coordinator.load(self.repo, self.state["delivery_id"])["status"],
                         "pre_ready_ci_waiting")

    def test_cli_reports_imported_launcher_errors_as_blocked_json(self):
        completed = subprocess.run(
            [sys.executable, delivery.__file__, "resume", "--state-dir", str(self.coordinator.root),
             "--repo", self.repo, "--delivery-id", self.state["delivery_id"],
             "--skills-root", str(self.skills)],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(json.loads(completed.stdout), {
            "status": "blocked", "error": "publisher launcher must be executable",
        })
        self.assertEqual(completed.stderr, "")

    def test_app_correction_invalidates_old_review_and_keeps_owned_draft(self):
        self.publish_locally()
        for stage, kind, sha_key in (("plan", "plan", "plan_revision"),
                                     ("implementation", "implement", "candidate_sha")):
            with self.subTest(stage=stage):
                state = deepcopy(self.state)
                state.update(status=f"{stage}_review", runner_status="paused", runner_run_id="prior",
                             runner={"current_step_id": f"{stage}-review"})
                state["receipts"][stage] = {"approved": True}
                owned = state["publication"][stage]
                correction = deepcopy(state["manifests"][kind]["value"])
                correction["result"][sha_key] = "f" * 40
                with self.assertRaisesRegex(delivery.DeliveryError, "out of order"):
                    self.coordinator.accept_manifest(state, correction)
                result = self.coordinator.accept_correction(state, correction)
                self.assertEqual(result["status"], f"{stage}_review")
                self.assertEqual(result["runner_status"], "idle")
                self.assertEqual(result["corrections"][kind], owned)
                self.assertEqual(result["manifests"][kind]["generation"], 2)
                self.assertNotIn(stage, result["receipts"])
                self.assertEqual(delivery.read_json(self.active)["status"], "active")

    def test_app_finalize_resumes_ci_and_releases_after_terminal_checkpoint(self):
        pr = self.publish_locally()
        envelope = {"schema_version": 1, "action": "finalize"}
        waiting = {**envelope, "status": "pre_ready_ci_waiting", "pr": pr, "ci": {"status": "waiting"}}
        ready = {**envelope, "status": "review_ready", "pr": {**pr, "draft": False},
                 "ci": {"status": "success", "run_id": 88},
                 "issue": {"number": 1, "labels": ["status: in review"]}}
        launcher = Path(self.state["publisher_launcher"])
        with patch.object(publisher_adapter, "call_launcher", return_value=waiting):
            publisher_adapter.finalize(self.state, launcher, self.coordinator.save)
        self.assertEqual(self.state["status"], "pre_ready_ci_waiting")
        self.assertEqual(self.state["operations"][0]["status"], "intent")
        self.assertEqual(delivery.read_json(self.active)["status"], "active")
        with patch.object(publisher_adapter, "call_launcher", return_value=ready):
            publisher_adapter.finalize(self.state, launcher, self.coordinator.save)
        saved = self.coordinator.load(self.repo, self.state["delivery_id"])
        self.assertEqual(saved["status"], "review_ready")
        self.assertEqual(len(saved["operations"]), 1)
        self.assertEqual(saved["operations"][0]["status"], "completed")
        self.assertEqual(delivery.read_json(self.active)["status"], "active")
        args = SimpleNamespace(repo=self.repo, delivery_id=self.state["delivery_id"],
                               command="resume", skills_root=self.skills, result=None)
        with patch.object(delivery, "app_preflight") as preflight:
            delivery.resume_app(self.coordinator, args)
            preflight.assert_not_called()
        self.assertEqual(delivery.read_json(self.active)["status"], "released")

    def test_old_lease_and_replaced_claim_cannot_advance_a_step(self):
        self.state.update(runner_status="running", runner_lease="new-lease")
        self.coordinator.save(self.state)
        with patch.dict(os.environ, DELIVERY_RUNNER_LEASE="old-lease"):
            with self.assertRaisesRegex(delivery.DeliveryError, "execution lease"):
                with self.coordinator.runner_step(self.state):
                    self.fail("stale step ran")
        delivery.atomic_json(self.active, {"delivery_id": "other-delivery", "status": "active"})
        with patch.dict(os.environ, DELIVERY_RUNNER_LEASE="new-lease"):
            with self.assertRaisesRegex(delivery.DeliveryError, "active delivery claim"):
                with self.coordinator.runner_step(self.state):
                    self.fail("unowned step ran")
        self.coordinator.release(self.state)
        self.assertEqual(delivery.read_json(self.active)["delivery_id"], "other-delivery")

    def test_finalization_accepts_deferral_only_for_the_authorized_head(self):
        pr = self.publish_locally()
        result = {"schema_version": 1, "action": "finalize", "status": "review_ready",
                  "pr": {**pr, "draft": False},
                  "ci": {"status": "deferred", "head_sha": pr["head_sha"]},
                  "issue": {"number": 1, "labels": ["status: in review"]}}
        launcher = Path(self.state["publisher_launcher"])
        with patch.object(publisher_adapter, "call_launcher", return_value=result) as call:
            with self.assertRaisesRegex(delivery.DeliveryError, "successful trusted CI"):
                publisher_adapter.finalize(self.state, launcher, self.coordinator.save)
            self.state["actions_deferred_head"] = self.plan_sha
            with self.assertRaisesRegex(delivery.DeliveryError, "different implementation revision"):
                publisher_adapter.finalize(self.state, launcher, self.coordinator.save)
            self.state["actions_deferred_head"] = pr["head_sha"]
            publisher_adapter.finalize(self.state, launcher, self.coordinator.save)
            self.assertEqual(call.call_args.args[1]["actions_deferred_head"], pr["head_sha"])
        self.assertEqual(self.state["publication"]["final"]["ci"]["status"], "deferred")

    def test_label_response_loss_leaves_durable_tracking_phase(self):
        pr = self.publish_locally()
        tracking = {"schema_version": 1, "action": "finalize", "status": "tracking_pending",
                    "pr": {**pr, "draft": False}, "ci": {"status": "success", "run_id": 88}}
        launcher = Path(self.state["publisher_launcher"])
        with patch.object(publisher_adapter, "call_launcher", side_effect=[
            tracking, delivery.DeliveryError("injected lost response after label"),
        ]) as call:
            with self.assertRaisesRegex(delivery.DeliveryError, "lost response"):
                publisher_adapter.finalize(self.state, launcher, self.coordinator.save)
        initial, retry = [entry.args[1] for entry in call.call_args_list]
        self.assertTrue(initial["checkpoint_tracking"])
        self.assertNotIn("checkpoint_tracking", retry)
        self.assertEqual(initial["operation_id"], retry["operation_id"])
        saved = self.coordinator.load(self.repo, self.state["delivery_id"])
        self.assertEqual(saved["status"], "tracking_pending")
        self.assertEqual(saved["operations"][0]["status"], "intent")
        self.assertEqual(delivery.read_json(self.active)["status"], "active")
        saved["app"]["digest"] = "f" * 64
        final = {**tracking, "status": "review_ready",
                 "issue": {"number": 1, "labels": ["status: in review"]}}
        with patch.object(publisher_adapter, "call_launcher", return_value=final) as resumed:
            publisher_adapter.finalize(saved, launcher, self.coordinator.save)
        self.assertEqual(resumed.call_args.args[1]["app_binding_digest"], "f" * 64)
        self.assertEqual(resumed.call_args.args[1]["operation_id"], initial["operation_id"])
        self.assertEqual(len(saved["operations"]), 1)


if __name__ == "__main__":
    unittest.main()
