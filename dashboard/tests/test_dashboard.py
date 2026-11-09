from __future__ import annotations

import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from dashboard import projection, server


REPO = "owner/private"
DELIVERY = "delivery-1"
BASE = "a" * 40
HEAD = "b" * 40
BODY = "runner owned body"
PLAN = b"# Exact plan\n\nPinned evidence.\n"
APPROVE = "delivery-review plan 2 " + "c" * 64 + " approve"
REJECT = "delivery-review plan 2 " + "c" * 64 + " reject"


def snapshot(*, status="plan_review", runner="paused", step="plan-review", claim="active",
             receipt=None, expires=120, head=HEAD, generation=2):
    now = datetime.now(timezone.utc)
    return {
        "projection_version": 1, "generated_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=expires)).isoformat(),
        "binding": {"repo": REPO, "repository_id": 55, "delivery_id": DELIVERY},
        "delivery": {"issue": 8, "status": status, "attempt": 1, "runner_status": runner,
                     "current_step_id": step, "claim_status": claim},
        "plan": {"generation": generation, "published_at": now.isoformat(),
                 "pr": {"repo": REPO, "number": 7, "node_id": "PR_7", "head": "codex/issue-8",
                        "head_sha": head, "base": "main", "base_sha": BASE, "draft": True,
                        "state": "OPEN", "author_id": 900, "author_type": "Bot",
                        "author_login": "fixture[bot]", "head_repo_id": 55, "base_repo_id": 55,
                        "performed_via_github_app": {"id": 91, "slug": "fixture"},
                        "body_digest": hashlib.sha256(BODY.encode()).hexdigest()},
                 "artifacts": [{"path": "docs/plan.md", "sha256": hashlib.sha256(PLAN).hexdigest()}],
                 "review": {"stage": "plan", "generation": generation, "context_digest": "c" * 64,
                            "minimum": 1, "reviewer_ids": [101], "submit_as": "COMMENT",
                            "approve": APPROVE, "reject": REJECT,
                            "approval_body_digest": hashlib.sha256(APPROVE.encode()).hexdigest()},
                 "receipt": receipt},
        "implementation": None,
        "policy": {"publisher_id": 900, "app_id": 91, "app_slug": "fixture"},
    }


def github_values(*, user=101, head=HEAD, base=BASE, artifact=PLAN, review=None):
    return {
        "/user": {"id": user, "login": f"user-{user}", "type": "User"},
        f"/repos/{REPO}": {"id": 55, "private": True},
        f"/repos/{REPO}/pulls/7": {"number": 7, "node_id": "PR_7", "draft": True, "state": "open",
            "body": BODY, "user": {"id": 900, "type": "Bot", "login": "fixture[bot]"},
            "head": {"ref": "codex/issue-8", "sha": head, "repo": {"id": 55}},
            "base": {"ref": "main", "sha": base, "repo": {"id": 55}},
            "performed_via_github_app": {"id": 91, "slug": "fixture"}},
        f"/repos/{REPO}/issues/8": {"title": "Synthetic issue"},
        f"/repos/{REPO}/contents/docs/plan.md?ref={HEAD}": {
            "type": "file", "name": "plan.md", "path": "docs/plan.md", "encoding": "base64",
            "content": "\n".join([base64.b64encode(artifact).decode()[i:i + 12]
                                   for i in range(0, len(base64.b64encode(artifact).decode()), 12)])},
        **({f"/repos/{REPO}/pulls/7/reviews/44": review} if review else {}),
    }


class FakeGitHub:
    values = {}
    callback = None

    def __init__(self, token):
        self.token = token

    def get(self, path):
        if type(self).callback:
            type(self).callback(path)
        value = self.values.get(path)
        if isinstance(value, Exception):
            raise value
        if value is None:
            raise server.GitHubUnavailable("missing fixture")
        return deepcopy(value)


class SessionStoreTest(unittest.TestCase):
    def test_pending_cap_recovers_after_expiry(self):
        store = server.SessionStore()
        with patch.object(server, "MAX_PENDING_SIGN_INS", 1), patch.object(server.time, "monotonic") as clock:
            clock.return_value = 100
            key, _ = store.create()
            with self.assertRaises(server.SessionCapacity):
                store.create()
            clock.return_value += server.SIGN_IN_TTL
            new_key, _ = store.create()
            self.assertNotIn(key, store.values)
            self.assertNotEqual(key, new_key)

    def test_state_is_consumed_once(self):
        store = server.SessionStore()
        key, session = store.create()
        self.assertEqual(store.consume_sign_in(key, session.oauth_state), session.verifier)
        with self.assertRaises(server.NotAuthorized):
            store.consume_sign_in(key, session.oauth_state)

    def test_total_session_cap_and_expiration(self):
        store = server.SessionStore()
        with patch.object(server, "MAX_SESSIONS", 1), patch.object(server.time, "monotonic") as clock:
            clock.return_value = 100
            key, _ = store.create(token="test-token")
            with self.assertRaises(server.SessionCapacity):
                store.create()
            clock.return_value += server.SESSION_TTL
            store.create(token="other-test-token")
            self.assertNotIn(key, store.values)


class DashboardServiceTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.snap = self.root / "projection.json"
        self.invalid = self.root / "invalidations.json"
        FakeGitHub.values = github_values()
        FakeGitHub.callback = None
        self.service = server.DashboardService(snapshot=self.snap, invalidations=self.invalid,
                                               repo=REPO, delivery_id=DELIVERY,
                                               github_factory=FakeGitHub)
        self.write(snapshot())

    def write(self, value):
        self.snap.write_text(json.dumps(value))
        os.chmod(self.snap, 0o600)

    def test_eligible_viewer_gets_exact_comment_and_verified_plan(self):
        result = self.service.present("token")
        self.assertEqual(result["item"]["review"]["approve"], APPROVE)
        self.assertEqual(result["item"]["review"]["submit_as"], "COMMENT")
        self.assertEqual(result["item"]["artifacts"][0]["content"], PLAN.decode())
        self.assertNotIn("approval_body_digest", json.dumps(result))

    def test_ineligible_viewer_sees_evidence_without_text(self):
        FakeGitHub.values = github_values(user=102)
        result = self.service.present("token")
        self.assertNotIn("review", result["item"])
        self.assertIn("Pinned evidence", result["item"]["artifacts"][0]["content"])

    def test_repo_denial_returns_no_private_payload(self):
        FakeGitHub.values[f"/repos/{REPO}"] = server.NotAuthorized("denied")
        with self.assertRaises(server.NotAuthorized):
            self.service.present("token")

    def test_viewer_lookup_failure_after_repo_access_withholds_text(self):
        FakeGitHub.values["/user"] = server.GitHubUnavailable("viewer timeout")
        result = self.service.present("token")
        self.assertEqual(result["item"]["state"], "eligibility_unavailable")
        self.assertNotIn("review", result["item"])
        self.assertNotIn(APPROVE, json.dumps(result))

    def test_malformed_viewer_is_unknown_eligibility(self):
        FakeGitHub.values["/user"] = []
        result = self.service.present("token")
        self.assertEqual(result["item"]["state"], "eligibility_unavailable")
        self.assertNotIn("review", result["item"])

    def test_pr_unavailable_returns_saved_links_but_no_text(self):
        FakeGitHub.values[f"/repos/{REPO}/pulls/7"] = server.GitHubUnavailable("timeout")
        result = self.service.present("token")
        self.assertEqual(result["item"]["state"], "github_unavailable")
        self.assertNotIn("review", result["item"])
        self.assertNotIn(APPROVE, json.dumps(result))

    def test_digest_mismatch_withholds_controls(self):
        FakeGitHub.values = github_values(artifact=b"changed")
        result = self.service.present("token")
        self.assertEqual(result["item"]["state"], "evidence_unavailable")
        self.assertNotIn("review", result["item"])

    def test_head_drift_persists_across_rollback_and_instances(self):
        FakeGitHub.values = github_values(head="d" * 40)
        changed = self.service.present("token")
        self.assertEqual(changed["item"]["state"], "revision_changed")
        self.assertTrue(changed["item"]["pr"]["current_commit_url"].endswith("d" * 40))
        FakeGitHub.values = github_values()
        second = server.DashboardService(snapshot=self.snap, invalidations=self.invalid,
                                         repo=REPO, delivery_id=DELIVERY, github_factory=FakeGitHub)
        rolled_back = second.present("token")
        self.assertEqual(rolled_back["item"]["state"], "revision_changed")
        self.assertNotIn(APPROVE, json.dumps(rolled_back))

    def test_base_drift_invalidates_same_head(self):
        FakeGitHub.values = github_values(base="d" * 40)
        result = self.service.present("token")
        self.assertEqual(result["item"]["state"], "revision_changed")

    def test_corrupt_invalidation_store_fails_closed(self):
        self.invalid.write_text("not-json")
        os.chmod(self.invalid, 0o600)
        with self.assertRaises(server.DashboardError):
            self.service.present("token")

    def test_feed_change_during_live_read_cannot_return_old_text(self):
        changed = snapshot(status="implementation_required", runner="running", step="implementation")
        fired = False
        def mutate(path):
            nonlocal fired
            if path.endswith("/pulls/7") and not fired:
                fired = True
                self.write(changed)
        FakeGitHub.callback = mutate
        result = self.service.present("token", force=True)
        self.assertNotIn("review", result["item"])

    def test_requested_old_revision_cannot_revive_after_new_request(self):
        old = server.revision_key(snapshot())
        self.write(snapshot(head="d" * 40, generation=3))
        result = self.service.present("token", requested_revision=old)
        self.assertEqual(result["status"], "stale")
        self.assertNotIn(APPROVE, json.dumps(result))

    def test_stale_revision_is_not_disclosed_before_repo_access(self):
        FakeGitHub.values[f"/repos/{REPO}"] = server.NotAuthorized("denied")
        with self.assertRaises(server.NotAuthorized):
            self.service.present("token", requested_revision="0" * 64)

    def test_wrong_step_running_failed_and_inactive_suppress_controls(self):
        cases = [
            snapshot(step="other"), snapshot(runner="running"), snapshot(runner="failed"),
            snapshot(claim="released"), snapshot(status="implementation_required"),
        ]
        for value in cases:
            with self.subTest(value=value["delivery"]):
                self.write(value)
                result = self.service.present("token")
                self.assertNotIn("review", result["item"])

    def test_receipt_states_and_verified_enrichment(self):
        receipt = {"approved": True, "approvers": [101], "rejectors": [], "minimum": 1,
                   "review_ids": {"101": 44}, "commit_id": HEAD, "context_digest": "c" * 64,
                   "checked_at": "2026-11-09T12:00:00+00:00"}
        review = {"id": 44, "user": {"id": 101, "login": "reviewer"}, "commit_id": HEAD,
                  "state": "COMMENTED", "body": APPROVE, "submitted_at": "2026-11-09T11:59:00Z",
                  "html_url": "https://github.com/owner/private/pull/7#pullrequestreview-44"}
        self.write(snapshot(receipt=receipt))
        FakeGitHub.values = github_values(review=review)
        result = self.service.present("token")
        self.assertEqual(result["item"]["state"], "verified_waiting")
        self.assertEqual(result["item"]["receipt"]["enrichment"], "verified")
        self.assertNotIn("review", result["item"])

    def test_wrong_review_context_sha_user_state_or_body_is_not_enriched(self):
        receipt = {"approved": True, "approvers": [101], "rejectors": [], "minimum": 1,
                   "review_ids": {"101": 44}, "commit_id": HEAD, "context_digest": "c" * 64}
        self.write(snapshot(receipt=receipt))
        base_review = {"id": 44, "user": {"id": 101}, "commit_id": HEAD,
                       "state": "COMMENTED", "body": APPROVE}
        mutations = [{"commit_id": BASE}, {"user": {"id": 102}}, {"state": "DISMISSED"},
                     {"body": REJECT}]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                review = {**base_review, **mutation}
                FakeGitHub.values = github_values(review=review)
                self.assertEqual(self.service.present("token")["item"]["receipt"]["enrichment"], "unavailable")

    def test_later_runner_stages_are_not_waiting_for_resume(self):
        receipt = {"approved": True, "approvers": [101], "rejectors": [], "minimum": 1}
        for status, expected in [("implementation_required", "implementation_next"),
                                 ("implementation_review", "implementation_review"),
                                 ("review_ready", "delivery_ready")]:
            with self.subTest(status=status):
                self.write(snapshot(status=status, runner="completed", step="done", claim="released",
                                    receipt=receipt))
                self.assertEqual(self.service.present("token")["item"]["state"], expected)

    def test_expired_or_overpermissive_snapshot_fails(self):
        self.write(snapshot(expires=-1))
        with self.assertRaises(server.DashboardError): self.service.present("token")
        self.write(snapshot())
        os.chmod(self.snap, 0o644)
        with self.assertRaises(server.DashboardError): self.service.present("token")


class ProjectionTest(unittest.TestCase):
    def test_projection_accepts_host_qualified_repo_and_keeps_pr_body_digest_server_side(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        policy = {"_source": {"ref": "refs/heads/main", "sha": BASE, "digest": "d" * 64},
                  "branches": {"default_parent": "main", "plan_template": "codex/issue-{issue}",
                               "implementation_template": "codex/issue-{issue}"},
                  "delivery": {"final_target": "main", "publisher_id": 900},
                  "approvals": {"plan": {"minimum": 1, "reviewer_ids": [101]},
                                "implementation": {"minimum": 1, "reviewer_ids": [101]}},
                  "tracking": {"review_label": "review"}}
        coordinator = projection.delivery.Coordinator(root / "state")
        state = coordinator.start(repo=REPO, issue=8, policy=policy, skills_root=ROOT / "skills",
                                  publisher_launcher="/fixture", app={"repository_id": 55, "app_id": 91,
                                  "app_slug": "fixture"}, delivery_id=DELIVERY)
        manifest = {"schema_version": 1, "kind": "plan", "repo": REPO, "delivery_id": DELIVERY,
                    "result": {"issue": 8, "baseline": {"repo": REPO, "ref": "main", "sha": BASE},
                               "plan_revision": HEAD, "artifact_paths": ["docs/plan.md"],
                               "artifact_hashes": {"docs/plan.md": hashlib.sha256(PLAN).hexdigest()}}}
        coordinator.accept_manifest(state, manifest)
        expected = projection.publisher_adapter.expected_publication(state, "plan")
        state["publication"] = {"plan": {"generation": 1, "manifest_digest": expected["manifest_digest"],
            "pr": {"repo": f"github.com/{REPO}", "number": 7, "node_id": "PR_7", "head": expected["head"],
                   "head_sha": HEAD, "base": "main", "base_sha": BASE, "draft": True, "state": "OPEN",
                   "body": BODY, "author_id": 900, "author_type": "Bot", "author_login": "fixture[bot]"}}}
        state.update(runner_status="paused", runner={"current_step_id": "plan-review"})
        coordinator.save(state)
        value = projection.build_projection(root / "state", REPO, DELIVERY)
        self.assertEqual(value["plan"]["pr"]["repo"], REPO)
        self.assertEqual(value["plan"]["pr"]["body_digest"], hashlib.sha256(BODY.encode()).hexdigest())
        self.assertNotIn(BODY, json.dumps(value))

    def test_projection_rejects_unsafe_artifact(self):
        with self.assertRaises(projection.ProjectionError):
            projection._safe_artifacts({"artifact_paths": ["../secret.md"],
                                        "artifact_hashes": {"../secret.md": "a" * 64}})


class AllowlistTest(unittest.TestCase):
    def test_github_client_is_get_only_and_pinned_host_paths_only(self):
        self.assertTrue(server.GitHubClient.allowed(f"/repos/{REPO}/contents/docs/plan.md?ref={HEAD}"))
        for path in ("https://evil.test/user", f"/repos/{REPO}/contents/../secret?ref={HEAD}",
                     f"/repos/{REPO}/contents/docs/plan.md?ref=main", f"/repos/{REPO}/hooks"):
            self.assertFalse(server.GitHubClient.allowed(path), path)


if __name__ == "__main__":
    unittest.main()
