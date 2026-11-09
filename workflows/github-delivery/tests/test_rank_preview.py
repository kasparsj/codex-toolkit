from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


DELIVERY = Path(__file__).parents[1] / "delivery.py"
SHA = "a" * 40
POLICY = """\
version = 1

[eligibility]
required_labels = []
excluded_labels = ["blocked"]

[branches]
default_parent = "main"
"""


FAKE_GH = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

fixture = json.loads(Path(os.environ["FAKE_GH_FIXTURE"]).read_text())
args = sys.argv[1:]
log_path = Path(os.environ["FAKE_GH_LOG"])
previous = [json.loads(line) for line in log_path.read_text().splitlines()] if log_path.exists() else []
with log_path.open("a") as log:
    log.write(json.dumps(args) + "\n")

if not args or args[0] != "api":
    print("fake gh supports only api", file=sys.stderr)
    raise SystemExit(64)
method = "GET"
for index, arg in enumerate(args):
    if arg in ("--method", "-X") and index + 1 < len(args):
        method = args[index + 1]
if method != "GET":
    print("fake gh rejected non-GET request", file=sys.stderr)
    raise SystemExit(65)
endpoint = next((arg for arg in args[1:] if arg.startswith("repos/")), None)
if endpoint is None or endpoint not in fixture["routes"]:
    print(f"fake gh has no route for {endpoint!r}", file=sys.stderr)
    raise SystemExit(66)
route = fixture["routes"][endpoint]
if isinstance(route, list):
    route = route[sum(endpoint in call for call in previous)]
status = route.get("status", 200)
if status != 200:
    print(route.get("stderr", f"gh: HTTP {status}"), file=sys.stderr)
    raise SystemExit(1)
value = route["json"]
if "--paginate" in args and "--slurp" in args:
    value = [value]
print(json.dumps(value))
'''


def issue(number: int, title: str, body: str | None, labels: list[str] | None = None) -> dict:
    return {
        "number": number,
        "state": "open",
        "title": title,
        "body": body,
        "labels": [{"name": label} for label in (labels or [])],
        "created_at": f"2026-01-{number:02d}T12:00:00Z",
    }


def pull(number: int, title: str, body: str | None, *, draft: bool, ref: str) -> dict:
    return {
        "number": number,
        "state": "open",
        "draft": draft,
        "title": title,
        "body": body,
        "changed_files": 1,
        "head": {"ref": ref, "sha": f"{number:040x}", "repo": {"full_name": "owner/repo"}},
        "base": {"ref": "main", "sha": SHA, "repo": {"id": 101}},
    }


class RankPreviewCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.gh = self.bin / "gh"
        self.gh.write_text(FAKE_GH)
        self.gh.chmod(0o700)
        self.policy = self.root / "provisional.toml"
        self.policy.write_text(POLICY)
        self.fixture = self.root / "fixture.json"
        self.log = self.root / "gh.log"
        self.run_dir = self.root / "run"
        self.run_dir.mkdir()
        self.home = self.root / "home"
        self.home.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def routes(self, *, remote_policy: str | None = None) -> dict:
        issues = [
            issue(1, "Clarify docs/guide.md", "Update docs/guide.md with the missing setup step."),
            issue(3, "Clarify docs/draft.md", "Update docs/draft.md after review."),
            issue(4, "Clarify docs/blocked.md", "Update docs/blocked.md.", ["blocked"]),
            issue(5, "Fix code edge case", "The UI change is described in docs/ui.md."),
            issue(6, "docs: Update docs/guide.md and add an export button", None),
        ]
        pulls = [
            pull(21, "API guide work", None, draft=False, ref="docs/api-guide"),
            pull(22, "Draft guide work", "Closes #3", draft=True, ref="docs/draft-guide"),
        ]
        policy_route = (
            {"json": {"type": "file", "encoding": "base64",
                      "content": base64.b64encode(remote_policy.encode()).decode(), "sha": "b" * 40}}
            if remote_policy is not None
            else {"status": 404, "stderr": "gh: Not Found (HTTP 404)"}
        )
        routes = {
            "repos/owner/repo": {"json": {"id": 101, "full_name": "owner/repo", "default_branch": "main"}},
            "repos/owner/repo/git/ref/heads/main": {"json": {"ref": "refs/heads/main", "object": {"sha": SHA}}},
            f"repos/owner/repo/contents/.github/delivery.toml?ref={SHA}": policy_route,
            f"repos/owner/repo/contents?ref={SHA}": {"json": [{"name": "README.md", "path": "README.md", "type": "file"}]},
            "repos/owner/repo/issues?state=open&per_page=100": {"json": issues},
            "repos/owner/repo/pulls?state=open&per_page=100": {"json": pulls},
            "repos/owner/repo/pulls/21": {"json": pulls[0]},
            "repos/owner/repo/pulls/21/files?per_page=100": {"json": [{"filename": "docs/api.md", "status": "modified"}]},
            "repos/owner/repo/pulls/22": {"json": pulls[1]},
            "repos/owner/repo/pulls/22/files?per_page=100": {"json": [{"filename": "docs/draft.md", "status": "modified"}]},
        }
        for candidate in issues:
            number = candidate["number"]
            routes[f"repos/owner/repo/issues/{number}/dependencies/blocked_by?per_page=100"] = {"json": []}
            routes[f"repos/owner/repo/issues/{number}/timeline?per_page=100"] = {"json": []}
        return routes

    def invoke(self, routes: dict) -> subprocess.CompletedProcess[str]:
        self.fixture.write_text(json.dumps({"routes": routes}))
        env = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "HOME": str(self.home),
            "GH_CONFIG_DIR": str(self.home / "gh"),
            "FAKE_GH_FIXTURE": str(self.fixture),
            "FAKE_GH_LOG": str(self.log),
        }
        return subprocess.run(
            [sys.executable, str(DELIVERY), "run", "owner/repo", "--preview",
             "--provisional-policy", str(self.policy), "--documentation-only"],
            cwd=self.run_dir, env=env, text=True, capture_output=True,
        )

    def calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    @staticmethod
    def endpoints(calls: list[list[str]]) -> list[str]:
        return [next(arg for arg in call if arg.startswith("repos/")) for call in calls]

    def test_ranks_one_documentation_issue_and_reports_conservative_exclusions(self) -> None:
        completed = self.invoke(self.routes())
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "ranked")
        self.assertIsInstance(result["winner"], int)
        self.assertEqual(result["winner"], 1)
        self.assertEqual(result["policy"]["source"], "provisional")
        self.assertEqual(result["scope"], "documentation_only")
        self.assertEqual(result["unresolved"], [])

        excluded = {entry["number"]: entry for entry in result["exclusions"]}
        self.assertTrue({3, 4, 5, 6} <= set(excluded), excluded)
        self.assertEqual(excluded[6]["reason"], "non_documentation_intent")
        self.assertTrue(all(isinstance(entry["reason"], str) and entry["reason"].replace("_", "").isalnum()
                            for entry in excluded.values()))

        calls = self.calls()
        self.assertTrue(all("--method" not in call or call[call.index("--method") + 1] == "GET"
                            for call in calls))
        self.assertTrue(all("POST" not in call for call in calls))
        endpoints = self.endpoints(calls)
        self.assertEqual(endpoints.count("repos/owner/repo/git/ref/heads/main"), 2)
        self.assertIn(f"repos/owner/repo/contents?ref={SHA}", endpoints)
        self.assertIn("repos/owner/repo/pulls/21", endpoints)
        self.assertIn("repos/owner/repo/pulls/21/files?per_page=100", endpoints)
        self.assertIn("repos/owner/repo/issues/1/dependencies/blocked_by?per_page=100", endpoints)
        self.assertIn("repos/owner/repo/issues/1/timeline?per_page=100", endpoints)
        self.assertEqual(list(self.run_dir.iterdir()), [], "preview must not create claim or state files")

    def test_remote_policy_is_merged_with_the_explicit_provisional_policy(self) -> None:
        remote = POLICY.replace('excluded_labels = ["blocked"]', 'excluded_labels = ["blocked", "remote-hold"]')
        completed = self.invoke(self.routes(remote_policy=remote))
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "ranked")
        self.assertEqual(result["policy"]["source"], "merged")
        self.assertEqual(result["winner"], 1)

    def test_policy_filters_can_produce_no_candidate_without_failing_the_preview(self) -> None:
        routes = self.routes()
        routes["repos/owner/repo/issues?state=open&per_page=100"]["json"] = [
            issue(4, "Clarify blocked guide", "Update docs/blocked.md.", ["blocked"]),
            issue(5, "Fix code edge case", "The UI change is described in docs/ui.md."),
        ]
        completed = self.invoke(routes)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "no_candidate")
        self.assertIsNone(result["winner"])
        self.assertEqual({entry["number"] for entry in result["exclusions"]}, {4, 5})

    def test_incomplete_github_read_is_not_reported_as_no_candidate(self) -> None:
        routes = self.routes()
        routes["repos/owner/repo/issues/1/timeline?per_page=100"] = {
            "status": 500,
            "stderr": "gh: service unavailable (HTTP 500)",
        }
        completed = self.invoke(routes)
        self.assertEqual(completed.returncode, 2, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "coverage_incomplete")
        self.assertNotEqual(result["status"], "no_candidate")
        self.assertIn("scope", result)
        self.assertIsNone(result["winner"])
        self.assertEqual(list(self.run_dir.iterdir()), [], "failed reads must not create claim or state files")

    def test_truncated_pull_file_inventory_fails_closed(self) -> None:
        routes = self.routes()
        routes["repos/owner/repo/pulls/21"]["json"]["changed_files"] = 2
        completed = self.invoke(routes)
        self.assertEqual(completed.returncode, 2, completed.stderr + completed.stdout)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "coverage_incomplete")
        self.assertIsNone(result["winner"])
        self.assertIn("incomplete file list", result["error"])
        endpoints = self.endpoints(self.calls())
        self.assertIn("repos/owner/repo/pulls/21/files?per_page=100", endpoints)
        self.assertTrue(all("POST" not in call for call in self.calls()))

    def test_changed_pull_base_cannot_prove_path_coverage(self) -> None:
        routes = self.routes()
        endpoint = "repos/owner/repo/pulls/21"
        before = routes[endpoint]["json"]
        after = {**before, "base": {**before["base"], "sha": "c" * 40}}
        routes[endpoint] = [{"json": before}, {"json": after}]
        completed = self.invoke(routes)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("changed during file reads", json.loads(completed.stdout)["error"])

    def test_default_branch_switch_fails_closed(self) -> None:
        routes = self.routes()
        endpoint = "repos/owner/repo"
        before = routes[endpoint]["json"]
        routes[endpoint] = [{"json": before}, {"json": {**before, "default_branch": "new-main"}}]
        completed = self.invoke(routes)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("default branch changed", json.loads(completed.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
