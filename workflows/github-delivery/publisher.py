#!/usr/bin/env python3
"""Separately credentialed, deterministic GitHub publisher.

This process accepts only write intents already persisted by delivery.py.  It
uses argv-based `gh`/`git` calls (never a shell) and reads every result back.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse
from typing import Any

import delivery


class GitHubTransport:
    def __init__(self, *, allowed_worktree_root: Path, env: dict[str, str] | None = None,
                 runner=subprocess.run):
        self.allowed_root = allowed_worktree_root.resolve()
        self.env = dict(env or os.environ)
        self.runner = runner
        delivery.require(self.env.get("DELIVERY_PUBLISHER_ISOLATED") == "1",
                         "publisher isolation marker missing")
        delivery.require(bool(self.env.get("GH_TOKEN") or self.env.get("GITHUB_TOKEN")),
                         "publisher GitHub token missing")

    @staticmethod
    def split_repo(repo: str) -> tuple[str, str, str]:
        delivery.validate_repo(repo)
        parts = repo.split("/")
        return (parts[0], parts[1], parts[2]) if len(parts) == 3 else ("github.com", parts[0], parts[1])

    @staticmethod
    def remote_identity(url: str) -> tuple[str, str, str]:
        if url.startswith("git@") and ":" in url:
            host, path = url[4:].split(":", 1)
        else:
            parsed = urlparse(url); host = parsed.hostname or ""; path = parsed.path.lstrip("/")
        parts = path.removesuffix(".git").split("/")
        delivery.require(bool(host) and len(parts) == 2, "unsupported git remote URL")
        return host.lower(), parts[0], parts[1]

    def _run(self, argv: list[str], *, input_value: dict[str, Any] | None = None) -> Any:
        completed = self.runner(argv, input=(json.dumps(input_value) if input_value is not None else None),
            text=True, capture_output=True, env=self.env, check=False)
        if completed.returncode:
            raise delivery.DeliveryError(f"publisher command failed ({argv[0]}): {completed.stderr.strip()}")
        if not completed.stdout.strip():
            return {}
        try: return json.loads(completed.stdout)
        except json.JSONDecodeError as exc: raise delivery.DeliveryError("publisher returned non-JSON") from exc

    def api(self, method: str, repo: str, endpoint: str, body: dict[str, Any] | None = None) -> Any:
        host, owner, name = self.split_repo(repo)
        path = endpoint.format(owner=owner, repo=name)
        return self._run(["gh", "api", "--hostname", host, "--method", method, path, "--input", "-"],
                         input_value=body or {})

    def find_prs(self, expected: dict[str, Any]) -> list[dict[str, Any]]:
        host, owner, _ = self.split_repo(expected["repo"])
        values = self.api("GET", expected["repo"],
            "/repos/{owner}/{repo}/pulls?state=open&head=" + owner + ":" + expected["head"] +
            "&per_page=100")
        matches = []
        wrong_identity = []
        for pr in values:
            body = pr.get("body") or ""
            if (pr.get("head", {}).get("sha") == expected["head_sha"]
                    and pr.get("base", {}).get("ref") == expected["base"]
                    and pr.get("base", {}).get("sha") == expected["base_sha"]
                    and f"delivery-id: {expected['delivery_id']}" in body
                    and (expected.get("plan_revision") is None
                         or f"plan-revision: {expected['plan_revision']}" in body)):
                matches.append(self._normalize(pr, expected["repo"]))
            else:
                wrong_identity.append(pr.get("number"))
        delivery.require(not wrong_identity,
                         f"head branch already has wrong-ref/provenance PRs: {wrong_identity}")
        return matches

    def apply(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        if kind == "push":
            worktree = Path(payload["worktree"]).resolve()
            delivery.require(worktree == self.allowed_root or self.allowed_root in worktree.parents,
                             "push worktree escapes allowlisted root")
            delivery.validate_ref(payload["head"])
            actual = subprocess.run(["git", "-C", str(worktree), "remote", "get-url", payload["remote"]],
                text=True, capture_output=True, check=False)
            delivery.require(actual.returncode == 0 and actual.stdout.strip() == payload["remote_url"],
                             "push remote identity mismatch")
            delivery.require(self.remote_identity(payload["remote_url"]) == self.split_repo(payload["repo"]),
                             "push remote does not match target repository")
            pushed = subprocess.run(["git", "-C", str(worktree), "push", "--porcelain", payload["remote"],
                f"{payload['sha']}:refs/heads/{payload['head']}"], text=True, capture_output=True, check=False,
                env=self.env)
            delivery.require(pushed.returncode == 0, f"push failed: {pushed.stderr.strip()}")
            return {"repo": payload["repo"], "head": payload["head"], "sha": payload["sha"]}
        if kind == "create_pr":
            pr = self.api("POST", payload["repo"], "/repos/{owner}/{repo}/pulls", {
                "title": payload["title"], "body": payload["body"], "head": payload["head"],
                "base": payload["base"], "draft": True})
            return self._normalize(pr, payload["repo"])
        if kind == "edit_pr":
            pr = self.api("PATCH", payload["repo"], f"/repos/{{owner}}/{{repo}}/pulls/{payload['number']}",
                          {key: payload[key] for key in ("title", "body", "base") if key in payload})
            return self._normalize(pr, payload["repo"])
        if kind == "mark_ready":
            current = self.api("GET", payload["repo"], f"/repos/{{owner}}/{{repo}}/pulls/{payload['number']}")
            delivery.require(current.get("head", {}).get("sha") == payload["head_sha"], "PR head moved")
            delivery.require(current.get("base", {}).get("ref") == payload["base"], "PR base moved")
            result = self._run(["gh", "api", "graphql", "--input", "-"], input_value={"query":
                "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}",
                "variables": {"id": current["node_id"]}})
            delivery.require(result["data"]["markPullRequestReadyForReview"]["pullRequest"]["isDraft"] is False,
                             "PR was not marked ready")
            return self._normalize(self.api("GET", payload["repo"],
                f"/repos/{{owner}}/{{repo}}/pulls/{payload['number']}"), payload["repo"])
        if kind == "track_issue":
            labels = self.api("GET", payload["repo"], "/repos/{owner}/{repo}/labels?per_page=100")
            delivery.require(payload["label"] in {item["name"] for item in labels}, "label does not exist")
            issue = self.api("GET", payload["repo"], f"/repos/{{owner}}/{{repo}}/issues/{payload['issue']}")
            names = sorted({item["name"] for item in issue.get("labels", [])} | {payload["label"]})
            self.api("PATCH", payload["repo"], f"/repos/{{owner}}/{{repo}}/issues/{payload['issue']}",
                     {"labels": names})
            readback = self.api("GET", payload["repo"], f"/repos/{{owner}}/{{repo}}/issues/{payload['issue']}")
            delivery.require(payload["label"] in {item["name"] for item in readback.get("labels", [])},
                             "issue label readback failed")
            return {"issue": payload["issue"], "labels": names}
        raise delivery.DeliveryError(f"unsupported write kind: {kind}")

    def get_pr(self, repo: str, number: int) -> dict[str, Any]:
        return self._normalize(self.api("GET", repo, f"/repos/{{owner}}/{{repo}}/pulls/{number}"), repo)

    def list_reviews(self, repo: str, number: int) -> list[dict[str, Any]]:
        host, owner, name = self.split_repo(repo)
        completed = self.runner(["gh", "api", "--hostname", host, "--paginate", "--slurp",
            f"/repos/{owner}/{name}/pulls/{number}/reviews?per_page=100"], text=True,
            capture_output=True, env=self.env, check=False)
        if completed.returncode:
            raise delivery.DeliveryError(f"review pagination failed: {completed.stderr.strip()}")
        pages = json.loads(completed.stdout); return [item for page in pages for item in page]

    @staticmethod
    def _normalize(pr: dict[str, Any], repo: str) -> dict[str, Any]:
        return {"number": pr["number"], "repo": repo, "head": pr["head"]["ref"],
                "head_sha": pr["head"]["sha"], "base": pr["base"]["ref"],
                "base_sha": pr["base"]["sha"],
                "draft": pr["draft"], "body": pr.get("body") or "", "state": pr["state"].upper()}


def main() -> int:
    print(json.dumps({"status": "blocked", "error":
        "bundled live publisher is intentionally disabled: provide an audited launcher using a trusted separate clone/config"},
        sort_keys=True))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
