from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parents[1]))
import delivery
import effective_policy
import onboarding
import preview
from publisher import Publisher


SHA = "1" * 40
REPO = "owner/repo"


def policy():
    gate = {"minimum": 1, "reviewer_ids": [4]}
    return {
        "version": 1, "delivery": {"final_target": "$default", "publisher_id": 2},
        "branches": {"default_parent": "$default", "plan_template": "codex/issue-{issue}",
                     "implementation_template": "codex/issue-{issue}"},
        "eligibility": {"required_labels": [], "excluded_labels": sorted(effective_policy.EXCLUSION_FLOOR)},
        "tracking": {"review_label": "status: in review"},
        "approvals": {"plan": gate, "implementation": gate},
    }


class ReadFixture:
    sha = SHA
    override = None
    calls = None

    def __init__(self):
        self.calls = []

    def read(self, endpoint, *, missing=False, paginated=False):
        self.calls.append(endpoint)
        path = endpoint.removeprefix(f"repos/{REPO}")
        if path == "":
            return {"id": 3, "full_name": REPO, "private": True, "default_branch": "main"}
        if path == "/git/ref/heads/main":
            return {"object": {"sha": self.sha}}
        if path.startswith("/contents/.github/delivery.toml?ref="):
            if self.override is None:
                if not missing:
                    raise AssertionError("optional policy must handle a verified 404")
                return None
            return {"type": "file", "encoding": "base64",
                    "content": base64.b64encode(self.override).decode()}
        if path.startswith("/contents?ref="):
            return [{"path": "README.md", "type": "file"}]
        if path == "/issues?state=open&per_page=100":
            return [
                {"number": number, "state": "open", "title": "Update README.md", "body": None,
                 "created_at": f"2026-01-0{number}T00:00:00Z", "labels": [{"name": label}]}
                for number, label in [(1, "feature"), (2, "deferred"), (3, "bug")]
            ]
        if path == "/pulls?state=open&per_page=100":
            return [{"number": 4, "state": "open", "title": "Cover issue", "body": "Closes #3",
                     "draft": True, "head": {"ref": "covered", "sha": SHA},
                     "base": {"sha": SHA, "ref": "main", "repo": {"id": 3}}}]
        if path.startswith("/issues/1/"):
            return []
        if path.startswith("/pulls/4"):
            pr = {"number": 4, "state": "open", "changed_files": 1,
                  "head": {"sha": SHA}, "base": {"sha": SHA, "ref": "main", "repo": {"id": 3}}}
            return [{"filename": "unrelated.md"}] if "/files?" in path else pr
        raise AssertionError(f"unexpected read {endpoint}")

    def api(self, method, repo, endpoint):
        if method != "GET":
            raise AssertionError("shared resolver must not mutate")
        try:
            return self.read(endpoint.format(owner="owner", repo="repo").lstrip("/"))
        except AssertionError:
            if "/contents/.github/delivery.toml?" not in endpoint:
                raise
            raise delivery.DeliveryError("not found") from HTTPError("", 404, "", {}, None)


class OnboardingIntegrationTest(unittest.TestCase):
    def test_preview_and_explicit_start_share_label_and_draft_coverage_rules(self):
        fixture = ReadFixture()
        defaults = policy()
        result = preview.run(REPO, reader=fixture.read, resolve=lambda repo, ref, sha:
                             onboarding.resolve(defaults, repo, ref, sha, fixture.read))
        self.assertEqual(result["winner"], 1, result)
        effective = onboarding.resolve(defaults, REPO, "main", SHA, fixture.read)
        self.assertEqual(preview.verify_candidate(REPO, 1, effective, reader=fixture.read), 1)
        for issue in result["exclusions"]:
            with self.assertRaisesRegex(preview.PreviewError, issue["reason"]):
                preview.verify_candidate(REPO, issue["number"], effective, reader=fixture.read)
        self.assertEqual({issue["number"] for issue in result["exclusions"]}, {2, 3})

    def test_publisher_uses_same_pinned_override_and_blocks_drift(self):
        fixture = ReadFixture()
        fixture.override = b'version = 1\n[eligibility]\nrequired_labels = ["feature"]\n'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "defaults.json"
            defaults = policy()
            path.write_text(json.dumps(defaults))
            path.chmod(0o600)
            effective = onboarding.resolve(defaults, REPO, "main", SHA, fixture.read)
            self.assertTrue(effective["_source"]["override_present"])
            packet = {"policy": effective["_source"], "policy_values": effective}
            binding = SimpleNamespace(repository=REPO, repository_id=3)
            publisher = Publisher(repo=REPO, root=root, client=fixture,
                                  app_session=SimpleNamespace(binding=binding), operator_policy=path)
            publisher._verify_policy(packet)
            fixture.override += b"\n# Same effective policy, different source\n"
            with self.assertRaisesRegex(RuntimeError, "policy drifted"):
                publisher._verify_policy(packet)
            fixture.sha = "2" * 40
            with self.assertRaisesRegex(RuntimeError, "ref moved"):
                publisher._verify_policy(packet)

    def test_only_known_private_personal_plan_response_can_replace_rules_read(self):
        def reader(endpoint, **kwargs):
            if "/rules/" not in endpoint:
                return {"protected": False, "private": True, "owner": {"type": "User"}}
            err = HTTPError("", 403, "", {}, io.BytesIO(json.dumps({"message": message}).encode()))
            raise delivery.DeliveryError("HTTP 403") from err

        message = "Upgrade to GitHub Pro or make this repository public to enable this feature."
        result = onboarding.branch_rules(REPO, "main", "codex/issue-1", reader)
        self.assertEqual(result["rulesets_unavailable_on_private_personal_plan"],
                         ["codex/issue-1", "main"])
        message = "Resource not accessible by integration"
        with self.assertRaisesRegex(delivery.DeliveryError, "rules unavailable"):
            onboarding.branch_rules(REPO, "main", "codex/issue-1", reader)

    def test_operator_profile_cannot_drop_protected_exclusions(self):
        defaults = policy()
        defaults["eligibility"]["excluded_labels"].remove("deferred")
        with self.assertRaisesRegex(effective_policy.PolicyResolutionError, "must include"):
            onboarding.resolve(defaults, REPO, "main", SHA, ReadFixture().read)


if __name__ == "__main__":
    unittest.main()
