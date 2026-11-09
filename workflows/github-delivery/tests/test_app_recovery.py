"""Local simulated GitHub acceptance and lost responses through the real publisher."""

import base64
import copy
import hashlib
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

from test_app_publisher import Session
from test_live_publisher import FakeClient, FakeTrustedGit, delivery, publisher


POLICY = b"""version = 1
[delivery]
publisher_id = 99
final_target = "main"
[eligibility]
required_labels = []
excluded_labels = []
[branches]
default_parent = "main"
plan_template = "codex/issue-{issue}"
implementation_template = "codex/issue-{issue}"
[tracking]
review_label = "status: review"
[approvals.plan]
minimum = 1
reviewer_ids = [101]
[approvals.implementation]
minimum = 1
reviewer_ids = [101]
"""


class AppGitHub(FakeClient):
    workflow_content = b"name: fixture\n"

    def __init__(self):
        super().__init__(POLICY)
        self.issue_labels.clear()
        self.runs = []
        self.jobs = []
        self.pushes = []
        self.branch_protected = False

    def workflow(self):
        return {"id": 17, "path": ".github/workflows/test.yml", "state": "active"}

    @staticmethod
    def _raw_pr(*args, **kwargs):
        pr = FakeClient._raw_pr(*args, **kwargs)
        pr["user"] = {"id": 99, "type": "Bot", "login": "delivery-test[bot]"}
        pr["head"]["repo"]["id"] = 77
        return pr

    def api(self, method, repo, endpoint, payload=None):
        if endpoint in {"/users/reviewer", "/user/101"}:
            return {"id": 101, "type": "User", "login": "reviewer"}
        if endpoint == "/repos/{owner}/{repo}":
            return {"id": 77, "full_name": "acme/widget", "private": True, "default_branch": "main"}
        if endpoint.endswith("/branches/main"):
            return {"protected": self.branch_protected}
        if "/labels/" in endpoint and method == "GET":
            return {"name": "status: review"}
        if endpoint.endswith("/actions/workflows/17"):
            return self.workflow()
        if "/contents/.github/workflows/test.yml?" in endpoint:
            return {"encoding": "base64", "content": base64.b64encode(self.workflow_content).decode()}
        return super().api(method, repo, endpoint, payload)

    def paginated(self, repo, endpoint):
        if "/actions/workflows?" in endpoint:
            return [self.workflow()]
        if "/pulls?state=all&" in endpoint and "&head=" not in endpoint:
            return list(self.prs.values())
        if "/jobs?" in endpoint:
            return self.jobs
        if "/runs?" in endpoint:
            return self.runs
        return super().paginated(repo, endpoint)


class AppGit(FakeTrustedGit):
    def verify_introduced_paths(self, previous, *, allow_paths):
        allow_paths(self.imported[3])

    def push(self, branch, sha, previous, *, lock_fd=None):
        if lock_fd is None:
            raise AssertionError("App push lost its publisher lock")
        super().push(branch, sha, previous)
        self.client.pushes.append((branch, sha))


class AppRecoveryTest(unittest.TestCase):
    def test_both_generations_and_every_interrupted_write_reuse_one_pr(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            client = AppGitHub()
            session = Session()
            session.binding = copy.copy(session.binding)
            session.binding.repository_id = 77
            session.binding.ci = {**session.binding.ci,
                                  "workflow_sha256": hashlib.sha256(client.workflow_content).hexdigest()}
            source = {"ref": "refs/heads/main", "sha": client.base_sha,
                      "digest": hashlib.sha256(POLICY).hexdigest()}
            common = {"schema_version": 1, "target_repo": "github.com/acme/widget",
                      "credential_mode": "app", "app_binding_digest": session.binding.digest,
                      "delivery_id": "recovery-test", "issue": 42, "policy": source,
                      "policy_values": {**tomllib.loads(POLICY.decode()), "_source": source}}
            plan_expected = {"repo": common["target_repo"], "issue": 42, "head": "codex/issue-42",
                             "head_sha": "c" * 40, "base": "main", "base_sha": client.base_sha,
                             "generation": 1, "manifest_digest": "d" * 64, "plan_revision": "c" * 40}
            impl_expected = {**plan_expected, "head_sha": "e" * 40, "manifest_digest": "f" * 64}
            plan = {**common, "operation_id": "1" * 20, "action": "publish_plan",
                    "expected": plan_expected, "candidate": {
                        "bundle_path": "plan.bundle", "paths": ["docs/plan.md"],
                        "hashes": {"docs/plan.md": "0" * 64},
                    }}

            def execute(packet):
                # Each request reconstructs the process-local publisher state.
                return publisher.Publisher(
                    repo=common["target_repo"], root=root, client=client, app_session=session,
                    git_factory=lambda directory, url: AppGit(client, directory, url),
                ).execute(packet)

            def lose_response(packet, operation):
                with patch.dict(os.environ, DELIVERY_PUBLISHER_FAULT_AFTER=operation):
                    with self.assertRaisesRegex(delivery.DeliveryError,
                                                f"injected lost response after {operation}"):
                        execute(packet)

            def approve(pr, stage, context, review_id):
                client.reviews.setdefault(pr["number"], []).append({
                    "id": review_id, "state": "COMMENTED", "commit_id": pr["head_sha"],
                    "user": {"id": 101, "type": "User", "login": "reviewer"},
                    "body": delivery.review_body(stage, 1, context, "approve"),
                    "submitted_at": "2026-11-09T10:00:00Z",
                })
                return {"stage": stage, "pr": pr, "context_digest": context,
                        "generation": 1, "minimum": 1, "reviewer_ids": [101]}

            preflight = {**common, "action": "preflight", "initial": True}
            for protected in (True, False):
                client.branch_protected = protected
                with patch.object(publisher.Publisher, "_identity_evidence", return_value={"repository_id": 77}):
                    result = execute(preflight)
                self.assertIs(result["identity"]["default_branch_protected"], protected)
                self.assertIs(result["snapshot"]["repository"]["protected"], protected)
            client.policy_sha = "f" * 40
            with self.assertRaisesRegex(delivery.DeliveryError, "policy ref moved"):
                execute(preflight)
            client.policy_sha = client.base_sha

            lose_response(plan, "push")
            lose_response(plan, "pr_create")
            plan_pr = execute(plan)["pr"]
            plan_approval = approve(plan_pr, "plan", "1" * 64, 10)
            impl = {**common, "operation_id": "2" * 20, "action": "publish_implementation",
                    "expected": impl_expected, "prior_pr": plan_pr, "plan_approval": plan_approval,
                    "candidate": {"bundle_path": "impl.bundle", "paths": ["docs/greeting.md"]}}
            lose_response(impl, "push")
            lose_response(impl, "pr_update")
            impl_pr = execute(impl)["pr"]
            self.assertEqual(impl_pr["node_id"], plan_pr["node_id"])
            self.assertEqual(impl_pr["head_sha"], impl_expected["head_sha"])
            impl_approval = approve(impl_pr, "implementation", "2" * 64, 11)
            finalize = {**common, "operation_id": "3" * 20, "action": "finalize",
                        "pr": impl_pr, "expected": impl_expected, "prior_pr": plan_pr,
                        "existing_review_label": "status: review",
                        "approval": impl_approval, "plan_approval": plan_approval}

            self.assertEqual(execute(finalize)["status"], "pre_ready_ci_waiting")
            client.runs = [{"id": 41, "workflow_id": 17, "event": "pull_request", "run_attempt": 1,
                            "head_sha": impl_pr["head_sha"], "head_branch": impl_pr["head"],
                            "repository": {"id": 77}, "head_repository": {"id": 77},
                            "pull_requests": [{"number": impl_pr["number"],
                                               "head": {"sha": impl_pr["head_sha"]},
                                               "base": {"sha": client.base_sha}}],
                            "status": "completed", "conclusion": "success"}]
            client.runs.append({
                **client.runs[0], "id": 40, "head_sha": plan_pr["head_sha"],
                "pull_requests": [{"number": plan_pr["number"], "head": {"sha": plan_pr["head_sha"]},
                                   "base": {"sha": client.base_sha}}],
            })
            client.jobs = [{"id": 50, "name": "test", "status": "completed", "conclusion": "success"}]
            lose_response(finalize, "ready")
            lose_response(finalize, "label")
            final = execute(finalize)
            self.assertEqual(final["status"], "review_ready")
            self.assertEqual(final["pr"]["node_id"], plan_pr["node_id"])
            self.assertFalse(final["pr"]["draft"])
            self.assertEqual(final["ci"]["run_id"], 41)
            self.assertEqual(final["issue"]["labels"], ["status: review"])
            self.assertEqual(client.pushes, [(plan_expected["head"], plan_expected["head_sha"]),
                                            (impl_expected["head"], impl_expected["head_sha"])])
            self.assertEqual(client.mutations, [("create", 1), ("edit", 1), ("ready", 1),
                                                ("label", ("status: review",))])
            intents = list((root / "intents").rglob("*.json"))
            self.assertEqual(len(intents), 6)
            self.assertTrue(all(delivery.read_json(intent)["status"] == "checkpointed"
                                for intent in intents))


if __name__ == "__main__":
    unittest.main()
