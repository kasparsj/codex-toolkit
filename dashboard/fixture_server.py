#!/usr/bin/env python3
"""Loopback-only synthetic dashboard fixture. Never reads production auth or state."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile

from dashboard import server

REPO = "fixture/private-repo"
HEAD = "b" * 40
BASE = "a" * 40
BODY = "fixture runner-owned pull request body"
PLAN = b"# Pinned fixture plan\n\n- Review the immutable commit.\n- Submit a Comment review.\n"
APPROVE = "delivery-review plan 2 " + "c" * 64 + " approve"
REJECT = "delivery-review plan 2 " + "c" * 64 + " reject"


def values(mode: str) -> tuple[dict, dict]:
    now = datetime.now(timezone.utc)
    receipt = None
    status, runner, step, claim = "plan_review", "paused", "plan-review", "active"
    live_head = HEAD
    if mode == "stale":
        live_head = "d" * 40
    if mode == "advanced":
        status, runner, step, claim = "implementation_review", "paused", "implementation-review", "active"
        receipt = {"approved": True, "approvers": [101], "rejectors": [], "minimum": 1,
                   "review_ids": {"101": 44}, "commit_id": HEAD, "context_digest": "c" * 64,
                   "checked_at": now.isoformat()}
    snapshot = {
        "projection_version": 1, "generated_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=1)).isoformat(),
        "binding": {"repo": REPO, "repository_id": 55, "delivery_id": "fixture-run"},
        "delivery": {"issue": 8, "status": status, "attempt": 2, "runner_status": runner,
                     "current_step_id": step, "claim_status": claim},
        "plan": {"generation": 2, "published_at": now.isoformat(),
                 "pr": {"repo": REPO, "number": 7, "node_id": "PR_fixture", "head": "codex/issue-8",
                        "head_sha": HEAD, "base": "main", "base_sha": BASE, "draft": True, "state": "OPEN",
                        "author_id": 900, "author_type": "Bot", "author_login": "fixture[bot]",
                        "head_repo_id": 55, "base_repo_id": 55,
                        "performed_via_github_app": {"id": 91, "slug": "fixture"},
                        "body_digest": hashlib.sha256(BODY.encode()).hexdigest()},
                 "artifacts": [{"path": "docs/plan.md", "sha256": hashlib.sha256(PLAN).hexdigest()}],
                 "review": {"stage": "plan", "generation": 2, "context_digest": "c" * 64, "minimum": 1,
                            "reviewer_ids": [101], "submit_as": "COMMENT", "approve": APPROVE, "reject": REJECT,
                            "approval_body_digest": hashlib.sha256(APPROVE.encode()).hexdigest()},
                 "receipt": receipt},
        "implementation": ({"number": 7, "head_sha": "e" * 40} if mode == "advanced" else None),
        "policy": {"publisher_id": 900, "app_id": 91, "app_slug": "fixture"},
    }
    github = {
        "/user": {"id": 101, "login": "fixture-reviewer", "type": "User"},
        f"/repos/{REPO}": {"id": 55},
        f"/repos/{REPO}/pulls/7": ({"number": 7, "node_id": "PR_fixture", "draft": True, "state": "open",
            "body": BODY, "user": {"id": 900, "type": "Bot", "login": "fixture[bot]"},
            "head": {"ref": "codex/issue-8", "sha": live_head, "repo": {"id": 55}},
            "base": {"ref": "main", "sha": BASE, "repo": {"id": 55}},
            "performed_via_github_app": {"id": 91, "slug": "fixture"}}
            if mode != "unavailable" else server.GitHubUnavailable("synthetic outage")),
        f"/repos/{REPO}/issues/8": {"title": "Add bounded retry handling"},
        f"/repos/{REPO}/contents/docs/plan.md?ref={HEAD}": {"type": "file", "name": "plan.md",
            "path": "docs/plan.md", "encoding": "base64", "content": base64.b64encode(PLAN).decode()},
    }
    if receipt:
        github[f"/repos/{REPO}/pulls/7/reviews/44"] = {"id": 44, "user": {"id": 101, "login": "fixture-reviewer", "type": "User"},
            "commit_id": HEAD, "state": "COMMENTED", "body": APPROVE, "submitted_at": now.isoformat(),
            "html_url": "https://github.com/fixture/private-repo/pull/7#pullrequestreview-44"}
    return snapshot, github


class FixtureGitHub:
    data = {}
    def __init__(self, token): self.token = token
    def get(self, path):
        value = self.data.get(path)
        if isinstance(value, Exception): raise value
        if value is None: raise server.GitHubUnavailable("missing synthetic response")
        return value


class FixtureHandler(server.DashboardHandler):
    def _token(self): return "synthetic-fixture-token"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--mode", choices=("actionable", "stale", "unavailable", "advanced"), default="actionable")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="codex-toolkit-dashboard-fixture-"))
    projection, FixtureGitHub.data = values(args.mode)
    snapshot_path = root / "projection.json"
    snapshot_path.write_text(json.dumps(projection)); os.chmod(snapshot_path, 0o600)
    config = server.Config(bind="127.0.0.1", port=args.port, origin=f"http://127.0.0.1:{args.port}",
                           client_id="synthetic", client_secret_file=None, snapshot=snapshot_path,
                           invalidations=root / "invalidations.json", repo=REPO, delivery_id="fixture-run",
                           fixture=True)
    app = server.Application(config, github_factory=FixtureGitHub)
    httpd = ThreadingHTTPServer((config.bind, config.port), FixtureHandler); httpd.app = app
    print(f"fixture={args.mode} url=http://127.0.0.1:{args.port}/items/fixture-run", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
