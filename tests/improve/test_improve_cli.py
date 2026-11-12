"""Pinned draft-only Improve contract fixture.

The CLI consumes a version-1 batch bound to one immutable GitHub repository ID,
ref, and commit. Candidate records contain one independently testable behavior,
pinned source lines, acceptance checks, and screened search terms. The fixture
transport exposes only GitHub-style GET routes and records every HTTP method so
the suite proves the installed draft workflow has no mutation path.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


SOURCE_SKILL = Path(
    os.environ.get(
        "IMPROVE_TEST_INSTALLED_SKILL",
        Path(__file__).resolve().parents[2] / "skills" / "improve",
    )
)


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )


class RecordingGitHub:
    def __init__(
        self,
        sha: str,
        *,
        incomplete: bool = False,
        duplicate: bool = False,
        fixed: bool = False,
        paginated: bool = False,
        truncate_search: bool = False,
        large_patch: str | None = None,
    ):
        self.sha = sha
        self.incomplete = incomplete
        self.duplicate = duplicate
        self.fixed = fixed
        self.paginated = paginated
        self.truncate_search = truncate_search
        self.large_patch = large_patch
        self.requests: list[tuple[str, str]] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                owner.requests.append(("GET", self.path))
                parsed = urlparse(self.path)
                first_page = parsed.path == "/search/issues" and parse_qs(parsed.query).get("page") == ["1"]
                link = '<https://example.invalid/ignored>; rel="next"' if owner.paginated and first_page else None
                self._reply(owner.response(self.path), link=link)

            def do_POST(self) -> None:
                self._reject_write()

            def do_PATCH(self) -> None:
                self._reject_write()

            def do_PUT(self) -> None:
                self._reject_write()

            def do_DELETE(self) -> None:
                self._reject_write()

            def _reject_write(self) -> None:
                owner.requests.append((self.command, self.path))
                self._reply({"message": "writes disabled"}, 405)

            def _reply(self, value: object, status: int = 200, *, link: str | None = None) -> None:
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                if link:
                    self.send_header("Link", link)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "RecordingGitHub":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def response(self, raw_path: str) -> object:
        parsed = urlparse(raw_path)
        path = parsed.path.rstrip("/")
        query = parse_qs(parsed.query)
        if path == "/repos/acme/widget":
            return {
                "id": 4242,
                "full_name": "acme/widget",
                "visibility": "private",
                "default_branch": "main",
                "has_issues": True,
            }
        if path == "/repos/other/widget":
            return {
                "id": 9999,
                "full_name": "other/widget",
                "visibility": "private",
                "default_branch": "main",
            }
        if path in {f"/repos/acme/widget/commits/{self.sha}", "/repos/acme/widget/commits/main"}:
            return {"sha": self.sha}
        if path == "/repos/other/widget/commits/main":
            return {"sha": self.sha}
        if path == "/search/issues":
            if self.paginated:
                items = [self._pr_summary()] if query.get("page") == ["2"] else []
                return {"total_count": 1, "incomplete_results": False, "items": items}
            if self.truncate_search:
                return {"total_count": 1, "incomplete_results": False, "items": []}
            items = [self._pr_summary()] if self.duplicate else [self._fixed_issue()] if self.fixed else []
            return {"total_count": len(items), "incomplete_results": self.incomplete, "items": items}
        if path == "/repos/acme/widget/issues":
            return [self._pr_summary()] if self.duplicate else [self._fixed_issue()] if self.fixed else []
        if path == "/repos/acme/widget/pulls":
            return [self._pr_detail()] if self.duplicate else []
        if path == "/repos/acme/widget/issues/17":
            return self._pr_summary()
        if path == "/repos/acme/widget/pulls/17":
            return self._pr_detail()
        if path == "/repos/acme/widget/pulls/17/files":
            return [{"filename": "app.py", "status": "modified", "patch": self.large_patch or "@@ parser timeout"}]
        if path == "/repos/acme/widget/issues/18":
            return self._fixed_issue()
        raise AssertionError(f"unexpected GET {path} {query}")

    @staticmethod
    def _pr_summary() -> dict[str, object]:
        return {
            "number": 17,
            "title": "Prevent parser timeout on empty input",
            "body": "Fix parser timeout at empty input.",
            "state": "open",
            "draft": True,
            "html_url": "https://github.com/acme/widget/pull/17",
            "updated_at": "2026-11-09T00:00:00Z",
            "pull_request": {"url": "https://api.github.com/repos/acme/widget/pulls/17"},
        }

    @staticmethod
    def _pr_detail() -> dict[str, object]:
        return {
            "number": 17,
            "title": "Prevent parser timeout on empty input",
            "body": "Fix parser timeout at empty input.",
            "state": "open",
            "draft": True,
            "html_url": "https://github.com/acme/widget/pull/17",
            "updated_at": "2026-11-09T00:00:00Z",
            "head": {"sha": "1" * 40},
            "base": {"ref": "main"},
        }

    @staticmethod
    def _fixed_issue() -> dict[str, object]:
        return {
            "number": 18,
            "title": "Handle empty parser input",
            "body": "The behavior was fixed and verified at the audited revision.",
            "state": "closed",
            "html_url": "https://github.com/acme/widget/issues/18",
            "updated_at": "2026-11-09T00:00:00Z",
        }


class ImproveCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.checkout = self.root / "target"
        self.skill = self.root / "installed-skills" / "improve"
        self.checkout.mkdir()
        self.skill.parent.mkdir()
        self._git("init", "-b", "main")
        self._git("config", "user.email", "fixture@example.invalid")
        self._git("config", "user.name", "Fixture")
        self._git("remote", "add", "origin", "https://github.com/acme/widget.git")
        (self.checkout / "app.py").write_text("def parse(value):\n    return value.strip()\n")
        self._git("add", "app.py")
        self._git("commit", "-m", "fixture")
        self.sha = self._git("rev-parse", "HEAD").stdout.strip()
        (self.checkout / "app.py").write_text("DIRTY WORKTREE MUST NOT BE USED\n")
        shutil.copytree(SOURCE_SKILL, self.skill)
        self.reviewer = self.root / "reviewer.py"
        self.review_log = self.root / "review.jsonl"
        self._write_reviewer("clear")

    def _write_reviewer(self, mode: str) -> None:
        self.reviewer.write_text(
            f"""#!{sys.executable}
import json, sys
request = json.load(sys.stdin)
with open({str(self.review_log)!r}, 'a') as stream:
    stream.write(json.dumps(request, sort_keys=True) + '\\n')
mode = {mode!r}
phase = request['phase']
disposition = mode if mode in ('duplicate', 'fixed', 'covered') and phase == 'overlap' else mode if mode == 'defer' else 'clear'
if disposition == 'fixed' and not any('raise ValueError' in source['content'] for source in request['evidence']['pinned_sources']):
    disposition = 'clear'
sequence = request['evidence'].get('packet', {{}}) if phase == 'overlap' else {{}}
patches = [f.get('patch') or '' for record in request['evidence']['records'] for f in record.get('files', [])] if phase == 'overlap' else []
saw_early = 'Saw early marker in PR 17' in sequence.get('previous_summary', '') or any('EARLY MATCH' in patch for patch in patches)
if mode in ('late_duplicate', 'late_defer') and saw_early and any('LATE MATCH' in patch for patch in patches):
    disposition = 'duplicate' if mode == 'late_duplicate' else 'defer'
response_digest = '0' * 64 if mode == 'stale' else request['digest']
related = [17] if disposition == 'duplicate' else [18] if disposition in ('fixed', 'covered') else []
response = {{'digest': response_digest, 'disposition': disposition, 'related': related, 'reason': 'fixture decision'}}
if sequence and sequence['index'] < sequence['total'] and disposition == 'clear' and mode != 'missing_summary':
    response['continuation'] = 'Saw early marker in PR 17' if saw_early else 'No earlier matches.'
json.dump(response, sys.stdout)
"""
        )
        self.reviewer.chmod(self.reviewer.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        result = run("git", *args, cwd=self.checkout)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def _candidate(
        self,
        identity: str = "F1",
        *,
        terms: list[str] | None = None,
        impact: int = 2,
        effort: int = 1,
        behavior_suffix: str = "",
        proof_kind: str = "trace",
    ) -> dict[str, object]:
        return {
            "id": identity,
            "title": f"Handle empty parser input {behavior_suffix}".strip(),
            "behavior": {
                "actor": "CLI user",
                "trigger": f"submits empty input {behavior_suffix}".strip(),
                "boundary": "parse entry point",
                "expected": f"returns a validation error {behavior_suffix}".strip(),
            },
            "observed": "The parser accepts an empty value.",
            "scope": "Validate the parse entry point.",
            "non_goals": "Redesign parser output.",
            "proof": {"kind": proof_kind, "detail": "parse returns without validation"},
            "impact": impact,
            "effort": effort,
            "sources": [{"path": "app.py", "start": 1, "end": 2}],
            "acceptance": [{"action": "Parse empty input", "expected": "A validation error is returned"}],
            "terms": terms or [f"empty parser input {behavior_suffix}".strip(), "parse validation"],
        }

    def _manifest(
        self,
        *,
        repo: str = "acme/widget",
        terms: list[str] | None = None,
        candidates: list[dict[str, object]] | None = None,
        audit_complete: bool = True,
    ) -> Path:
        path = self.root / "input.json"
        path.write_text(json.dumps({
            "version": 1,
            "binding": {"repo": repo, "id": 4242, "visibility": "private", "ref": "main", "sha": self.sha},
            "scope": "parser correctness",
            "audit_complete": audit_complete,
            "candidates": candidates if candidates is not None else [self._candidate(terms=terms)],
        }))
        return path

    def _batch(
        self,
        server: RecordingGitHub,
        manifest: Path,
        *,
        mode: str = "clear",
        limit: int = 3,
    ) -> subprocess.CompletedProcess[str]:
        self._write_reviewer(mode)
        return run(
            sys.executable, str(self.skill / "scripts" / "improve.py"),
            "--fixture-url", server.url, "--reviewer", str(self.reviewer),
            "batch", "--checkout", str(self.checkout), "--input", str(manifest), "--limit", str(limit),
            cwd=self.root,
        )

    def test_clean_install_emits_one_draft_and_only_get_requests(self) -> None:
        with RecordingGitHub(self.sha) as server:
            result = self._batch(server, self._manifest())
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "drafts_ready")
        self.assertEqual([draft["id"] for draft in output["drafts"]], ["F1"])
        self.assertNotIn("DIRTY WORKTREE", output["drafts"][0]["body"])
        self.assertTrue(output["drafts"][0]["body"].endswith("Source: Improve\n"))
        draft_reviews = [
            packet for packet in map(json.loads, self.review_log.read_text().splitlines())
            if packet["phase"] == "draft"
        ]
        self.assertEqual(draft_reviews[0]["evidence"], {
            "title": output["drafts"][0]["title"],
            "body": output["drafts"][0]["body"],
        })
        self.assertTrue(server.requests)
        self.assertEqual({method for method, _path in server.requests}, {"GET"})

    def test_semantic_duplicate_draft_pr_suppresses_issue_draft(self) -> None:
        with RecordingGitHub(self.sha, duplicate=True) as server:
            result = self._batch(server, self._manifest(terms=["parser timeout", "empty input"]), mode="duplicate")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "no_qualifying_findings")
        self.assertEqual(output["drafts"], [])
        self.assertEqual(output["dispositions"][0]["status"], "duplicate")
        self.assertEqual(output["dispositions"][0]["related"], [17])
        self.assertEqual({method for method, _path in server.requests}, {"GET"})

    def test_incomplete_search_defers_candidate(self) -> None:
        with RecordingGitHub(self.sha, incomplete=True) as server:
            result = self._batch(server, self._manifest())
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "incomplete")
        self.assertEqual(output["drafts"], [])
        self.assertEqual(output["dispositions"][0]["status"], "deferred")
        self.assertEqual({method for method, _path in server.requests}, {"GET"})

    def test_audience_reviewer_defer_blocks_remote_search_and_draft(self) -> None:
        with RecordingGitHub(self.sha) as server:
            result = self._batch(server, self._manifest(terms=["private incident details"]), mode="defer")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "incomplete")
        self.assertEqual(output["drafts"], [])
        self.assertFalse(any(path.startswith("/search/issues") for _method, path in server.requests))
        reviews = [json.loads(line) for line in self.review_log.read_text().splitlines()]
        self.assertEqual([review["phase"] for review in reviews], ["search"])

    def test_wrong_repository_binding_fails_before_candidate_search(self) -> None:
        with RecordingGitHub(self.sha) as server:
            result = self._batch(server, self._manifest(repo="other/widget"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(path.startswith("/search/issues") for _method, path in server.requests))
        self.assertEqual({method for method, _path in server.requests}, {"GET"})

    def test_ranking_batch_deduplication_and_draft_cap_are_deterministic(self) -> None:
        strongest = self._candidate("F2", impact=3, effort=1, behavior_suffix="high")
        duplicate = {**strongest, "id": "F3", "title": "Same outcome with another title"}
        candidates = [
            self._candidate("F1", impact=2, effort=2, behavior_suffix="low"),
            strongest,
            duplicate,
            self._candidate("F4", impact=2, effort=1, behavior_suffix="medium"),
        ]
        with RecordingGitHub(self.sha) as server:
            result = self._batch(server, self._manifest(candidates=candidates), limit=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual([draft["id"] for draft in output["drafts"]], ["F2", "F4"])
        statuses = {item["id"]: item["status"] for item in output["dispositions"]}
        self.assertEqual(statuses, {"F1": "over_cap", "F2": "drafted", "F3": "duplicate", "F4": "drafted"})
        self.assertEqual({method for method, _path in server.requests}, {"GET"})

    def test_malformed_sensitive_candidate_never_reaches_outbound_query(self) -> None:
        sentinel = "customer@example.invalid"
        manifest = self._manifest(terms=[sentinel, "parser incident"])
        with RecordingGitHub(self.sha) as server:
            result = self._batch(server, manifest)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "incomplete")
        self.assertEqual(output["dispositions"][0]["reason"], "invalid_or_unsafe_input")
        self.assertFalse(any(sentinel in path for _method, path in server.requests))
        self.assertFalse(any(path.startswith("/search/issues") for _method, path in server.requests))

    def test_empty_completed_audit_differs_from_incomplete_audit(self) -> None:
        with RecordingGitHub(self.sha) as server:
            completed = self._batch(server, self._manifest(candidates=[]))
        with RecordingGitHub(self.sha) as server:
            incomplete = self._batch(server, self._manifest(candidates=[], audit_complete=False))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(incomplete.returncode, 0, incomplete.stderr)
        self.assertEqual(json.loads(completed.stdout)["status"], "no_qualifying_findings")
        self.assertEqual(json.loads(incomplete.stdout)["status"], "incomplete")

    def test_stale_reviewer_digest_defers_before_search(self) -> None:
        with RecordingGitHub(self.sha) as server:
            result = self._batch(server, self._manifest(), mode="stale")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "incomplete")
        self.assertEqual(output["dispositions"][0]["reason"], "review_unavailable_or_invalid")
        self.assertFalse(any(path.startswith("/search/issues") for _method, path in server.requests))

    def test_closed_fixed_issue_suppresses_a_new_draft_after_review(self) -> None:
        (self.checkout / "app.py").write_text(
            "def parse(value):\n    if not value: raise ValueError('empty input')\n    return value.strip()\n"
        )
        self._git("add", "app.py")
        self._git("commit", "-m", "Fix empty input")
        self.sha = self._git("rev-parse", "HEAD").stdout.strip()
        with RecordingGitHub(self.sha, fixed=True) as server:
            result = self._batch(server, self._manifest(), mode="fixed")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "no_qualifying_findings")
        self.assertEqual(output["drafts"], [])
        self.assertEqual(output["dispositions"][0]["status"], "fixed")
        self.assertEqual(output["dispositions"][0]["related"], [18])
        self.assertEqual({method for method, _path in server.requests}, {"GET"})


    def test_closed_issue_without_fix_in_pinned_code_does_not_suppress_draft(self) -> None:
        with RecordingGitHub(self.sha, fixed=True) as server:
            result = self._batch(server, self._manifest(), mode="fixed")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "drafts_ready")
        self.assertEqual({method for method, _path in server.requests}, {"GET"})


    def test_later_search_page_can_suppress_a_draft(self) -> None:
        with RecordingGitHub(self.sha, paginated=True) as server:
            result = self._batch(server, self._manifest(), mode="duplicate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["dispositions"][0]["status"], "duplicate")
        self.assertTrue(any("page=2" in path for _method, path in server.requests))
        self.assertEqual({method for method, _path in server.requests}, {"GET"})

    def test_truncated_search_fails_closed_even_without_link(self) -> None:
        with RecordingGitHub(self.sha, truncate_search=True) as server:
            result = self._batch(server, self._manifest())
        self.assertEqual(result.returncode, 0, result.stderr)
        outcome = json.loads(result.stdout)["dispositions"][0]
        self.assertEqual(outcome["reason"], "search_incomplete")
        self.assertIn("truncated", outcome["coverage_note"])
        self.assertEqual({method for method, _path in server.requests}, {"GET"})


    def test_large_overlap_requires_every_packet_before_drafting(self) -> None:
        patch = "@@ source fragment EARLY MATCH\n" + ("\U0001f4c4" * 10000) + "LATE MATCH"
        for mode, expected in (("clear", "drafted"), ("late_duplicate", "duplicate"),
                               ("late_defer", "deferred")):
            with self.subTest(mode=mode), RecordingGitHub(
                self.sha, duplicate=True, large_patch=patch
            ) as server:
                self.review_log.write_text("")
                result = self._batch(server, self._manifest(), mode=mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = json.loads(result.stdout)
                self.assertEqual(output["dispositions"][0]["status"], expected)
                requests = [json.loads(line) for line in self.review_log.read_text().splitlines()]
                overlap = [packet for packet in requests if packet["phase"] == "overlap"]
                self.assertGreater(len(overlap), 1)
                self.assertTrue(all(len(json.dumps(packet)) <= 96 * 1024 for packet in overlap))
                metadata = [packet["evidence"]["packet"] for packet in overlap]
                self.assertEqual([item["index"] for item in metadata], list(range(1, len(overlap) + 1)))
                self.assertEqual({item["total"] for item in metadata}, {len(overlap)})
                self.assertEqual(len({item["snapshot"] for item in metadata}), 1)
                self.assertEqual(metadata[-1]["previous_summary"], "Saw early marker in PR 17")
                fragments = [f for packet in overlap for record in packet["evidence"]["records"]
                             for f in record.get("files", [])]
                self.assertEqual("".join(f["patch"] for f in fragments), patch)
                self.assertEqual(requests[-1]["phase"], "draft" if expected == "drafted" else "overlap")
                self.assertEqual({method for method, _path in server.requests}, {"GET"})


    def test_missing_overlap_continuation_defers_before_drafting(self) -> None:
        with RecordingGitHub(self.sha, duplicate=True, large_patch="\U0001f4c4" * 10000) as server:
            result = self._batch(server, self._manifest(), mode="missing_summary")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["dispositions"][0]["reason"],
                         "overlap_continuation_missing")
        self.assertEqual({method for method, _path in server.requests}, {"GET"})


if __name__ == "__main__":
    unittest.main()
