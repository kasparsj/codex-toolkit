import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import delivery
import manual
import publisher_adapter


class ManualDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.repo = "owner/project"
        self.base = "a" * 40
        self.plan = "b" * 40
        self.implementation = "c" * 40
        self.pr = {
            "number": 7, "node_id": "PR-7", "repo": self.repo, "author_id": 42,
            "author_type": "User", "head_repo_id": 123, "base_repo_id": 123,
            "performed_via_github_app": None, "base": "main", "base_sha": self.base,
            "head": "codex/issue-1", "head_sha": self.plan, "body": "Plan body",
            "draft": True, "state": "OPEN",
        }
        self.state = {
            "repo": self.repo, "delivery_id": "test", "issue": 1, "credential_mode": "manual",
            "policy": {"digest": "d" * 64},
            "policy_values": {"delivery": {"publisher_id": 42, "final_target": "main"},
                              "approvals": {"implementation": {"minimum": 1, "reviewer_ids": [42]}}},
            "requirements": {"implementation": 1},
            "manifests": {
                "plan": {"value": {"result": {"baseline": {"sha": self.base}}}},
                "implement": {"generation": 1, "digest": "e" * 64, "value": {
                    "result": {"candidate_sha": self.implementation, "artifact_paths": ["README.md"]}}},
            },
            "publication": {"implementation": {"generation": 1, "manifest_digest": "e" * 64,
                                               "pr": {**self.pr, "head_sha": self.implementation}}},
        }

    def test_transport_rejects_writes_and_other_repos(self):
        client = manual.ReadClient(self.repo, "test")
        client.transport = Mock()
        for method, path in (("POST", "/repos/owner/project/pulls"), ("GET", "/repos/owner/other")):
            with self.assertRaises(delivery.DeliveryError):
                client.api(method, self.repo, path)
        client.transport.request.assert_not_called()

    def test_exact_pr_rejects_node_repository_author_and_head_drift(self):
        session = object.__new__(manual.Session)
        session.repository_id = 123
        session.author_id = 42
        session.ref = Mock(return_value=self.plan)
        publisher = Mock()
        publisher._get_pr.return_value = self.pr
        self.assertEqual(session.exact_pr(publisher, self.pr, draft=True), self.pr)
        for field, value in (("node_id", "PR-8"), ("head_repo_id", 321),
                             ("author_id", 99), ("head_sha", self.implementation),
                             ("base_sha", self.implementation), ("draft", False)):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                publisher._get_pr.return_value = {**self.pr, field: value}
                session.exact_pr(publisher, self.pr, draft=True)

    def test_allowlisted_developer_must_submit_review_on_current_head(self):
        context, pr, _ = publisher_adapter.approval_context(self.state, "implementation")
        receipt = {
            "id": 1, "user": {"id": 42, "type": "User"}, "state": "COMMENTED",
            "commit_id": self.plan, "submitted_at": "2026-11-09T00:00:00Z",
            "body": delivery.review_body("implementation", 1, context, "approve"),
        }
        with patch("manual.reviews", return_value={"paginated": True, "pr": pr, "reviews": [receipt]}):
            _, verdict = publisher_adapter.check_approval(self.state, Path("unused"), "implementation")
            self.assertEqual(verdict, "pending")
            receipt["commit_id"] = self.implementation
            _, verdict = publisher_adapter.check_approval(self.state, Path("unused"), "implementation")
            self.assertEqual(verdict, "approve")
            receipt["performed_via_github_app"] = {"id": 10}
            _, verdict = publisher_adapter.check_approval(self.state, Path("unused"), "implementation")
            self.assertEqual(verdict, "pending")

    def test_failure_and_partial_ready_steps_stay_resumable(self):
        pr = self.state["publication"]["implementation"]["pr"]
        packet = {"pr": pr}
        session = Mock()
        publisher = session.publisher.return_value
        publisher._get_pr.return_value = pr
        session.exact_pr.return_value = pr
        session.check_context.return_value = []
        publisher._existing_review_label.return_value = "review"
        publisher.verify_local_revision.return_value = {"status": "blocked", "head_sha": self.implementation}
        self.state["status"] = "publication_pending"
        save = Mock()
        with patch("manual.Session.from_state", return_value=session):
            manual.finalize(self.state, packet, save)
            self.assertEqual(self.state["status"], "pre_ready_ci_blocked")
            self.assertEqual(self.state["publication"]["progress"]["ci"]["status"], "blocked")
            self.assertNotIn("final", self.state["publication"])
            publisher._get_pr.return_value = {**pr, "draft": False}
            with self.assertRaisesRegex(delivery.DeliveryError, "before trusted verification"):
                manual.finalize(self.state, packet, save)
            publisher._get_pr.return_value = pr
            publisher.verify_local_revision.return_value = {"status": "success", "head_sha": self.implementation}
            manual.finalize(self.state, packet, save)
            self.assertEqual(self.state["status"], "manual_ready_pending")
            ready = {**pr, "draft": False}
            publisher._get_pr.return_value = ready
            session.exact_pr.return_value = ready
            manual.finalize(self.state, packet, save)
            self.assertEqual(self.state["status"], "tracking_pending")
            self.assertNotIn("final", self.state["publication"])
            session.check_context.return_value = ["review"]
            manual.finalize(self.state, packet, save)
            self.assertEqual(self.state["status"], "review_ready")
            self.assertEqual(self.state["publication"]["final"]["pr"], ready)
