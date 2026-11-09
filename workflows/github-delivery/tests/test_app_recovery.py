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
    workflow_content = (Path(publisher.__file__).parent / "fixtures" / "delivery-fixture.yml").read_bytes()

    def __init__(self):
        super().__init__(POLICY)
        self.issue_labels.clear()
        self.runs = []
        self.jobs = []
        self.pushes = []
        self.branch_protected = False
        self.review_label_exists = True
        self.workflow_entries = [{"path": ".github/workflows/test.yml", "type": "file"}]

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
            if not self.review_label_exists:
                raise delivery.DeliveryError("GitHub App request failed with HTTP 404")
            return {"name": "status: review"}
        if endpoint.endswith("/actions/workflows/17"):
            return self.workflow()
        if "/contents/.github/workflows/test.yml?" in endpoint:
            return {"encoding": "base64", "content": base64.b64encode(self.workflow_content).decode()}
        if "/contents/.github/workflows?" in endpoint:
            return self.workflow_entries
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
        self.exercise_recovery(require_github_actions=True)

    def test_repository_can_use_local_verification_before_tracking(self):
        self.exercise_recovery(require_github_actions=False)

    def exercise_recovery(self, *, require_github_actions):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            client = AppGitHub()
            policy = POLICY
            if not require_github_actions:
                policy = policy.replace(b'final_target = "main"', b'final_target = "main"\n'
                                        b'require_github_actions = false')
                client.policy = policy
                client.workflow_content = client.workflow_content.replace(b"Delivery fixture", b"Audited workflow")
            session = Session()
            session.binding = copy.copy(session.binding)
            session.binding.repository_id = 77
            session.binding.ci = {**session.binding.ci,
                                  "required_job": "verify-fixture",
                                  "workflow_sha256": hashlib.sha256(client.workflow_content).hexdigest()}
            if not require_github_actions:
                session.binding.local_verifier = {
                    "image": "fixture@sha256:" + "a" * 64,
                    "argv": ["/bin/test", "-s", "docs/greeting.md"],
                    "audited_workflows": {".github/workflows/test.yml": hashlib.sha256(
                        client.workflow_content).hexdigest()},
                }
                session.binding.ci = None
            source = {"ref": "refs/heads/main", "sha": client.base_sha,
                      "digest": hashlib.sha256(policy).hexdigest()}
            common = {"schema_version": 1, "target_repo": "github.com/acme/widget",
                      "credential_mode": "app", "app_binding_digest": session.binding.digest,
                      "delivery_id": "recovery-test", "issue": 42, "policy": source,
                      "policy_values": {**tomllib.loads(policy.decode()), "_source": source}}
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
            safe_workflow = client.workflow_content
            client.workflow_content = safe_workflow.replace(b"runs-on: ubuntu-latest", b"runs-on: [self-hosted, linux]")
            if require_github_actions:
                session.binding.ci["workflow_sha256"] = hashlib.sha256(client.workflow_content).hexdigest()
                mismatch = "shipped M1 fixture workflow"
            else:
                mismatch = "audited workflow content changed"
            with self.assertRaisesRegex(delivery.DeliveryError, mismatch):
                execute(preflight)
            client.workflow_content = safe_workflow
            if require_github_actions:
                session.binding.ci["workflow_sha256"] = hashlib.sha256(safe_workflow).hexdigest()
            else:
                client.workflow_entries.append({"path": ".github/workflows/unknown.yml", "type": "file"})
                with self.assertRaisesRegex(delivery.DeliveryError, "audited workflow inventory changed"):
                    execute(preflight)
                client.workflow_entries.pop()
            same_as_base = {**plan, "expected": {**plan_expected, "head": "main"},
                            "policy_values": {**plan["policy_values"], "branches": {
                                **plan["policy_values"]["branches"], "plan_template": "main"}}}
            service = publisher.Publisher(repo=common["target_repo"], root=root, client=client,
                                          app_session=session)
            with self.assertRaisesRegex(delivery.DeliveryError, "branch must differ"):
                service._publish(same_as_base)
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

            original_body = client.prs[1]["body"]
            client.prs[1]["body"] += "delivery-id: conflicting\n"
            with self.assertRaisesRegex(delivery.DeliveryError, "provenance changed"):
                execute(finalize)
            self.assertTrue(client.prs[1]["draft"])
            client.prs[1]["body"] = original_body
            if require_github_actions:
                self.assertEqual(execute(finalize)["status"], "pre_ready_ci_waiting")
            else:
                for approval in ("plan_approval", "approval"):
                    with self.assertRaisesRegex(delivery.DeliveryError, "review evidence must be an object"):
                        execute({**finalize, approval: None})
                    self.assertTrue(client.prs[1]["draft"])
                with self.assertRaisesRegex(delivery.DeliveryError, "fixture deferral is incompatible"):
                    execute({**finalize, "actions_deferred_head": impl_pr["head_sha"]})
                self.assertTrue(client.prs[1]["draft"])
                lose_response(finalize, "ready")
                self.assertFalse(client.prs[1]["draft"])
                with patch.object(publisher.local_verifier, "verify", return_value={
                    "status": "blocked", "reason": "local_tests_failed", "head_sha": impl_pr["head_sha"],
                }), patch.object(publisher.Publisher, "_gate_ci", side_effect=AssertionError("Actions was queried")):
                    blocked = execute(finalize)
                self.assertEqual(blocked["status"], "post_ready_ci_blocked")
                self.assertEqual(blocked["ci"]["source"], "local")
                self.assertEqual(client.issue_labels, set())

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
            client.jobs = [{"id": 50, "name": "verify-fixture", "status": "completed", "conclusion": "success"}]
            if require_github_actions:
                client.review_label_exists = False
                with self.assertRaisesRegex(delivery.DeliveryError, "could not verify existing review label"):
                    execute(finalize)
                self.assertTrue(client.prs[1]["draft"])
                self.assertEqual(client.mutations, [("create", 1), ("edit", 1)])
                client.review_label_exists = True
                lose_response(finalize, "ready")
                lose_response(finalize, "label")
                final = execute(finalize)
                self.assertEqual(final["ci"]["run_id"], 41)
            else:
                success = {"status": "success", "reason": "local_tests_passed", "head_sha": impl_pr["head_sha"]}
                with patch.object(publisher.local_verifier, "verify", return_value=success) as verify, patch.object(
                        publisher.Publisher, "_gate_ci", side_effect=AssertionError("Actions was queried")):
                    lose_response(finalize, "label")
                    final = execute(finalize)
                    verify.assert_called_once()
                self.assertEqual(final["ci"]["source"], "local")
                self.assertEqual(final["ci"]["head_sha"], impl_pr["head_sha"])
            self.assertEqual(final["status"], "review_ready")
            self.assertEqual(final["pr"]["node_id"], plan_pr["node_id"])
            self.assertFalse(final["pr"]["draft"])
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
