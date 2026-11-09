from __future__ import annotations

import base64
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).parents[1] / "effective_policy.py"
SPEC = importlib.util.spec_from_file_location("effective_policy", MODULE)
policy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(policy)


def profile():
    return {
        "version": 1,
        "delivery": {"final_target": "main", "publisher_id": 900,
                     "require_github_actions": False},
        "eligibility": {"required_labels": [], "excluded_labels": [
            "blocked", "duplicate", "invalid", "wontfix", "deferred",
        ]},
        "branches": {"default_parent": "main", "allowed_parent_prefixes": ["main"],
                     "plan_template": "codex/issue-{issue}",
                     "implementation_template": "codex/issue-{issue}"},
        "tracking": {"review_label": "status: in review"},
        "approvals": {
            "plan": {"minimum": 1, "reviewer_ids": [101]},
            "implementation": {"minimum": 1, "reviewer_ids": [101]},
        },
        "verification": {"mode": "local", "argv": ["/usr/local/bin/verify"]},
        "_override_constraints": {
            "required_labels": ["feature", "bug", "ready"],
            "additional_excluded_labels": ["security-review"],
            "review_labels": ["status: in review", "status: delivery review"],
        },
    }


class EffectivePolicyTest(unittest.TestCase):
    def resolve(self, operator=None, override=None, access=True):
        return policy.resolve(operator or profile(), default_branch="main", base_sha="a" * 40,
                              override_bytes=override, contents_access_verified=access)

    def test_verified_absence_selects_defaults_and_pins_runner_source(self):
        result = self.resolve()
        self.assertEqual(result["source"], "operator-defaults")
        self.assertFalse(result["provenance"]["override_present"])
        self.assertIsNone(result["provenance"]["override_digest"])
        self.assertEqual(result["values"]["eligibility"]["required_labels"], [])
        self.assertIn("deferred", result["values"]["eligibility"]["excluded_labels"])
        self.assertEqual(result["values"]["_source"]["ref"], "refs/heads/main")
        self.assertEqual(result["values"]["_source"]["source"], "operator-defaults")
        self.assertEqual(result["values"]["_source"]["digest"],
                         result["provenance"]["effective_digest"])

    def test_absence_without_pinned_contents_access_blocks(self):
        with self.assertRaisesRegex(policy.PolicyResolutionError, "contents access"):
            self.resolve(access=False)

    def test_allowlisted_override_preserves_protected_exclusion_floor(self):
        override = b'''version = 1
[eligibility]
required_labels = ["feature"]
excluded_labels = ["blocked", "duplicate", "invalid", "wontfix", "deferred", "security-review"]
[tracking]
review_label = "status: delivery review"
'''
        result = self.resolve(override=override)
        self.assertEqual(result["source"], "default-branch-override")
        self.assertEqual(result["values"]["eligibility"]["required_labels"], ["feature"])
        self.assertEqual(result["values"]["tracking"]["review_label"],
                         "status: delivery review")
        self.assertEqual(result["provenance"]["override_digest"], policy.digest(override))

    def test_full_policy_may_repeat_but_not_change_protected_fields(self):
        good = b'''version = 1
[delivery]
final_target = "main"
publisher_id = 900
require_github_actions = false
[eligibility]
required_labels = []
excluded_labels = ["blocked", "duplicate", "invalid", "wontfix", "deferred"]
[branches]
default_parent = "main"
allowed_parent_prefixes = ["main"]
plan_template = "codex/issue-{issue}"
implementation_template = "codex/issue-{issue}"
[tracking]
review_label = "status: in review"
[approvals.plan]
minimum = 1
reviewer_ids = [101]
[approvals.implementation]
minimum = 1
reviewer_ids = [101]
[verification]
mode = "local"
argv = ["/usr/local/bin/verify"]
'''
        self.resolve(override=good)
        with self.assertRaisesRegex(policy.PolicyResolutionError,
                                    "protected field delivery.publisher_id"):
            self.resolve(override=good.replace(b"publisher_id = 900", b"publisher_id = 901"))

    def test_authority_expansion_and_weakened_exclusions_block(self):
        with self.assertRaisesRegex(policy.PolicyResolutionError, "remove protected exclusions"):
            self.resolve(override=b'''version = 1
[eligibility]
excluded_labels = ["blocked"]
''')
        with self.assertRaisesRegex(policy.PolicyResolutionError, "exceeds operator constraints"):
            self.resolve(override=b'''version = 1
[tracking]
review_label = "create-me"
''')

    def test_protected_approval_gates_and_one_branch_are_required(self):
        operator = profile()
        operator["approvals"]["plan"]["minimum"] = 0
        with self.assertRaisesRegex(policy.PolicyResolutionError, "must require a human"):
            self.resolve(operator=operator)
        operator = profile()
        operator["branches"]["implementation_template"] = "codex/implementation-{issue}"
        with self.assertRaisesRegex(policy.PolicyResolutionError, "reuse one"):
            self.resolve(operator=operator)
        operator = profile()
        operator["approvals"]["plan"]["reviewer_ids"] = [900]
        with self.assertRaisesRegex(policy.PolicyResolutionError, "publisher cannot"):
            self.resolve(operator=operator)

    def test_missing_reviewers_are_a_publication_blocker_not_a_preview_failure(self):
        operator = profile()
        operator["approvals"]["plan"]["reviewer_ids"] = []
        result = self.resolve(operator=operator)
        self.assertFalse(result["summary"]["publication_ready"])
        self.assertEqual(result["summary"]["publication_blockers"], ["missing_plan_reviewers"])

    def test_resolve_at_confirms_absence_and_decodes_present_file(self):
        calls = []
        def absent(endpoint, missing=False):
            calls.append((endpoint, missing))
            return None if missing else []
        result = policy.resolve_at(profile(), default_branch="main", base_sha="b" * 40,
                                   read=absent)
        self.assertEqual(result["source"], "operator-defaults")
        self.assertEqual(calls, [
            (f"/contents/.github/delivery.toml?ref={'b' * 40}", True),
            (f"/contents?ref={'b' * 40}", False),
        ])

        raw = b'version = 1\n[eligibility]\nrequired_labels = ["bug"]\n'
        def present(_endpoint, missing=False):
            return {"type": "file", "encoding": "base64",
                    "content": base64.b64encode(raw).decode()}
        result = policy.resolve_at(profile(), default_branch="main", base_sha="c" * 40,
                                   read=present)
        self.assertEqual(result["values"]["eligibility"]["required_labels"], ["bug"])

    def test_malformed_unknown_and_profile_drift_inputs_block(self):
        with self.assertRaisesRegex(policy.PolicyResolutionError, "invalid repository policy TOML"):
            self.resolve(override=b"not = [valid")
        with self.assertRaisesRegex(policy.PolicyResolutionError, "unknown field"):
            self.resolve(override=b"version = 1\n[repository]\nwrite = true\n")
        with self.assertRaisesRegex(policy.PolicyResolutionError, "unknown field"):
            self.resolve(override=b"version = 1\n[repository]\n")
        with self.assertRaisesRegex(policy.PolicyResolutionError, "protected field delivery.publisher_id"):
            self.resolve(override=b"version = 1\n[delivery]\npublisher_id = true\n")
        first = self.resolve()
        operator = copy.deepcopy(profile())
        operator["_override_constraints"]["required_labels"].append("area: frontend")
        second = self.resolve(operator=operator)
        self.assertNotEqual(first["provenance"]["profile_digest"],
                            second["provenance"]["profile_digest"])
        self.assertEqual(first["provenance"]["effective_digest"],
                         second["provenance"]["effective_digest"])

    def test_default_branch_sentinel_and_protected_loader(self):
        operator = profile()
        operator["delivery"]["final_target"] = "$default"
        operator["branches"]["default_parent"] = "$default"
        result = self.resolve(operator=operator)
        self.assertEqual(result["values"]["delivery"]["final_target"], "main")
        self.assertEqual(result["values"]["branches"]["default_parent"], "main")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "operator.json"
            path.write_text(policy.json.dumps(operator))
            path.chmod(0o600)
            self.assertEqual(policy.load(path), operator)
            path.chmod(0o644)
            with self.assertRaisesRegex(policy.PolicyResolutionError, "only by its owner"):
                policy.load(path)


if __name__ == "__main__":
    unittest.main()
