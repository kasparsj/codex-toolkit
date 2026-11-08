#!/usr/bin/env python3
"""Credentialed GitHub publisher using a trusted, worktree-free Git boundary."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib
from typing import Any
from urllib.parse import quote, urlencode

import delivery
from trusted_git import TrustedGit


POLICY_PATH = ".github/delivery.toml"


def canonical_repo(value: str) -> str:
    parts = value.lower().split("/")
    if len(parts) == 2:
        parts.insert(0, "github.com")
    delivery.require(
        len(parts) == 3 and parts[0] == "github.com" and all(parts[1:]),
        "publisher repository must be github.com/owner/repo",
    )
    delivery.validate_repo("/".join(parts))
    return "/".join(parts)


def repo_parts(repo: str) -> tuple[str, str, str]:
    host, owner, name = canonical_repo(repo).split("/")
    return host, owner, name


def policy_branch(ref: str) -> str:
    for prefix in ("refs/remotes/origin/", "refs/heads/"):
        if ref.startswith(prefix):
            branch = ref.removeprefix(prefix)
            delivery.validate_ref(branch)
            return branch
    raise delivery.DeliveryError("policy ref must be a remote or local branch ref")


class GitHubClient:
    def __init__(self, env: dict[str, str] | None = None, runner=subprocess.run):
        self.env = dict(env or os.environ)
        self.runner = runner

    def _run(self, argv: list[str], *, payload: dict[str, Any] | None = None) -> Any:
        completed = self.runner(
            argv,
            input=json.dumps(payload) if payload is not None else None,
            text=True,
            capture_output=True,
            env=self.env,
            check=False,
        )
        if completed.returncode:
            detail = completed.stderr.strip() or "no diagnostic"
            raise delivery.DeliveryError(f"GitHub request failed: {detail}")
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise delivery.DeliveryError("GitHub returned invalid JSON") from exc

    def api(self, method: str, repo: str, endpoint: str,
            payload: dict[str, Any] | None = None) -> Any:
        host, owner, name = repo_parts(repo)
        path = endpoint.format(owner=owner, repo=name)
        argv = ["gh", "api", "--hostname", host, "--method", method, path]
        if payload is not None:
            argv += ["--input", "-"]
        return self._run(argv, payload=payload)

    def paginated(self, repo: str, endpoint: str) -> list[dict[str, Any]]:
        host, owner, name = repo_parts(repo)
        path = endpoint.format(owner=owner, repo=name)
        pages = self._run(["gh", "api", "--hostname", host, "--paginate", "--slurp", path])
        delivery.require(isinstance(pages, list), "paginated GitHub response must be a list")
        return [item for page in pages for item in page]

    def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        return self._run(
            ["gh", "api", "--hostname", "github.com", "graphql", "--input", "-"],
            payload={"query": query, "variables": variables},
        )


class Publisher:
    def __init__(self, *, repo: str, root: Path, client: GitHubClient,
                 git_factory=TrustedGit):
        self.repo = canonical_repo(repo)
        delivery.require(not root.is_symlink(), "trusted publisher root is invalid")
        self.root = root.resolve()
        delivery.require(
            self.root.is_dir(),
            "trusted publisher root is invalid",
        )
        stat = self.root.stat()
        delivery.require(
            stat.st_uid == os.geteuid() and stat.st_mode & 0o022 == 0,
            "trusted publisher root must be owner-controlled",
        )
        self.client = client
        self.git_factory = git_factory
        self.issue_digest: str | None = None
        _, owner, name = repo_parts(self.repo)
        self.canonical_url = f"https://github.com/{owner}/{name}.git"

    def execute(self, packet: dict[str, Any]) -> dict[str, Any]:
        delivery.require(packet.get("schema_version") == 1, "invalid publisher packet schema")
        delivery.require(
            canonical_repo(packet.get("target_repo", "")) == self.repo,
            "packet repository mismatch",
        )
        action = packet.get("action")
        delivery.require(
            action in {"publish_plan", "publish_implementation", "list_reviews", "finalize"},
            "unsupported publisher action",
        )
        self._verify_policy(packet)
        if action == "list_reviews":
            return self._list_reviews(packet)
        self._verify_actor(packet)
        issue = self._verify_issue(packet)
        self.issue_digest = hashlib.sha256(
            delivery.canonical_json({"title": issue.get("title", ""), "body": issue.get("body", "")})
        ).hexdigest()
        if action in {"publish_plan", "publish_implementation"}:
            return self._publish(packet)
        return self._finalize(packet)

    def _verify_actor(self, packet: dict[str, Any]) -> None:
        user = self.client.api("GET", self.repo, "/user")
        expected = packet["policy_values"]["delivery"]["publisher_id"]
        delivery.require(user.get("id") == expected, "authenticated actor is not the policy publisher")

    def _verify_policy(self, packet: dict[str, Any]) -> None:
        policy = packet.get("policy", {})
        source_sha = policy.get("sha")
        digest = policy.get("digest")
        delivery.require(
            isinstance(source_sha, str) and delivery.FULL_SHA.fullmatch(source_sha),
            "invalid policy SHA",
        )
        delivery.require(
            isinstance(digest, str)
            and len(digest) == 64
            and all(character in "0123456789abcdef" for character in digest),
            "invalid policy digest",
        )
        branch = policy_branch(policy.get("ref", ""))
        ref = self.client.api(
            "GET", self.repo,
            f"/repos/{{owner}}/{{repo}}/git/ref/heads/{quote(branch, safe='/')}",
        )
        delivery.require(ref.get("object", {}).get("sha") == source_sha, "trusted policy ref moved")
        content = self.client.api(
            "GET",
            self.repo,
            f"/repos/{{owner}}/{{repo}}/contents/{POLICY_PATH}?{urlencode({'ref': source_sha})}",
        )
        delivery.require(content.get("encoding") == "base64", "policy encoding is unsupported")
        try:
            encoded = "".join(content["content"].split())
            raw = base64.b64decode(encoded, validate=True)
        except (KeyError, ValueError) as exc:
            raise delivery.DeliveryError("policy content is invalid") from exc
        delivery.require(hashlib.sha256(raw).hexdigest() == digest, "live policy digest mismatch")
        try:
            parsed = tomllib.loads(raw.decode())
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
            raise delivery.DeliveryError("live policy is not valid TOML") from exc
        supplied = packet.get("policy_values", {})
        delivery.require(
            all(supplied.get(key) == value for key, value in parsed.items()),
            "packet policy values do not match the trusted policy",
        )

    def _verify_issue(self, packet: dict[str, Any]) -> dict[str, Any]:
        issue_number = packet.get("issue") or packet.get("expected", {}).get("issue")
        delivery.require(isinstance(issue_number, int) and issue_number > 0, "publisher issue is invalid")
        issue = self.client.api(
            "GET", self.repo, f"/repos/{{owner}}/{{repo}}/issues/{issue_number}",
        )
        delivery.require(
            issue.get("state") == "open" and "pull_request" not in issue,
            "source issue is not open",
        )
        labels = {item.get("name") for item in issue.get("labels", [])}
        eligibility = packet["policy_values"].get("eligibility", {})
        delivery.require(
            set(eligibility.get("required_labels", [])) <= labels,
            "source issue lost required eligibility labels",
        )
        delivery.require(
            not labels.intersection(eligibility.get("excluded_labels", [])),
            "source issue has an excluded label",
        )
        return issue

    def _base_tip(self, expected: dict[str, Any]) -> str:
        branch = expected["base"]
        delivery.validate_ref(branch)
        ref = self.client.api(
            "GET", self.repo,
            f"/repos/{{owner}}/{{repo}}/git/ref/heads/{quote(branch, safe='/')}",
        )
        sha = ref.get("object", {}).get("sha")
        delivery.require(sha == expected["base_sha"], "publication base moved")
        return sha

    def _normalize_pr(self, value: dict[str, Any]) -> dict[str, Any]:
        _, owner, name = repo_parts(self.repo)
        expected_repo = f"{owner}/{name}"
        delivery.require(
            value.get("head", {}).get("repo", {}).get("full_name", "").lower() == expected_repo
            and value.get("base", {}).get("repo", {}).get("full_name", "").lower() == expected_repo,
            "pull request repository identity mismatch",
        )
        return {
            "number": value["number"],
            "repo": self.repo,
            "node_id": value["node_id"],
            "head": value["head"]["ref"],
            "head_sha": value["head"]["sha"],
            "base": value["base"]["ref"],
            "base_sha": value["base"]["sha"],
            "draft": value["draft"],
            "body": value.get("body") or "",
            "state": value["state"].upper(),
        }

    def _get_pr(self, number: int) -> dict[str, Any]:
        value = self.client.api(
            "GET", self.repo, f"/repos/{{owner}}/{{repo}}/pulls/{number}",
        )
        return self._normalize_pr(value)

    def _reviews(self, number: int) -> list[dict[str, Any]]:
        return self.client.paginated(
            self.repo,
            f"/repos/{{owner}}/{{repo}}/pulls/{number}/reviews?per_page=100",
        )

    def _approval(self, packet: dict[str, Any], key: str = "approval") -> None:
        evidence = packet.get(key)
        stage = "plan" if key == "plan_approval" else "implementation"
        configured = packet["policy_values"]["approvals"][stage]
        if evidence is None and configured["minimum"] == 0:
            return
        delivery.require(isinstance(evidence, dict), "review evidence must be an object")
        delivery.require(evidence.get("stage") == stage, "review evidence stage mismatch")
        delivery.require(
            evidence.get("minimum", -1) >= configured["minimum"],
            "review evidence weakens the policy minimum",
        )
        delivery.require(
            evidence.get("reviewer_ids") == configured["reviewer_ids"],
            "review evidence allowlist differs from policy",
        )
        expected_pr = evidence["pr"]
        pr = self._get_pr(expected_pr["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            if key == "plan_approval" and field == "head_sha":
                implementation = packet.get("expected", packet.get("pr", {}))
                allowed = {expected_pr["head_sha"], implementation.get("head_sha")}
                supersedes = packet.get("supersedes_pr")
                if (
                    isinstance(supersedes, dict)
                    and supersedes.get("number") == expected_pr.get("number")
                    and supersedes.get("repo") == expected_pr.get("repo")
                    and supersedes.get("head") == expected_pr.get("head")
                    and supersedes.get("base") == expected_pr.get("base")
                    and supersedes.get("base_sha") == expected_pr.get("base_sha")
                ):
                    allowed.add(supersedes.get("head_sha"))
                delivery.require(pr[field] in allowed, "reviewed PR head changed unexpectedly")
            else:
                delivery.require(pr[field] == expected_pr[field], f"reviewed PR {field} changed")
        delivery.require(pr["state"] == "OPEN", "reviewed PR is not open")
        verdict = delivery.evaluate_reviews(
            self._reviews(pr["number"]),
            stage=evidence["stage"],
            generation=evidence["generation"],
            context_digest=evidence["context_digest"],
            commit_id=expected_pr["head_sha"],
            authorized_ids=evidence["reviewer_ids"],
            publisher_id=packet["policy_values"]["delivery"]["publisher_id"],
            minimum=evidence["minimum"],
        )
        delivery.require(verdict["approved"], f"{evidence['stage']} approval is not current")

    def _pr_body(self, packet: dict[str, Any]) -> str:
        expected = packet["expected"]
        delivery.require(self.issue_digest is not None, "issue scope was not verified")
        _, owner, name = repo_parts(self.repo)
        return "\n".join(
            [
                f"Issue: https://github.com/{owner}/{name}/issues/{expected['issue']}",
                f"delivery-id: {packet['delivery_id']}",
                f"plan-revision: {expected.get('plan_revision') or expected['head_sha']}",
                f"manifest-digest: {expected['manifest_digest']}",
                f"issue-digest: {self.issue_digest}",
                f"final-target: {packet['policy_values']['delivery']['final_target']}",
                "",
            ]
        )

    def _all_head_prs(self, branch: str) -> list[dict[str, Any]]:
        _, owner, _ = repo_parts(self.repo)
        query = urlencode({"state": "all", "head": f"{owner}:{branch}", "per_page": 100})
        return [
            self._normalize_pr(value)
            for value in self.client.paginated(
                self.repo, f"/repos/{{owner}}/{{repo}}/pulls?{query}",
            )
        ]

    def _match_pr(self, packet: dict[str, Any]) -> dict[str, Any] | None:
        expected = packet["expected"]
        final_target = packet["policy_values"]["delivery"]["final_target"]
        exact = []
        conflicts = []
        for pr in self._all_head_prs(expected["head"]):
            body = pr["body"]
            matches = (
                pr["head_sha"] == expected["head_sha"]
                and pr["base"] == expected["base"]
                and f"delivery-id: {packet['delivery_id']}" in body
                and f"plan-revision: {expected['plan_revision']}" in body
                and f"manifest-digest: {expected['manifest_digest']}" in body
                and f"issue-digest: {self.issue_digest}" in body
                and f"final-target: {final_target}" in body
            )
            if matches:
                exact.append(pr)
                continue
            prior = packet.get("prior_pr")
            is_convertible_prior = (
                packet["action"] == "publish_implementation"
                and prior
                and prior.get("number") == pr["number"]
                and prior.get("head") == expected["head"]
                and f"delivery-id: {packet['delivery_id']}" in body
                and f"plan-revision: {expected['plan_revision']}" in body
                and f"issue-digest: {self.issue_digest}" in body
            )
            if is_convertible_prior:
                continue
            supersedes = packet.get("supersedes_pr")
            is_superseded_prior = (
                isinstance(supersedes, dict)
                and supersedes.get("number") == pr["number"]
                and supersedes.get("repo") == pr["repo"]
                and supersedes.get("head") == pr["head"]
                and supersedes.get("base") == pr["base"]
                and supersedes.get("base_sha") == pr["base_sha"]
                and supersedes.get("body") == body
                and pr["head_sha"] in {supersedes.get("head_sha"), expected["head_sha"]}
            )
            if is_superseded_prior:
                continue
            conflicts.append(pr)
        delivery.require(not conflicts, "head branch has a conflicting PR or provenance")
        delivery.require(len(exact) <= 1, "multiple exact PRs match the delivery")
        return exact[0] if exact else None

    def _verify_pr_provenance(self, packet: dict[str, Any], pr: dict[str, Any]) -> None:
        expected = packet["expected"]
        _, owner, name = repo_parts(self.repo)
        markers = (
            f"Issue: https://github.com/{owner}/{name}/issues/{expected['issue']}",
            f"delivery-id: {packet['delivery_id']}",
            f"plan-revision: {expected['plan_revision']}",
            f"manifest-digest: {expected['manifest_digest']}",
            f"issue-digest: {self.issue_digest}",
            f"final-target: {packet['policy_values']['delivery']['final_target']}",
        )
        delivery.require(
            all(marker in pr["body"] for marker in markers),
            "pull request provenance changed",
        )

    def _verified_prior_plan(self, packet: dict[str, Any]) -> dict[str, Any]:
        prior = packet.get("prior_pr")
        delivery.require(isinstance(prior, dict), "implementation is missing its plan PR")
        current = self._get_pr(prior["number"])
        expected = packet["expected"]
        same_branch = prior.get("head") == expected["head"]
        for field in ("repo", "head", "base", "base_sha"):
            delivery.require(current[field] == prior[field], f"plan PR {field} changed")
        allowed_heads = {prior["head_sha"]}
        if same_branch:
            allowed_heads.add(expected["head_sha"])
        delivery.require(current["head_sha"] in allowed_heads, "plan PR head changed")
        delivery.require(
            current["state"] == "OPEN"
            and current["draft"]
            and current["body"] == prior.get("body")
            and f"Issue: https://github.com/{repo_parts(self.repo)[1]}/{repo_parts(self.repo)[2]}"
                f"/issues/{expected['issue']}" in current["body"]
            and f"delivery-id: {packet['delivery_id']}" in current["body"]
            and f"plan-revision: {expected['plan_revision']}" in current["body"]
            and f"issue-digest: {self.issue_digest}" in current["body"]
            and f"final-target: {packet['policy_values']['delivery']['final_target']}"
                in current["body"],
            "planning PR provenance is not current",
        )
        return current

    def _verified_superseded(self, packet: dict[str, Any]) -> dict[str, Any]:
        supersedes = packet.get("supersedes_pr")
        delivery.require(isinstance(supersedes, dict), "correction is missing its superseded PR")
        expected = packet["expected"]
        current = self._get_pr(supersedes["number"])
        for field in ("repo", "head", "base", "base_sha"):
            delivery.require(current[field] == supersedes.get(field),
                             f"superseded PR {field} changed")
        delivery.require(current["head"] == expected["head"], "superseded PR branch changed")
        delivery.require(current["base"] == expected["base"], "superseded PR base changed")
        delivery.require(
            current["state"] == "OPEN" and current["draft"],
            "superseded PR is not an open draft",
        )
        delivery.require(current["body"] == supersedes.get("body"),
                         "superseded PR provenance changed")
        delivery.require(
            current["head_sha"] in {supersedes.get("head_sha"), expected["head_sha"]},
            "superseded PR head changed",
        )
        _, owner, name = repo_parts(self.repo)
        old_digest = packet.get("supersedes_manifest_digest")
        old_plan_revision = (
            supersedes.get("head_sha")
            if packet["action"] == "publish_plan"
            else expected["plan_revision"]
        )
        markers = (
            f"Issue: https://github.com/{owner}/{name}/issues/{expected['issue']}",
            f"delivery-id: {packet['delivery_id']}",
            f"plan-revision: {old_plan_revision}",
            f"manifest-digest: {old_digest}",
            f"issue-digest: {self.issue_digest}",
            f"final-target: {packet['policy_values']['delivery']['final_target']}",
        )
        delivery.require(
            isinstance(old_digest, str)
            and len(old_digest) == 64
            and all(character in "0123456789abcdef" for character in old_digest)
            and all(marker in current["body"] for marker in markers),
            "superseded PR provenance is not current",
        )
        return current

    def _publish(self, packet: dict[str, Any]) -> dict[str, Any]:
        expected = packet["expected"]
        delivery.require(canonical_repo(expected["repo"]) == self.repo, "expected repository mismatch")
        issue = expected["issue"]
        policy = packet["policy_values"]
        template_key = "plan_template" if packet["action"] == "publish_plan" else "implementation_template"
        expected_head = policy["branches"][template_key].format(issue=issue)
        delivery.require(expected["head"] == expected_head, "publication branch violates policy")
        prefixes = policy["branches"].get("allowed_parent_prefixes", [])
        delivery.require(
            expected["base"] == policy["branches"]["default_parent"]
            or any(
                expected["base"].startswith(prefix.rstrip("/") + "/")
                for prefix in prefixes
            ),
            "publication base violates policy",
        )
        self._base_tip(expected)
        supersedes = packet.get("supersedes_pr")
        if supersedes is not None:
            delivery.require(isinstance(supersedes, dict), "superseded PR is invalid")
            match = self._match_pr(packet)
            if match:
                delivery.require(match["number"] == supersedes.get("number"),
                                 "corrected PR identity changed")
                delivery.require(match["state"] == "OPEN" and match["draft"],
                                 "matching PR is not an open draft")
                self._verify_pr_provenance(packet, match)
                if packet["action"] == "publish_implementation":
                    self._approval(packet, "plan_approval")
                return {"schema_version": 1, "action": packet["action"], "pr": match}
            verified_superseded = self._verified_superseded(packet)
            if packet["action"] == "publish_implementation":
                self._approval(packet, "plan_approval")
        else:
            verified_superseded = None
        verified_prior = None
        if packet["action"] == "publish_implementation" and verified_superseded is None:
            prior = packet.get("prior_pr")
            delivery.require(isinstance(prior, dict), "implementation is missing its plan PR")
            match = self._match_pr(packet)
            if match:
                if prior.get("head") == expected["head"]:
                    delivery.require(
                        match["number"] == prior["number"],
                        "converted implementation PR identity changed",
                    )
                delivery.require(
                    match["state"] == "OPEN" and match["draft"],
                    "matching PR is not an open draft",
                )
                self._verify_pr_provenance(packet, match)
                self._approval(packet, "plan_approval")
                return {"schema_version": 1, "action": packet["action"], "pr": match}
            verified_prior = self._verified_prior_plan(packet)
            self._approval(packet, "plan_approval")
        match = self._match_pr(packet)
        if match:
            if verified_superseded is not None:
                delivery.require(match["number"] == supersedes["number"],
                                 "corrected PR identity changed")
            delivery.require(match["state"] == "OPEN" and match["draft"], "matching PR is not an open draft")
            self._verify_pr_provenance(packet, match)
            return {"schema_version": 1, "action": packet["action"], "pr": match}
        candidate = packet.get("candidate", {})
        hashes = candidate.get("hashes") if packet["action"] == "publish_plan" else None
        with self.git_factory(self.root, self.canonical_url) as trusted:
            trusted.fetch_base(expected["base"], expected["base_sha"])
            trusted.import_candidate(
                Path(candidate["bundle_path"]),
                expected["head_sha"],
                expected["base_sha"],
                candidate["paths"],
                hashes,
            )
            current = trusted.remote_head(expected["head"])
            prior = verified_superseded or verified_prior
            prior_sha = (
                prior.get("head_sha")
                if prior and prior.get("head") == expected["head"]
                else None
            )
            delivery.require(
                current in (None, prior_sha, expected["head_sha"]),
                "publication branch moved",
            )
            if verified_superseded is not None:
                trusted.require_material_change(supersedes["head_sha"])
            if current != expected["head_sha"]:
                self._verify_policy(packet)
                self._base_tip(expected)
                if packet["action"] == "publish_implementation":
                    self._approval(packet, "plan_approval")
                trusted.push(expected["head"], expected["head_sha"], current)
        match = self._match_pr(packet)
        if match:
            if verified_superseded is not None:
                delivery.require(match["number"] == supersedes["number"],
                                 "corrected PR identity changed")
            delivery.require(match["state"] == "OPEN" and match["draft"], "matching PR is not an open draft")
            self._verify_pr_provenance(packet, match)
            return {"schema_version": 1, "action": packet["action"], "pr": match}

        body = self._pr_body(packet)
        if verified_superseded is not None:
            current_pr = self._verified_superseded(packet)
            delivery.require(
                current_pr["head_sha"] == expected["head_sha"],
                "corrected PR head was not published",
            )
            self._verify_policy(packet)
            self._base_tip(expected)
            if packet["action"] == "publish_implementation":
                self._approval(packet, "plan_approval")
            value = self.client.api(
                "PATCH",
                self.repo,
                f"/repos/{{owner}}/{{repo}}/pulls/{current_pr['number']}",
                {"title": ("Plan" if packet["action"] == "publish_plan" else "Implement")
                 + f" issue #{expected['issue']}", "body": body, "base": expected["base"]},
            )
        elif (
            packet["action"] == "publish_implementation"
            and verified_prior
            and verified_prior.get("head") == expected["head"]
        ):
            current_pr = self._verified_prior_plan(packet)
            delivery.require(
                current_pr["draft"]
                and current_pr["state"] == "OPEN"
                and current_pr["head"] == expected["head"]
                and current_pr["head_sha"] == expected["head_sha"]
                and current_pr["base"] == expected["base"]
                and f"delivery-id: {packet['delivery_id']}" in current_pr["body"]
                and f"plan-revision: {expected['plan_revision']}" in current_pr["body"],
                "planning PR cannot be converted",
            )
            self._approval(packet, "plan_approval")
            value = self.client.api(
                "PATCH",
                self.repo,
                f"/repos/{{owner}}/{{repo}}/pulls/{current_pr['number']}",
                {"title": f"Implement issue #{expected['issue']}", "body": body,
                 "base": expected["base"]},
            )
        else:
            self._verify_policy(packet)
            self._base_tip(expected)
            if packet["action"] == "publish_implementation":
                self._approval(packet, "plan_approval")
            value = self.client.api(
                "POST",
                self.repo,
                "/repos/{owner}/{repo}/pulls",
                {
                    "title": ("Plan" if packet["action"] == "publish_plan" else "Implement")
                    + f" issue #{expected['issue']}",
                    "body": body,
                    "head": expected["head"],
                    "base": expected["base"],
                    "draft": True,
                },
            )
        created = self._normalize_pr(value)
        if verified_superseded is not None:
            delivery.require(created["number"] == supersedes["number"],
                             "corrected PR identity changed")
        delivery.require(created["draft"] and created["state"] == "OPEN", "PR is not an open draft")
        delivery.require(created["head_sha"] == expected["head_sha"], "published PR head mismatch")
        delivery.require(created["base"] == expected["base"], "published PR base mismatch")
        readback = self._get_pr(created["number"])
        if verified_superseded is not None:
            delivery.require(readback["number"] == supersedes["number"],
                             "corrected PR identity changed")
        self._verify_pr_provenance(packet, readback)
        return {"schema_version": 1, "action": packet["action"], "pr": readback}

    def _list_reviews(self, packet: dict[str, Any]) -> dict[str, Any]:
        expected = packet["pr"]
        current = self._get_pr(expected["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(current[field] == expected[field], f"pull request {field} changed")
        delivery.require(current["draft"] and current["state"] == "OPEN", "review target is not an open draft")
        return {
            "schema_version": 1,
            "action": "list_reviews",
            "paginated": True,
            "pr": current,
            "reviews": self._reviews(current["number"]),
        }

    def _finalize(self, packet: dict[str, Any]) -> dict[str, Any]:
        expected = packet["pr"]
        current = self._get_pr(expected["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(current[field] == expected[field], f"implementation PR {field} changed")
        delivery.require(current["state"] == "OPEN", "implementation PR is not open")
        self._verify_pr_provenance(packet, current)
        if not current["draft"]:
            self._approval(packet, "plan_approval")
            self._approval(packet)
            return self._finalize_issue(packet, current)
        self._approval(packet, "plan_approval")
        self._approval(packet)
        self._verify_policy(packet)
        self._base_tip({"base": current["base"], "base_sha": current["base_sha"]})
        query = (
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id})"
            "{pullRequest{id isDraft}}}"
        )
        result = self.client.graphql(query, {"id": current["node_id"]})
        ready = result.get("data", {}).get("markPullRequestReadyForReview", {}).get("pullRequest", {})
        delivery.require(ready.get("isDraft") is False, "GitHub did not mark the PR ready")
        readback = self._get_pr(current["number"])
        delivery.require(
            not readback["draft"] and readback["head_sha"] == current["head_sha"],
            "ready PR readback changed",
        )
        return self._finalize_issue(packet, readback)

    def _finalize_issue(self, packet: dict[str, Any], pr: dict[str, Any]) -> dict[str, Any]:
        self._verify_policy(packet)
        self._approval(packet, "plan_approval")
        self._approval(packet)
        current = self._get_pr(pr["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(current[field] == pr[field], f"ready PR {field} changed")
        delivery.require(current["state"] == "OPEN" and not current["draft"], "PR is not ready")
        self._base_tip({"base": current["base"], "base_sha": current["base_sha"]})
        issue = self._verify_issue(packet)
        digest = hashlib.sha256(
            delivery.canonical_json({"title": issue.get("title", ""), "body": issue.get("body", "")})
        ).hexdigest()
        delivery.require(digest == self.issue_digest, "source issue changed during finalization")
        label = packet["existing_review_label"]
        configured = packet["policy_values"].get("tracking", {}).get("review_label")
        delivery.require(label == configured and isinstance(label, str) and label,
                         "review label differs from policy")
        self.client.api(
            "GET", self.repo, f"/repos/{{owner}}/{{repo}}/labels/{quote(label, safe='')}",
        )
        self.client.api(
            "POST",
            self.repo,
            f"/repos/{{owner}}/{{repo}}/issues/{packet['issue']}/labels",
            {"labels": [label]},
        )
        issue = self.client.api(
            "GET", self.repo, f"/repos/{{owner}}/{{repo}}/issues/{packet['issue']}",
        )
        labels = sorted({item.get("name") for item in issue.get("labels", []) if item.get("name")})
        delivery.require(label in labels, "review label readback failed")
        return {
            "schema_version": 1,
            "action": "finalize",
            "pr": current,
            "issue": {"number": packet["issue"], "labels": labels},
        }


def main() -> int:
    try:
        packet = json.load(sys.stdin)
        delivery.require(
            os.environ.get("DELIVERY_PUBLISHER_ISOLATED") == "1",
            "publisher isolation marker is missing",
        )
        root_value = os.environ.get("DELIVERY_PUBLISHER_ROOT")
        delivery.require(bool(root_value), "trusted publisher root is missing")
        publisher = Publisher(
            repo=os.environ.get("DELIVERY_PUBLISHER_REPO", ""),
            root=Path(root_value),
            client=GitHubClient(),
        )
        print(json.dumps(publisher.execute(packet), sort_keys=True))
        return 0
    except (delivery.DeliveryError, KeyError, TypeError, ValueError, OSError,
            json.JSONDecodeError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
