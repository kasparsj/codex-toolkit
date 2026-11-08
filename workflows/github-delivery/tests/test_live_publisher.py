from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).parents[1]
for name in ("delivery", "trusted_git", "publisher"):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)

delivery = sys.modules["delivery"]
publisher = sys.modules["publisher"]


class FakeClient:
    def __init__(self, policy: bytes):
        self.policy = policy
        self.base_sha = "b" * 40
        self.policy_sha = self.base_sha
        self.actor_id = 900
        self.remote_heads = {}
        self.prs = {}
        self.reviews = {}
        self.issue_labels = {"ready"}
        self.mutations = []

    @staticmethod
    def _raw_pr(number, head, head_sha, base, base_sha, body, *, draft=True):
        repo = {"full_name": "acme/widget"}
        return {
            "number": number,
            "node_id": f"PR_{number}",
            "head": {"ref": head, "sha": head_sha, "repo": repo},
            "base": {"ref": base, "sha": base_sha, "repo": repo},
            "draft": draft,
            "body": body,
            "state": "open",
        }

    def api(self, method, _repo, endpoint, payload=None):
        if endpoint == "/user":
            return {"id": self.actor_id, "login": "publisher"}
        if "/git/ref/heads/" in endpoint:
            branch = endpoint.split("/git/ref/heads/", 1)[1]
            sha = self.policy_sha if branch == "main" else self.base_sha
            return {"object": {"sha": sha}}
        if "/contents/.github/delivery.toml" in endpoint:
            return {"encoding": "base64", "content": base64.b64encode(self.policy).decode()}
        if endpoint.endswith("/issues/42"):
            return {"number": 42, "state": "open", "labels": [
                {"name": name} for name in sorted(self.issue_labels)
            ]}
        if "/pulls/" in endpoint and method == "GET":
            number = int(endpoint.rsplit("/", 1)[1])
            return self.prs[number]
        if endpoint.endswith("/pulls") and method == "POST":
            number = max(self.prs, default=0) + 1
            raw = self._raw_pr(
                number,
                payload["head"],
                self.remote_heads[payload["head"]],
                payload["base"],
                self.base_sha,
                payload["body"],
            )
            self.prs[number] = raw
            self.mutations.append(("create", number))
            return raw
        if "/pulls/" in endpoint and method == "PATCH":
            number = int(endpoint.rsplit("/", 1)[1])
            self.prs[number].update({key: value for key, value in payload.items() if key in ("body",)})
            self.mutations.append(("edit", number))
            return self.prs[number]
        if "/labels/" in endpoint and method == "GET":
            return {"name": endpoint.rsplit("/", 1)[1]}
        if endpoint.endswith("/issues/42/labels") and method == "POST":
            self.issue_labels.update(payload["labels"])
            self.mutations.append(("label", tuple(payload["labels"])))
            return [{"name": name} for name in sorted(self.issue_labels)]
        raise AssertionError((method, endpoint, payload))

    def paginated(self, _repo, endpoint):
        if "/reviews?" in endpoint:
            number = int(endpoint.split("/pulls/", 1)[1].split("/", 1)[0])
            return self.reviews.get(number, [])
        if "/pulls?" in endpoint:
            query = parse_qs(urlparse(endpoint).query)
            branch = query["head"][0].split(":", 1)[1]
            return [pr for pr in self.prs.values() if pr["head"]["ref"] == branch]
        raise AssertionError(endpoint)

    def graphql(self, _query, variables):
        number = int(variables["id"].split("_", 1)[1])
        self.prs[number]["draft"] = False
        self.mutations.append(("ready", number))
        return {"data": {"markPullRequestReadyForReview": {"pullRequest": {
            "id": variables["id"], "isDraft": False,
        }}}}


class FakeTrustedGit:
    def __init__(self, client, root, url):
        self.client = client
        self.root = root
        self.url = url
        self.candidate = None
        self.imported = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def import_candidate(self, bundle, sha, base_sha, paths, hashes):
        self.imported = (bundle, sha, base_sha, paths, hashes)
        self.candidate = sha

    def fetch_base(self, branch, sha):
        if branch != "main" or sha != self.client.base_sha:
            raise delivery.DeliveryError("unexpected base")

    def remote_head(self, branch):
        return self.client.remote_heads.get(branch)

    def push(self, branch, sha, previous):
        if self.client.remote_heads.get(branch) != previous:
            raise delivery.DeliveryError("remote branch changed")
        if sha != self.candidate:
            raise delivery.DeliveryError("unimported candidate")
        self.client.remote_heads[branch] = sha


class LivePublisherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.policy = b"version = 1\n"
        self.client = FakeClient(self.policy)
        self.publisher = publisher.Publisher(
            repo="github.com/acme/widget",
            root=self.root,
            client=self.client,
            git_factory=lambda root, url: FakeTrustedGit(self.client, root, url),
        )
        self.policy_values = {
            "delivery": {"publisher_id": 900, "final_target": "main"},
            "eligibility": {"required_labels": ["ready"], "excluded_labels": ["blocked"]},
            "branches": {
                "default_parent": "main",
                "plan_template": "codex/plan-{issue}",
                "implementation_template": "codex/issue-{issue}",
                "allowed_parent_prefixes": ["main"],
            },
            "tracking": {"review_label": "status: review"},
            "approvals": {
                "plan": {"minimum": 1, "reviewer_ids": [101]},
                "implementation": {"minimum": 1, "reviewer_ids": [101]},
            },
            "version": 1,
        }
        self.common = {
            "schema_version": 1,
            "target_repo": "github.com/acme/widget",
            "delivery_id": "delivery-42",
            "policy": {
                "ref": "refs/remotes/origin/main",
                "sha": self.client.policy_sha,
                "digest": hashlib.sha256(self.policy).hexdigest(),
            },
            "policy_values": self.policy_values,
        }
        self.issue_digest = hashlib.sha256(
            delivery.canonical_json({"title": "", "body": ""})
        ).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def expected(self):
        return {
            "repo": "github.com/acme/widget",
            "issue": 42,
            "head": "codex/plan-42",
            "head_sha": "c" * 40,
            "base": "main",
            "base_sha": self.client.base_sha,
            "generation": 1,
            "manifest_digest": "d" * 64,
            "plan_revision": "c" * 40,
        }

    def test_plan_publish_imports_bundle_and_creates_exact_draft(self):
        packet = {
            **self.common,
            "action": "publish_plan",
            "expected": self.expected(),
            "candidate": {
                "bundle_path": str(self.root / "candidate.bundle"),
                "paths": ["docs/plan.md"],
                "hashes": {"docs/plan.md": "e" * 64},
            },
            "prior_pr": None,
        }
        result = self.publisher.execute(packet)
        self.assertEqual(result["pr"]["head_sha"], "c" * 40)
        self.assertTrue(result["pr"]["draft"])
        self.assertEqual(self.client.remote_heads["codex/plan-42"], "c" * 40)
        self.assertEqual(self.client.mutations, [("create", 1)])
        self.assertIn("Issue: https://github.com/acme/widget/issues/42", result["pr"]["body"])
        self.assertIn(f"issue-digest: {self.issue_digest}", result["pr"]["body"])

    def test_policy_drift_and_wrong_actor_block_before_mutation(self):
        packet = {
            **self.common,
            "action": "publish_plan",
            "expected": self.expected(),
            "candidate": {"bundle_path": "x", "paths": ["x"], "hashes": {"x": "e" * 64}},
        }
        self.client.policy_sha = "f" * 40
        with self.assertRaisesRegex(delivery.DeliveryError, "policy ref moved"):
            self.publisher.execute(packet)
        self.client.policy_sha = self.client.base_sha
        self.client.actor_id = 901
        with self.assertRaisesRegex(delivery.DeliveryError, "policy publisher"):
            self.publisher.execute(packet)
        self.assertEqual(self.client.mutations, [])

    def test_implementation_requires_fresh_plan_approval(self):
        plan_expected = self.expected()
        plan_body = "\n".join([
            "Issue: https://github.com/acme/widget/issues/42",
            "delivery-id: delivery-42",
            f"plan-revision: {plan_expected['head_sha']}",
            f"manifest-digest: {plan_expected['manifest_digest']}",
            f"issue-digest: {self.issue_digest}",
            "final-target: main",
        ])
        plan_raw = self.client._raw_pr(
            4, plan_expected["head"], plan_expected["head_sha"],
            plan_expected["base"], plan_expected["base_sha"], plan_body,
        )
        self.client.prs[4] = plan_raw
        plan_pr = self.publisher._normalize_pr(plan_raw)
        context = "9" * 64
        approval = {
            "stage": "plan",
            "pr": plan_pr,
            "context_digest": context,
            "generation": 1,
            "minimum": 1,
            "reviewer_ids": [101],
        }
        expected = self.expected()
        expected.update({
            "head": "codex/issue-42",
            "head_sha": "f" * 40,
            "manifest_digest": "8" * 64,
        })
        packet = {
            **self.common,
            "action": "publish_implementation",
            "expected": expected,
            "candidate": {"bundle_path": "candidate.bundle", "paths": ["src/change.py"]},
            "prior_pr": plan_pr,
            "plan_approval": approval,
        }
        with self.assertRaisesRegex(delivery.DeliveryError, "approval is not current"):
            self.publisher.execute(packet)
        self.assertNotIn("codex/issue-42", self.client.remote_heads)

        self.client.reviews[4] = [{
            "id": 20,
            "user": {"id": 101},
            "state": "COMMENTED",
            "commit_id": plan_expected["head_sha"],
            "body": delivery.review_body("plan", 1, context, "approve"),
            "submitted_at": "2026-11-08T00:00:00Z",
        }]
        result = self.publisher.execute(packet)
        self.assertEqual(result["pr"]["head_sha"], expected["head_sha"])
        self.assertEqual(self.client.remote_heads["codex/issue-42"], expected["head_sha"])

    def test_list_reviews_requires_exact_open_draft(self):
        expected = self.expected()
        raw = self.client._raw_pr(7, expected["head"], expected["head_sha"],
                                  expected["base"], expected["base_sha"], "body")
        self.client.prs[7] = raw
        self.client.reviews[7] = [{"id": 1}]
        normalized = self.publisher._normalize_pr(raw)
        result = self.publisher.execute({
            **self.common, "action": "list_reviews", "pr": normalized,
        })
        self.assertEqual(result["reviews"], [{"id": 1}])
        self.assertTrue(result["paginated"])

    def test_implementation_retry_adopts_already_converted_pr(self):
        self.policy_values["branches"]["implementation_template"] = "codex/plan-{issue}"
        expected = self.expected()
        expected.update({"head_sha": "f" * 40, "manifest_digest": "8" * 64})
        plan_body = "\n".join([
            "Issue: https://github.com/acme/widget/issues/42",
            "delivery-id: delivery-42",
            f"plan-revision: {expected['plan_revision']}",
            f"issue-digest: {self.issue_digest}",
            "final-target: main",
        ])
        prior_raw = self.client._raw_pr(
            8, expected["head"], expected["plan_revision"], expected["base"],
            expected["base_sha"], plan_body,
        )
        prior = self.publisher._normalize_pr(prior_raw)
        implementation_body = "\n".join([
            "Issue: https://github.com/acme/widget/issues/42",
            "delivery-id: delivery-42",
            f"plan-revision: {expected['plan_revision']}",
            f"manifest-digest: {expected['manifest_digest']}",
            f"issue-digest: {self.issue_digest}",
            "final-target: main",
        ])
        self.client.prs[8] = self.client._raw_pr(
            8, expected["head"], expected["head_sha"], expected["base"],
            expected["base_sha"], implementation_body,
        )
        context = "7" * 64
        self.client.reviews[8] = [{
            "id": 30,
            "user": {"id": 101},
            "state": "COMMENTED",
            "commit_id": expected["plan_revision"],
            "body": delivery.review_body("plan", 1, context, "approve"),
            "submitted_at": "2026-11-08T00:00:00Z",
        }]
        result = self.publisher.execute({
            **self.common,
            "action": "publish_implementation",
            "expected": expected,
            "candidate": {"bundle_path": "unused", "paths": ["src/change.py"]},
            "prior_pr": prior,
            "plan_approval": {
                "stage": "plan", "pr": prior, "context_digest": context,
                "generation": 1, "minimum": 1, "reviewer_ids": [101],
            },
        })
        self.assertEqual(result["pr"]["number"], 8)
        self.assertEqual(result["pr"]["head_sha"], expected["head_sha"])
        self.assertEqual(self.client.mutations, [])

    def test_finalize_rechecks_review_marks_ready_and_adds_label(self):
        self.policy_values["approvals"]["plan"]["minimum"] = 0
        expected = self.expected()
        expected.update({"head": "codex/issue-42", "head_sha": "f" * 40})
        body = "\n".join([
            "Issue: https://github.com/acme/widget/issues/42",
            "delivery-id: delivery-42",
            f"plan-revision: {expected['plan_revision']}",
            f"manifest-digest: {expected['manifest_digest']}",
            f"issue-digest: {self.issue_digest}",
            "final-target: main",
        ])
        raw = self.client._raw_pr(9, expected["head"], expected["head_sha"],
                                  expected["base"], expected["base_sha"], body)
        self.client.prs[9] = raw
        normalized = self.publisher._normalize_pr(raw)
        context = "1" * 64
        review = {
            "id": 11,
            "user": {"id": 101},
            "state": "COMMENTED",
            "commit_id": expected["head_sha"],
            "body": delivery.review_body("implementation", 1, context, "approve"),
            "submitted_at": "2026-11-08T00:00:00Z",
        }
        self.client.reviews[9] = [review]
        approval = {
            "stage": "implementation",
            "pr": normalized,
            "context_digest": context,
            "generation": 1,
            "minimum": 1,
            "reviewer_ids": [101],
        }
        packet = {
            **self.common,
            "action": "finalize",
            "issue": 42,
            "pr": normalized,
            "expected": expected,
            "approval": approval,
            "plan_approval": None,
            "existing_review_label": "status: review",
        }
        result = self.publisher.execute(packet)
        self.assertFalse(result["pr"]["draft"])
        self.assertIn("status: review", result["issue"]["labels"])
        self.assertEqual(self.client.mutations, [("ready", 9), ("label", ("status: review",))])


if __name__ == "__main__":
    unittest.main()
