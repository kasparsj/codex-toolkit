from __future__ import annotations

import datetime as dt
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
for name in ("delivery", "app_auth", "trusted_git", "publisher"):
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader
        sys.modules[name] = module
        spec.loader.exec_module(module)

delivery = sys.modules["delivery"]
publisher = sys.modules["publisher"]


class Binding:
    digest = "a" * 64
    app_slug = "delivery-test"
    bot_login = "delivery-test[bot]"
    bot_user_id = 99
    repository_id = 4
    repository = "acme/widget"
    ci = {"workflow_id": 17, "workflow_path": ".github/workflows/test.yml",
          "workflow_sha256": "a" * 64,
          "event": "pull_request", "required_job": "test"}

    def verify_candidate_paths(self, paths):
        delivery.require(paths and all(path.startswith(("docs/", "src/")) for path in paths),
                         "candidate path is outside the App allowlist")


class Session:
    binding = Binding()
    expires_at = dt.datetime(2026, 11, 9, tzinfo=dt.timezone.utc)


class Client:
    def __init__(self):
        self.runs = []
        self.jobs = []
        self.commits = {}

    def api(self, method, _repo, endpoint):
        if method != "GET" or "/git/commits/" not in endpoint:
            raise AssertionError((method, endpoint))
        return self.commits[endpoint.rsplit("/", 1)[1]]

    def paginated(self, _repo, endpoint):
        return self.jobs if "/jobs?" in endpoint else self.runs


class AppPublisherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = Client()
        self.publisher = publisher.Publisher(
            repo="github.com/acme/widget", root=Path(self.temp.name),
            client=self.client, app_session=Session(),
        )
        self.packet = {"credential_mode": "app", "app_binding_digest": "a" * 64,
                       "operation_id": "1" * 20,
                       "action": "finalize",
                       "delivery_id": "delivery-1", "expected": {"generation": 1},
                       "policy_values": {"delivery": {"publisher_id": 99}}}
        self.pr = {"number": 8, "head": "codex/issue-1", "head_sha": "c" * 40,
                   "base_sha": "b" * 40,
                   "author_id": 99, "author_type": "Bot",
                   "author_login": "delivery-test[bot]"}

    def tearDown(self):
        self.temp.cleanup()

    def test_binding_author_and_path_checks_fail_closed(self):
        self.publisher._verify_actor(self.packet)
        self.publisher._verify_app_pr_author(self.packet, self.pr)
        with self.assertRaisesRegex(delivery.DeliveryError, "binding digest"):
            self.publisher._verify_actor({**self.packet, "app_binding_digest": "0" * 64})
        with self.assertRaisesRegex(delivery.DeliveryError, "authored"):
            self.publisher._verify_app_pr_author(
                self.packet, {**self.pr, "author_login": "other[bot]"},
            )
        with self.assertRaisesRegex(delivery.DeliveryError, "privileged path"):
            self.publisher._validate_candidate_paths({**self.packet, "candidate": {
                "paths": [".github/workflows/pwn.yml"],
            }})
        with self.assertRaisesRegex(delivery.DeliveryError, "outside the App allowlist"):
            self.publisher._validate_candidate_paths({**self.packet, "candidate": {
                "paths": ["scripts/pwn.py"],
            }})

    def test_ci_newest_attempt_controls_completion(self):
        self.client.runs = [
            {"id": 20, "workflow_id": 17, "event": "pull_request",
             "head_sha": "c" * 40, "run_attempt": 1, "status": "completed",
             "conclusion": "success", "head_branch": "codex/issue-1",
             "head_repository": {"id": 4}},
            {"id": 20, "workflow_id": 17, "event": "pull_request",
             "head_sha": "c" * 40, "run_attempt": 2, "status": "in_progress",
             "head_branch": "codex/issue-1", "head_repository": {"id": 4}},
        ]
        self.assertEqual(self.publisher._ci_status(self.pr)["status"], "waiting")
        self.client.runs[-1]["status"] = "completed"
        self.client.runs[-1]["conclusion"] = "success"
        self.client.jobs = [{"id": 30, "name": "test", "status": "completed",
                             "conclusion": "failure"}]
        self.assertEqual(self.publisher._ci_status(self.pr)["status"], "blocked")
        self.client.jobs[0]["conclusion"] = "success"
        self.assertEqual(self.publisher._ci_status(self.pr)["status"], "success")

    def test_pending_intent_checkpoints_only_after_observation(self):
        self.publisher._record_intent(
            self.packet, "label", {"issue": 1, "labels": []},
            {"issue": 1, "label": "status: review"},
        )
        path = self.publisher._intent_path(self.packet, "label")
        self.assertEqual(delivery.read_json(path)["status"], "pending")
        self.publisher._checkpoint_if_pending(
            self.packet, "label", {"issue": 1, "labels": ["status: review"]},
        )
        self.assertEqual(delivery.read_json(path)["status"], "checkpointed")
        self.publisher._record_intent(
            self.packet, "push", {"sha": None}, {"sha": "c" * 40},
        )
        self.assertTrue(self.publisher._intent_path(self.packet, "push").exists())
        self.assertTrue(path.exists())
        with self.assertRaisesRegex(delivery.DeliveryError, "scope conflicts"):
            self.publisher._record_intent(
                self.packet, "label", {"labels": ["unexpected"]},
                {"issue": 1, "label": "status: review"},
            )

    def test_plan_and_implementation_keep_separate_generation_one_push_intents(self):
        plan = {**self.packet, "action": "publish_plan", "operation_id": "a" * 20}
        implementation = {
            **self.packet, "action": "publish_implementation", "operation_id": "b" * 20,
        }
        self.publisher._record_intent(plan, "push", {"sha": None}, {"sha": "a" * 40})
        self.publisher._record_intent(
            implementation, "push", {"sha": "a" * 40}, {"sha": "b" * 40},
        )
        self.assertNotEqual(
            self.publisher._intent_path(plan, "push"),
            self.publisher._intent_path(implementation, "push"),
        )

    def test_ci_rejects_duplicate_required_job(self):
        self.client.runs = [{"id": 20, "workflow_id": 17, "event": "pull_request",
                             "head_sha": "c" * 40, "run_attempt": 1,
                             "status": "completed", "conclusion": "success",
                             "head_branch": "codex/issue-1",
                             "head_repository": {"id": 4}}]
        self.client.jobs = [
            {"id": 30, "name": "test", "status": "completed", "conclusion": "success"},
            {"id": 31, "name": "test", "status": "completed", "conclusion": "success"},
        ]
        with self.assertRaisesRegex(delivery.DeliveryError, "ambiguous"):
            self.publisher._ci_status(self.pr)

    def test_ci_ignores_historical_plan_run_on_same_pr(self):
        self.client.runs = [
            {"id": 19, "workflow_id": 17, "event": "pull_request",
             "head_sha": "m" * 40, "run_attempt": 1, "status": "completed",
             "conclusion": "success", "pull_requests": [{
                 "number": 8, "head": {"sha": "a" * 40}, "base": {"sha": "b" * 40},
             }]},
            {"id": 20, "workflow_id": 17, "event": "pull_request",
             "head_sha": "c" * 40, "run_attempt": 1, "status": "completed",
             "conclusion": "success", "head_branch": "codex/issue-1",
             "head_repository": {"id": 4}},
        ]
        self.client.jobs = [{"id": 30, "name": "test", "status": "completed",
                             "conclusion": "success"}]
        self.assertEqual(self.publisher._ci_status(self.pr)["run_id"], 20)

    def test_ci_verifies_test_merge_commit_parents(self):
        tested_sha = "d" * 40
        self.client.runs = [{
            "id": 20, "workflow_id": 17, "event": "pull_request", "head_sha": tested_sha,
            "run_attempt": 1, "status": "completed", "conclusion": "success",
            "pull_requests": [{"number": 8, "head": {"sha": "c" * 40}, "base": {"sha": "b" * 40}}],
        }]
        self.client.jobs = [{"id": 30, "name": "test", "status": "completed", "conclusion": "success"}]
        self.client.commits[tested_sha] = {"sha": tested_sha, "parents": [{"sha": "a" * 40}, {"sha": "c" * 40}]}
        self.assertEqual(self.publisher._gate_ci(self.pr)["reason"], "test_merge_parents_mismatch")
        self.client.commits[tested_sha]["parents"][0]["sha"] = "b" * 40
        result = self.publisher._gate_ci(self.pr)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["tested_sha"], tested_sha)


if __name__ == "__main__":
    unittest.main()
