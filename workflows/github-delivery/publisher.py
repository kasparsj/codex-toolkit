#!/usr/bin/env python3
"""Credentialed GitHub publisher using a trusted, worktree-free Git boundary."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import re
import subprocess
import sys
import tomllib
from typing import Any
from urllib.parse import quote, urlencode

import delivery
import local_verifier
from app_auth import AppAuthenticator, AppBinding
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
                 git_factory=TrustedGit, app_session=None):
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
        self.app_session = app_session
        self.publisher_lock_fd: int | None = None
        self.issue_digest: str | None = None
        _, owner, name = repo_parts(self.repo)
        self.canonical_url = f"https://github.com/{owner}/{name}.git"

    def execute(self, packet: dict[str, Any]) -> dict[str, Any]:
        with delivery.mutex(self.root / ".publisher.lock") as lock_fd:
            self.publisher_lock_fd = lock_fd
            try:
                return self._execute_locked(packet)
            finally:
                self.publisher_lock_fd = None

    def _execute_locked(self, packet: dict[str, Any]) -> dict[str, Any]:
        delivery.require(packet.get("schema_version") == 1, "invalid publisher packet schema")
        delivery.require(
            canonical_repo(packet.get("target_repo", "")) == self.repo,
            "packet repository mismatch",
        )
        action = packet.get("action")
        delivery.require(
            action in {"preflight", "publish_plan", "publish_implementation", "list_reviews", "finalize"},
            "unsupported publisher action",
        )
        self._verify_policy(packet)
        if action == "preflight":
            self._verify_actor(packet)
            return self._preflight(packet)
        if action == "list_reviews":
            if packet.get("credential_mode") == "app":
                self._verify_actor(packet)
            return self._list_reviews(packet)
        self._verify_actor(packet)
        if packet.get("credential_mode") == "app":
            expected = packet["expected"]
            delivery.require(
                expected.get("base") == delivery.policy_branch(packet["policy"]["ref"])
                and expected.get("base_sha") == packet["policy"]["sha"]
                and expected.get("issue") == packet.get("issue"),
                "App mutation does not match the pinned base and issue",
            )
        issue = self._verify_issue(packet)
        self.issue_digest = hashlib.sha256(
            delivery.canonical_json({"title": issue.get("title", ""), "body": issue.get("body", "")})
        ).hexdigest()
        if action in {"publish_plan", "publish_implementation"}:
            return self._publish(packet)
        return self._finalize(packet)

    def _verify_actor(self, packet: dict[str, Any]) -> None:
        if packet.get("credential_mode") == "app":
            delivery.require(self.app_session is not None, "App session is unavailable")
            binding = self.app_session.binding
            digest = getattr(binding, "digest", None)
            if callable(digest):
                digest = digest()
            delivery.require(packet.get("app_binding_digest") == digest,
                             "packet App binding digest mismatch")
            delivery.require(binding.repository.lower() == "/".join(repo_parts(self.repo)[1:]),
                             "App binding repository mismatch")
            delivery.require(
                packet["policy_values"]["delivery"]["publisher_id"] == binding.bot_user_id,
                "policy publisher is not the bound App bot",
            )
            return
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
        branch = delivery.policy_branch(policy.get("ref", ""))
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
        if packet.get("credential_mode") == "app":
            source = supplied.get("_source")
            values = {key: value for key, value in supplied.items() if key != "_source"}
            delivery.require(values == parsed and source == policy,
                             "packet policy values do not exactly match the trusted policy")
        else:
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
        if packet.get("initial"):
            delivery.require(not labels, "initial source issue must be unlabeled")
        return issue

    def _identity_evidence(self) -> dict[str, Any]:
        delivery.require(self.app_session is not None, "App session is unavailable")
        return self.app_session.identity_evidence()

    def _preflight(self, packet: dict[str, Any]) -> dict[str, Any]:
        delivery.require(packet.get("credential_mode") == "app",
                         "preflight requires GitHub App credentials")
        issue = self._verify_issue(packet)
        binding = self.app_session.binding
        repository = self.client.api("GET", self.repo, "/repos/{owner}/{repo}")
        delivery.require(
            repository.get("id") == binding.repository_id
            and str(repository.get("full_name", "")).lower() == binding.repository.lower()
            and repository.get("private") is True,
            "repository identity or privacy differs from the App binding",
        )
        default_branch = repository.get("default_branch")
        policy = packet["policy_values"]
        delivery.require(
            policy["eligibility"].get("required_labels") == []
            and policy["branches"]["plan_template"]
            == policy["branches"]["implementation_template"]
            and all(
                policy["approvals"][stage].get("minimum") == 1
                and len(policy["approvals"][stage].get("reviewer_ids", [])) == 1
                for stage in ("plan", "implementation")
            ),
            "disposable M1 policy does not match the reviewed gate profile",
        )
        delivery.require(
            isinstance(default_branch, str)
            and policy["branches"]["default_parent"] == default_branch
            and policy["delivery"]["final_target"] == default_branch
            and delivery.policy_branch(packet["policy"]["ref"]) == default_branch,
            "policy and repository default branches differ",
        )
        protection = self.client.api(
            "GET", self.repo,
            f"/repos/{{owner}}/{{repo}}/branches/{quote(default_branch, safe='')}",
        )
        branch_protected = protection.get("protected")
        delivery.require(isinstance(branch_protected, bool),
                         "GitHub default branch protection status is unreadable")
        label = policy.get("tracking", {}).get("review_label")
        delivery.require(isinstance(label, str) and label, "App policy review label is missing")
        existing_label = self.client.api(
            "GET", self.repo, f"/repos/{{owner}}/{{repo}}/labels/{quote(label, safe='')}",
        )
        delivery.require(existing_label.get("name") == label, "App policy review label differs from GitHub")
        if policy["delivery"].get("require_github_actions", True):
            self._verify_fixture_workflow(binding.ci, packet["policy"]["sha"])
        else:
            self._verify_audited_workflows(self._local_profile(), packet["policy"]["sha"])
        reviewer_ids = sorted({
            reviewer_id
            for stage in ("plan", "implementation")
            for reviewer_id in policy["approvals"][stage]["reviewer_ids"]
        })
        reviewers = []
        for reviewer_id in reviewer_ids:
            user = self.client.api("GET", self.repo, f"/user/{reviewer_id}")
            delivery.require(user.get("id") == reviewer_id and user.get("type") == "User",
                             "configured reviewer is not a human account")
            reviewers.append({"id": reviewer_id, "login": user.get("login"), "type": "User"})
        issue_number = issue["number"]
        pulls = self.client.paginated(
            self.repo, "/repos/{owner}/{repo}/pulls?state=all&per_page=100",
        )
        sanitized_pulls = [{
            "number": value.get("number"),
            "state": value.get("state"),
            "draft": value.get("draft"),
            "head": value.get("head", {}).get("ref"),
            "head_sha": value.get("head", {}).get("sha"),
            "base": value.get("base", {}).get("ref"),
            "author_id": value.get("user", {}).get("id"),
        } for value in pulls]
        owned_branch = policy["branches"]["plan_template"].format(issue=issue_number)
        delivery.require(owned_branch != default_branch,
                         "App delivery branch must differ from the default branch")
        for pull in sanitized_pulls:
            if pull["head"] != owned_branch:
                continue
            if packet.get("initial"):
                raise delivery.DeliveryError("owned delivery branch already has a pull request")
            raw = next(value for value in pulls if value.get("number") == pull["number"])
            delivery.require(
                f"delivery-id: {packet['delivery_id']}" in (raw.get("body") or ""),
                "owned delivery branch has a conflicting pull request",
            )
        return {
            "schema_version": 1,
            "action": "preflight",
            "identity": {**self._identity_evidence(), "default_branch_protected": branch_protected},
            "snapshot": {
                "schema_version": 1,
                "repo": packet["target_repo"],
                "repository": {"id": binding.repository_id,
                               "full_name": binding.repository,
                               "private": True, "default_branch": default_branch,
                               "protected": branch_protected},
                "source": {"ref": packet["policy"]["ref"],
                           "sha": packet["policy"]["sha"]},
                "issues": [{
                    "number": issue_number,
                    "title": issue.get("title", ""),
                    "body": issue.get("body", ""),
                    "state": issue.get("state"),
                    "labels": sorted(item.get("name") for item in issue.get("labels", [])
                                     if item.get("name")),
                }],
                "pull_requests": sanitized_pulls,
                "reviewers": reviewers,
                "fetched_at": delivery.utc_now(),
            },
        }

    def _local_profile(self) -> dict[str, Any]:
        profile = getattr(self.app_session.binding, "local_verifier", None)
        delivery.require(isinstance(profile, dict), "protected App binding is missing a local verifier")
        return profile

    def _workflow_bytes(self, path: str, sha: str) -> bytes:
        workflow_content = self.client.api(
            "GET", self.repo,
            f"/repos/{{owner}}/{{repo}}/contents/{path}?"
            f"{urlencode({'ref': sha})}",
        )
        delivery.require(workflow_content.get("encoding") == "base64",
                         "trusted CI workflow encoding is unsupported")
        try:
            return base64.b64decode(
                "".join(workflow_content["content"].split()), validate=True,
            )
        except (KeyError, ValueError) as exc:
            raise delivery.DeliveryError("trusted CI workflow content is invalid") from exc

    def _verify_fixture_workflow(self, ci: dict[str, Any] | None, sha: str) -> None:
        delivery.require(isinstance(ci, dict), "protected App binding is missing Actions CI")
        workflow = self.client.api(
            "GET", self.repo,
            f"/repos/{{owner}}/{{repo}}/actions/workflows/{ci['workflow_id']}",
        )
        delivery.require(
            workflow.get("id") == ci["workflow_id"]
            and workflow.get("path") == ci["workflow_path"]
            and workflow.get("state") == "active",
            "trusted CI workflow differs from the App binding",
        )
        workflows = self.client.paginated(
            self.repo, "/repos/{owner}/{repo}/actions/workflows?per_page=100",
        )
        active_workflows = [item for item in workflows if item.get("state") == "active"]
        delivery.require(
            len(active_workflows) == 1
            and active_workflows[0].get("id") == ci["workflow_id"],
            "disposable repository must have exactly one active trusted workflow",
        )
        workflow_bytes = self._workflow_bytes(ci["workflow_path"], sha)
        expected_workflow_digest = ci.get("workflow_sha256")
        delivery.require(
            isinstance(expected_workflow_digest, str)
            and hashlib.sha256(workflow_bytes).hexdigest() == expected_workflow_digest,
            "trusted CI workflow digest differs from the App binding",
        )
        fixture = Path(__file__).resolve().parent / "fixtures" / "delivery-fixture.yml"
        delivery.require(workflow_bytes == fixture.read_bytes() and ci["required_job"] == "verify-fixture",
                         "trusted CI must match the shipped M1 fixture workflow")

    def _verify_audited_workflows(self, profile: dict[str, Any], sha: str) -> None:
        try:
            entries = self.client.api(
                "GET", self.repo,
                f"/repos/{{owner}}/{{repo}}/contents/.github/workflows?{urlencode({'ref': sha})}",
            )
        except delivery.DeliveryError as exc:
            if getattr(exc.__cause__, "code", None) != 404:
                raise
            entries = []
        delivery.require(isinstance(entries, list) and len(entries) < 1000,
                         "audited workflow inventory is unreadable or truncated")
        paths = []
        for entry in entries:
            path = entry.get("path")
            delivery.require(isinstance(path, str), "audited workflow path is invalid")
            if path.lower().endswith((".yml", ".yaml")):
                delivery.require(entry.get("type") == "file", "audited workflow must be a regular file")
                paths.append(path)
        expected = profile["audited_workflows"]
        delivery.require(sorted(paths) == sorted(expected), "audited workflow inventory changed")
        for path, digest in expected.items():
            delivery.require(delivery.digest_bytes(self._workflow_bytes(path, sha)) == digest,
                             f"audited workflow content changed: {path}")

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
            "author_id": value.get("user", {}).get("id"),
            "author_type": value.get("user", {}).get("type"),
            "author_login": value.get("user", {}).get("login"),
            "head_repo_id": value.get("head", {}).get("repo", {}).get("id"),
            "base_repo_id": value.get("base", {}).get("repo", {}).get("id"),
            "performed_via_github_app": value.get("performed_via_github_app"),
        }

    def _verify_app_pr_author(self, packet: dict[str, Any], pr: dict[str, Any]) -> None:
        if packet.get("credential_mode") != "app":
            return
        delivery.require(self.app_session is not None, "App session is unavailable")
        binding = self.app_session.binding
        expected = binding.bot_user_id
        delivery.require(isinstance(expected, int) and expected > 0,
                         "App binding is missing the bot user ID")
        delivery.require(
            pr.get("author_id") == expected
            and pr.get("author_type") == "Bot"
            and str(pr.get("author_login", "")).lower() == binding.bot_login.lower(),
            "pull request was not authored by the bound GitHub App bot",
        )
        for key in ("head_repo_id", "base_repo_id"):
            if pr.get(key) is not None:
                delivery.require(pr[key] == binding.repository_id,
                                 "pull request repository ID differs from the App binding")
        provenance = pr.get("performed_via_github_app")
        if provenance is not None:
            delivery.require(
                provenance.get("id") == binding.app_id
                and provenance.get("slug") == binding.app_slug,
                "pull request GitHub App provenance differs from the binding",
            )

    def _intent_path(self, packet: dict[str, Any], operation: str) -> Path:
        delivery.validate_delivery_id(packet["delivery_id"])
        generation = packet.get("expected", {}).get("generation")
        delivery.require(isinstance(generation, int) and generation > 0,
                         "publisher intent generation is invalid")
        delivery.require(operation in {"push", "pr_create", "pr_update", "ready", "label"},
                         "publisher intent operation is invalid")
        action = packet.get("action")
        operation_id = packet.get("operation_id")
        if packet.get("credential_mode") == "app":
            delivery.require(
                isinstance(operation_id, str) and re.fullmatch(r"[0-9a-f]{20}", operation_id),
                "App publisher operation ID is invalid",
            )
        else:
            operation_id = operation_id or action
        delivery.require(isinstance(action, str) and "/" not in action
                         and isinstance(operation_id, str) and "/" not in operation_id,
                         "publisher intent identity is invalid")
        name = f"{action}-{operation_id}-g{generation}-{operation}.json"
        return self.root / "intents" / packet["delivery_id"] / name

    def _record_intent(self, packet: dict[str, Any], operation: str,
                       before: dict[str, Any], after: dict[str, Any]) -> None:
        path = self._intent_path(packet, operation)
        value = {
            "schema_version": 1,
            "repo": self.repo,
            "delivery_id": packet["delivery_id"],
            "generation": packet.get("expected", {}).get("generation"),
            "operation": operation,
            "operation_id": packet.get("operation_id") or packet.get("action"),
            "action": packet.get("action"),
            "actor_id": (self.app_session.binding.bot_user_id if self.app_session is not None
                         else packet["policy_values"]["delivery"]["publisher_id"]),
            "issue": packet.get("issue") or packet.get("expected", {}).get("issue"),
            "expected": {
                key: packet.get("expected", {}).get(key)
                for key in ("repo", "issue", "head", "head_sha", "base", "base_sha")
            },
            "before": before,
            "after": after,
            "status": "pending",
            "recorded_at": delivery.utc_now(),
        }
        if path.exists():
            existing = delivery.read_json(path)
            comparable = {key: value[key] for key in (
                "schema_version", "repo", "delivery_id", "generation", "operation",
                "operation_id", "action", "actor_id", "issue", "expected", "before", "after",
            )}
            delivery.require(
                existing.get("status") == "pending"
                and all(existing.get(key) == item for key, item in comparable.items()),
                "publisher intent scope conflicts with durable history",
            )
            return
        delivery.atomic_json(path, value)

    def _require_adoptable_intent(self, packet: dict[str, Any], operation: str,
                                  after: dict[str, Any]) -> None:
        path = self._intent_path(packet, operation)
        delivery.require(path.exists(), f"remote {operation} state has no durable publisher intent")
        intent = delivery.read_json(path)
        delivery.require(
            intent.get("status") in {"pending", "checkpointed"}
            and intent.get("repo") == self.repo
            and intent.get("operation_id") == packet.get("operation_id")
            and intent.get("action") == packet.get("action")
            and intent.get("after") == after,
            f"remote {operation} state conflicts with durable publisher intent",
        )

    def _checkpoint_intent(self, packet: dict[str, Any], operation: str,
                           observed: dict[str, Any]) -> None:
        path = self._intent_path(packet, operation)
        intent = delivery.read_json(path)
        delivery.require(intent.get("operation") == operation and intent.get("status") == "pending",
                         "publisher intent changed before checkpoint")
        after = intent.get("after", {})
        if operation == "push":
            satisfied = observed == after
        elif operation in {"pr_create", "pr_update"}:
            satisfied = all(observed.get(key) == value for key, value in after.items())
        elif operation == "ready":
            satisfied = (observed.get("number") == after.get("number")
                         and observed.get("draft") is False)
        else:
            satisfied = (observed.get("issue") == after.get("issue")
                         and after.get("label") in observed.get("labels", []))
        delivery.require(satisfied, "publisher write readback does not satisfy durable intent")
        intent.update({"status": "checkpointed", "observed": observed,
                       "checkpointed_at": delivery.utc_now()})
        delivery.atomic_json(path, intent)

    def _checkpoint_if_pending(self, packet: dict[str, Any], operation: str,
                               observed: dict[str, Any]) -> None:
        path = self._intent_path(packet, operation)
        if not path.exists():
            return
        intent = delivery.read_json(path)
        if intent.get("status") == "pending" and intent.get("operation") == operation:
            self._checkpoint_intent(packet, operation, observed)

    def _fault_after(self, packet: dict[str, Any], operation: str) -> None:
        if os.environ.get("DELIVERY_PUBLISHER_FAULT_AFTER") != operation:
            return
        operation_id = packet.get("operation_id") or packet.get("action")
        marker = (self.root / "faults" / packet["delivery_id"]
                  / f"{packet.get('action')}-{operation_id}-{operation}")
        if marker.exists():
            return
        delivery.atomic_json(marker, {"operation": operation, "injected_at": delivery.utc_now()})
        raise delivery.DeliveryError(f"injected lost response after {operation}")

    def _validate_candidate_paths(self, packet: dict[str, Any]) -> None:
        if packet.get("credential_mode") != "app":
            return
        paths = packet.get("candidate", {}).get("paths", [])
        for value in paths:
            delivery.require(isinstance(value, str), "candidate path must be a string")
            normalized = PurePosixPath(value).as_posix()
            delivery.require(normalized == value and not PurePosixPath(value).is_absolute(),
                             "candidate path is not normalized")
            delivery.require(
                value != POLICY_PATH and not value.startswith(".github/workflows/"),
                f"candidate changes a privileged path: {value}",
            )
        delivery.require(self.app_session is not None, "App session is unavailable")
        self.app_session.binding.verify_candidate_paths(paths)

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
        reviews = self._reviews(pr["number"])
        if packet.get("credential_mode") == "app":
            authorized = set(evidence["reviewer_ids"])
            for review in reviews:
                user = review.get("user", {})
                if user.get("id") in authorized:
                    delivery.require(user.get("type") == "User",
                                     "authorized reviewer is not a human account")
                    login = user.get("login")
                    delivery.require(isinstance(login, str) and login,
                                     "authorized reviewer login is missing")
                    resolved = self.client.api(
                        "GET", self.repo, f"/users/{quote(login, safe='')}",
                    )
                    delivery.require(
                        resolved.get("id") == user.get("id") and resolved.get("type") == "User",
                        "authorized reviewer identity changed",
                    )
        verdict = delivery.evaluate_reviews(
            reviews,
            stage=evidence["stage"],
            generation=evidence["generation"],
            context_digest=evidence["context_digest"],
            commit_id=expected_pr["head_sha"],
            authorized_ids=evidence["reviewer_ids"],
            publisher_id=packet["policy_values"]["delivery"]["publisher_id"],
            minimum=evidence["minimum"],
            require_human=packet.get("credential_mode") == "app",
        )
        delivery.require(verdict["approved"], f"{evidence['stage']} approval is not current")

    def _ci_config(self) -> dict[str, Any] | None:
        if self.app_session is None:
            return None
        value = getattr(self.app_session.binding, "ci", None)
        delivery.require(isinstance(value, dict) and value,
                         "App binding is missing trusted CI configuration")
        return value

    def _ci_status(self, pr: dict[str, Any]) -> dict[str, Any]:
        config = self._ci_config()
        if config is None:
            return {"status": "success", "reason": "not_configured"}
        workflow_id = config.get("workflow_id")
        event = config.get("event", "pull_request")
        required_jobs = [config.get("required_job")]
        delivery.require(isinstance(workflow_id, (int, str)) and workflow_id,
                         "CI workflow ID is invalid")
        delivery.require(isinstance(event, str) and event, "CI event is invalid")
        delivery.require(
            isinstance(required_jobs, list) and required_jobs
            and all(isinstance(name, str) and name for name in required_jobs),
            "CI required jobs are invalid",
        )
        query = urlencode({"event": event, "per_page": 100})
        runs = self.client.paginated(
            self.repo,
            f"/repos/{{owner}}/{{repo}}/actions/workflows/{workflow_id}/runs?{query}",
        )
        def correlated(run: dict[str, Any]) -> bool:
            if (run.get("event") != event
                    or str(run.get("workflow_id")) != str(workflow_id)):
                return False
            pull_requests = run.get("pull_requests", [])
            delivery.require(isinstance(pull_requests, list), "CI PR correlation is malformed")
            same_number = [item for item in pull_requests
                           if item.get("number") == pr.get("number")]
            exact = [item for item in pull_requests if (
                item.get("number") == pr.get("number")
                and item.get("head", {}).get("sha") == pr["head_sha"]
                and item.get("base", {}).get("sha") == pr.get("base_sha")
            )]
            delivery.require(len(exact) <= 1, "CI PR correlation is ambiguous")
            if pull_requests:
                if not same_number:
                    return False
                delivery.require(len(same_number) == 1, "CI PR correlation is ambiguous")
                candidate = same_number[0]
                delivery.require(
                    delivery.FULL_SHA.fullmatch(str(candidate.get("head", {}).get("sha", "")))
                    and delivery.FULL_SHA.fullmatch(str(candidate.get("base", {}).get("sha", ""))),
                    "CI PR correlation is malformed",
                )
                return len(exact) == 1
            if run.get("head_sha") != pr["head_sha"]:
                return False
            delivery.require(
                run.get("head_branch") == pr.get("head")
                and run.get("head_repository", {}).get("id")
                == self.app_session.binding.repository_id,
                "CI direct-head correlation is incomplete",
            )
            return True

        matching = [run for run in runs if correlated(run)]
        if not matching:
            return {"status": "waiting", "reason": "missing", "workflow_id": workflow_id,
                    "event": event, "head_sha": pr["head_sha"]}
        delivery.require(all(type(item.get("id")) is int and item["id"] > 0
                             and type(item.get("run_attempt")) is int and item["run_attempt"] > 0
                             and delivery.FULL_SHA.fullmatch(str(item.get("head_sha", "")))
                             for item in matching), "CI run identity is malformed")
        run_keys = {(item["id"], item["run_attempt"]) for item in matching}
        delivery.require(len(run_keys) == len(matching), "CI run attempt is ambiguous")
        run = max(matching, key=lambda item: (item["id"], item["run_attempt"]))
        evidence = {"workflow_id": workflow_id, "event": event, "head_sha": pr["head_sha"],
                    "tested_sha": run["head_sha"], "run_id": run["id"], "run_attempt": run["run_attempt"]}
        if run["head_sha"] != pr["head_sha"]:
            tested = self.client.api(
                "GET", self.repo, f"/repos/{{owner}}/{{repo}}/git/commits/{run['head_sha']}",
            )
            if (tested.get("sha") != run["head_sha"]
                    or [parent.get("sha") for parent in tested.get("parents", [])]
                    != [pr["base_sha"], pr["head_sha"]]):
                return {**evidence, "status": "unknown", "reason": "test_merge_parents_mismatch"}
        if run.get("status") != "completed":
            return {**evidence, "status": "waiting", "reason": "run_pending"}
        if run.get("conclusion") == "action_required":
            return {**evidence, "status": "waiting", "reason": "workflow_authorization_required"}
        if run.get("conclusion") != "success":
            return {**evidence, "status": "blocked", "reason": "run_failed",
                    "conclusion": run.get("conclusion")}
        jobs = self.client.paginated(
            self.repo,
            f"/repos/{{owner}}/{{repo}}/actions/runs/{run['id']}/attempts/"
            f"{run.get('run_attempt', 1)}/jobs?per_page=100",
        )
        matching_jobs = [job for job in jobs if job.get("name") in required_jobs]
        delivery.require(
            all(isinstance(job.get("id"), int) and job["id"] > 0 for job in matching_jobs),
            "CI required job identity is malformed",
        )
        delivery.require(len({job["name"] for job in matching_jobs}) == len(matching_jobs),
                         "CI required job result is ambiguous")
        latest = {job["name"]: job for job in matching_jobs}
        missing = sorted(set(required_jobs) - set(latest))
        if missing:
            return {**evidence, "status": "waiting", "reason": "jobs_missing", "jobs": missing}
        pending = sorted(name for name, job in latest.items() if job.get("status") != "completed")
        if pending:
            return {**evidence, "status": "waiting", "reason": "jobs_pending", "jobs": pending}
        failed = sorted(name for name, job in latest.items() if job.get("conclusion") != "success")
        if failed:
            return {**evidence, "status": "blocked", "reason": "jobs_failed", "jobs": failed}
        return {**evidence, "status": "success", "reason": "required_jobs_succeeded",
                "jobs": [{"id": latest[name]["id"], "name": name}
                         for name in sorted(required_jobs)]}

    def _gate_ci(self, pr: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._ci_status(pr)
        except delivery.DeliveryError as exc:
            reason = "ambiguous_readback" if "ambiguous" in str(exc) else "unreadable_ci"
            return {"status": "unknown", "reason": reason, "head_sha": pr["head_sha"],
                    "diagnostic": str(exc)}
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            return {"status": "unknown", "reason": "malformed_readback", "head_sha": pr["head_sha"],
                    "diagnostic": type(exc).__name__}

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
        if packet.get("credential_mode") == "app":
            delivery.require(pr["body"] == self._pr_body(packet), "pull request provenance changed")
            return
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

    def _verify_app_candidate_history(self, packet: dict[str, Any], previous: str) -> None:
        if packet.get("credential_mode") != "app":
            return
        expected = packet["expected"]
        candidate = packet["candidate"]
        hashes = candidate.get("hashes") if packet["action"] == "publish_plan" else None
        with self.git_factory(self.root, self.canonical_url) as trusted:
            trusted.fetch_base(expected["base"], expected["base_sha"])
            trusted.import_candidate(
                Path(candidate["bundle_path"]), expected["head_sha"], expected["base_sha"],
                candidate["paths"], hashes,
            )
            trusted.verify_introduced_paths(
                previous, allow_paths=self.app_session.binding.verify_candidate_paths,
            )

    def _require_pr_adoption(self, packet: dict[str, Any], pr: dict[str, Any],
                             operation: str) -> None:
        if packet.get("credential_mode") != "app":
            return
        expected = packet["expected"]
        if operation == "pr_create":
            after = {"head": expected["head"], "head_sha": expected["head_sha"],
                     "base": expected["base"], "body": pr["body"]}
        else:
            after = {"number": pr["number"], "head_sha": expected["head_sha"],
                     "base": expected["base"], "body": pr["body"]}
        self._require_adoptable_intent(packet, operation, after)

    def _publish(self, packet: dict[str, Any]) -> dict[str, Any]:
        expected = packet["expected"]
        self._validate_candidate_paths(packet)
        delivery.require(canonical_repo(expected["repo"]) == self.repo, "expected repository mismatch")
        issue = expected["issue"]
        policy = packet["policy_values"]
        template_key = "plan_template" if packet["action"] == "publish_plan" else "implementation_template"
        expected_head = policy["branches"][template_key].format(issue=issue)
        delivery.require(expected["head"] == expected_head, "publication branch violates policy")
        if packet.get("credential_mode") == "app":
            delivery.require(expected_head not in {expected["base"], policy["branches"]["default_parent"]},
                             "App delivery branch must differ from the default branch and base")
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
                self._verify_app_pr_author(packet, match)
                self._verify_app_candidate_history(packet, supersedes["head_sha"])
                self._require_pr_adoption(packet, match, "pr_update")
                self._checkpoint_if_pending(packet, "pr_update", match)
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
                self._verify_app_pr_author(packet, match)
                previous = (prior["head_sha"] if prior.get("head") == expected["head"]
                            else expected["base_sha"])
                self._verify_app_candidate_history(packet, previous)
                operation = "pr_update" if prior.get("head") == expected["head"] else "pr_create"
                self._require_pr_adoption(packet, match, operation)
                self._checkpoint_if_pending(packet, "pr_update", match)
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
            self._verify_app_pr_author(packet, match)
            previous = expected["base_sha"]
            if isinstance(supersedes, dict):
                previous = supersedes["head_sha"]
            elif ((packet.get("prior_pr") or {}).get("head") == expected["head"]):
                previous = packet["prior_pr"]["head_sha"]
            self._verify_app_candidate_history(packet, previous)
            operation = ("pr_update" if isinstance(supersedes, dict)
                         or (packet.get("prior_pr") or {}).get("head") == expected["head"]
                         else "pr_create")
            self._require_pr_adoption(packet, match, operation)
            self._checkpoint_if_pending(packet, "pr_create", match)
            self._checkpoint_if_pending(packet, "pr_update", match)
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
            if packet.get("credential_mode") == "app":
                trusted.verify_introduced_paths(
                    prior_sha or expected["base_sha"],
                    allow_paths=self.app_session.binding.verify_candidate_paths,
                )
            delivery.require(
                current in (None, prior_sha, expected["head_sha"]),
                "publication branch moved",
            )
            if (packet["action"] == "publish_implementation" and prior is not None
                    and prior.get("head") == expected["head"]):
                delivery.require(current is not None,
                                 "same-branch implementation lost its planning ref")
            if verified_superseded is not None:
                trusted.require_material_change(supersedes["head_sha"])
            if current != expected["head_sha"]:
                self._verify_policy(packet)
                self._base_tip(expected)
                if packet["action"] == "publish_implementation":
                    self._approval(packet, "plan_approval")
                self._record_intent(
                    packet, "push", {"head": expected["head"], "sha": current},
                    {"head": expected["head"], "sha": expected["head_sha"]},
                )
                push_options = ({"lock_fd": self.publisher_lock_fd}
                                if packet.get("credential_mode") == "app" else {})
                trusted.push(expected["head"], expected["head_sha"], current, **push_options)
                self._fault_after(packet, "push")
                self._checkpoint_intent(packet, "push", {
                    "head": expected["head"], "sha": trusted.remote_head(expected["head"]),
                })
            else:
                if packet.get("credential_mode") == "app":
                    self._require_adoptable_intent(packet, "push", {
                        "head": expected["head"], "sha": expected["head_sha"],
                    })
                self._checkpoint_if_pending(packet, "push", {
                    "head": expected["head"], "sha": current,
                })
        match = self._match_pr(packet)
        if match:
            if verified_superseded is not None:
                delivery.require(match["number"] == supersedes["number"],
                                 "corrected PR identity changed")
            delivery.require(match["state"] == "OPEN" and match["draft"], "matching PR is not an open draft")
            self._verify_pr_provenance(packet, match)
            self._verify_app_pr_author(packet, match)
            operation = ("pr_update" if verified_superseded is not None
                         or (verified_prior and verified_prior.get("head") == expected["head"])
                         else "pr_create")
            self._require_pr_adoption(packet, match, operation)
            self._checkpoint_if_pending(packet, "pr_create", match)
            self._checkpoint_if_pending(packet, "pr_update", match)
            return {"schema_version": 1, "action": packet["action"], "pr": match}

        body = self._pr_body(packet)
        issue = expected["issue"]
        title = (f"docs: plan issue #{issue}" if packet["action"] == "publish_plan"
                 else f"chore: implement issue #{issue}")
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
            self._record_intent(packet, "pr_update", current_pr, {
                "number": current_pr["number"], "head_sha": expected["head_sha"],
                "base": expected["base"], "body": body,
            })
            value = self.client.api(
                "PATCH",
                self.repo,
                f"/repos/{{owner}}/{{repo}}/pulls/{current_pr['number']}",
                {"title": title, "body": body, "base": expected["base"]},
            )
            operation = "pr_update"
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
            self._record_intent(packet, "pr_update", current_pr, {
                "number": current_pr["number"], "head_sha": expected["head_sha"],
                "base": expected["base"], "body": body,
            })
            value = self.client.api(
                "PATCH",
                self.repo,
                f"/repos/{{owner}}/{{repo}}/pulls/{current_pr['number']}",
                {"title": title, "body": body, "base": expected["base"]},
            )
            operation = "pr_update"
        else:
            self._verify_policy(packet)
            self._base_tip(expected)
            if packet["action"] == "publish_implementation":
                self._approval(packet, "plan_approval")
            self._record_intent(packet, "pr_create", {
                "head": expected["head"], "matching_pr": None,
            }, {"head": expected["head"], "head_sha": expected["head_sha"],
                "base": expected["base"], "body": body})
            value = self.client.api(
                "POST",
                self.repo,
                "/repos/{owner}/{repo}/pulls",
                {
                    "title": title,
                    "body": body,
                    "head": expected["head"],
                    "base": expected["base"],
                    "draft": True,
                },
            )
            operation = "pr_create"
        self._fault_after(packet, operation)
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
        self._verify_app_pr_author(packet, readback)
        self._checkpoint_intent(packet, operation, readback)
        return {"schema_version": 1, "action": packet["action"], "pr": readback}

    def _list_reviews(self, packet: dict[str, Any]) -> dict[str, Any]:
        expected = packet["pr"]
        current = self._get_pr(expected["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(current[field] == expected[field], f"pull request {field} changed")
        delivery.require(current["draft"] and current["state"] == "OPEN", "review target is not an open draft")
        self._verify_app_pr_author(packet, current)
        if packet.get("credential_mode") == "app":
            delivery.require(current["body"] == expected["body"], "review target PR body changed")
        return {
            "schema_version": 1,
            "action": "list_reviews",
            "paginated": True,
            "pr": current,
            "reviews": self._reviews(current["number"]),
        }

    def _finalization_ci(self, packet: dict[str, Any], pr: dict[str, Any]) -> dict[str, Any]:
        if packet.get("credential_mode") == "app" and not packet["policy_values"]["delivery"].get(
                "require_github_actions", True):
            return self._local_verification(packet, pr)
        if "actions_deferred_head" not in packet:
            return self._gate_ci(pr)
        delivery.require(packet.get("credential_mode") == "app"
                         and packet["actions_deferred_head"] == pr["head_sha"],
                         "Actions deferral is for a different implementation revision")
        return {"status": "deferred", "reason": "operator_deferred", "head_sha": pr["head_sha"]}

    def _local_verification(self, packet: dict[str, Any], pr: dict[str, Any]) -> dict[str, Any]:
        profile = self._local_profile()
        scope = {"repo": self.repo, "delivery_id": packet["delivery_id"], "pr_number": pr["number"],
                 "head_sha": pr["head_sha"], "base_sha": pr["base_sha"],
                 "policy_digest": packet["policy"]["digest"],
                 "binding_digest": packet["app_binding_digest"]}
        key = delivery.digest_bytes(delivery.canonical_json(scope))
        receipt = self.root / "local-verification" / f"{key}.json"
        if receipt.exists():
            saved = delivery.read_json(receipt)
            result = saved.get("result", {})
            delivery.require(saved.get("scope") == scope and result.get("status") == "success"
                             and result.get("head_sha") == pr["head_sha"],
                             "local verification receipt is invalid")
        else:
            result = local_verifier.verify(root=self.root, git_factory=self.git_factory,
                                           canonical_url=self.canonical_url, pr=pr,
                                           profile={"image": profile["image"], "argv": profile["argv"]})
            delivery.require(result.get("head_sha") == pr["head_sha"]
                             and result.get("status") in {"success", "blocked", "unknown"},
                             "local verification returned invalid evidence")
            if result["status"] == "success":
                result["verified_at"] = delivery.utc_now()
                delivery.atomic_json(receipt, {"scope": scope, "result": result})
        return {**result, "source": "local", "head_sha": pr["head_sha"], "base_sha": pr["base_sha"]}

    def _existing_review_label(self, packet: dict[str, Any]) -> str:
        label = packet.get("existing_review_label")
        configured = packet["policy_values"].get("tracking", {}).get("review_label")
        delivery.require(isinstance(label, str) and label and label == configured,
                         "review label differs from policy")
        try:
            existing = self.client.api(
                "GET", self.repo, f"/repos/{{owner}}/{{repo}}/labels/{quote(label, safe='')}",
            )
        except delivery.DeliveryError as exc:
            raise delivery.DeliveryError(f"could not verify existing review label: {exc}") from exc
        delivery.require(existing.get("name") == label, "review label readback differs from policy")
        return label

    def _finalize(self, packet: dict[str, Any]) -> dict[str, Any]:
        require_actions = packet["policy_values"]["delivery"].get("require_github_actions", True)
        delivery.require(require_actions or "actions_deferred_head" not in packet,
                         "fixture deferral is incompatible with the repository's Actions policy")
        app = packet.get("credential_mode") == "app"
        if app and not require_actions:
            self._local_profile()
        expected = packet["pr"]
        current = self._get_pr(expected["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(current[field] == expected[field], f"implementation PR {field} changed")
        delivery.require(current["state"] == "OPEN", "implementation PR is not open")
        self._verify_pr_provenance(packet, current)
        self._verify_app_pr_author(packet, current)
        if not current["draft"]:
            if packet.get("credential_mode") == "app":
                self._require_adoptable_intent(
                    packet, "ready", {"number": current["number"], "draft": False},
                )
            self._approval(packet, "plan_approval")
            self._approval(packet)
            return self._finalize_issue(packet, current)
        self._approval(packet, "plan_approval")
        self._approval(packet)
        if not app or require_actions is not False:
            ci = self._finalization_ci(packet, current)
            if ci["status"] not in {"success", "deferred"}:
                suffix = "waiting" if ci["status"] == "waiting" else "blocked"
                return {"schema_version": 1, "action": "finalize",
                        "status": f"pre_ready_ci_{suffix}", "pr": current, "ci": ci}
        self._verify_policy(packet)
        self._base_tip({"base": current["base"], "base_sha": current["base_sha"]})
        self._approval(packet, "plan_approval")
        self._approval(packet)
        self._existing_review_label(packet)
        query = (
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id})"
            "{pullRequest{id isDraft}}}"
        )
        self._record_intent(packet, "ready", {"number": current["number"], "draft": True},
                            {"number": current["number"], "draft": False})
        result = self.client.graphql(query, {"id": current["node_id"]})
        self._fault_after(packet, "ready")
        ready = result.get("data", {}).get("markPullRequestReadyForReview", {}).get("pullRequest", {})
        delivery.require(ready.get("isDraft") is False, "GitHub did not mark the PR ready")
        readback = self._get_pr(current["number"])
        delivery.require(
            not readback["draft"] and readback["head_sha"] == current["head_sha"],
            "ready PR readback changed",
        )
        self._verify_app_pr_author(packet, readback)
        self._checkpoint_intent(packet, "ready", readback)
        return self._finalize_issue(packet, readback)

    def _finalize_issue(self, packet: dict[str, Any], pr: dict[str, Any]) -> dict[str, Any]:
        self._verify_policy(packet)
        self._approval(packet, "plan_approval")
        self._approval(packet)
        current = self._get_pr(pr["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(current[field] == pr[field], f"ready PR {field} changed")
        delivery.require(current["state"] == "OPEN" and not current["draft"], "PR is not ready")
        self._verify_app_pr_author(packet, current)
        self._verify_pr_provenance(packet, current)
        self._checkpoint_if_pending(packet, "ready", current)
        self._base_tip({"base": current["base"], "base_sha": current["base_sha"]})
        ci = self._finalization_ci(packet, current)
        if ci["status"] not in {"success", "deferred"}:
            suffix = "waiting" if ci["status"] == "waiting" else "blocked"
            return {"schema_version": 1, "action": "finalize",
                    "status": f"post_ready_ci_{suffix}", "pr": current, "ci": ci}
        if ci.get("source") == "local":
            self._verify_policy(packet)
            self._base_tip({"base": current["base"], "base_sha": current["base_sha"]})
        issue = self._verify_issue(packet)
        digest = hashlib.sha256(
            delivery.canonical_json({"title": issue.get("title", ""), "body": issue.get("body", "")})
        ).hexdigest()
        delivery.require(digest == self.issue_digest, "source issue changed during finalization")
        label = self._existing_review_label(packet)
        self._approval(packet, "plan_approval")
        self._approval(packet)
        current_labels = {item.get("name") for item in issue.get("labels", [])}
        if (packet.get("credential_mode") == "app" and label not in current_labels
                and packet.get("checkpoint_tracking") is True):
            return {"schema_version": 1, "action": "finalize", "status": "tracking_pending",
                    "pr": current, "ci": ci}
        if label not in current_labels:
            self._record_intent(packet, "label", {"issue": packet["issue"],
                                "labels": sorted(item for item in current_labels if item)},
                                {"issue": packet["issue"], "label": label})
            self.client.api(
                "POST",
                self.repo,
                f"/repos/{{owner}}/{{repo}}/issues/{packet['issue']}/labels",
                {"labels": [label]},
            )
            self._fault_after(packet, "label")
        elif packet.get("credential_mode") == "app":
            self._require_adoptable_intent(
                packet, "label", {"issue": packet["issue"], "label": label},
            )
        issue = self.client.api(
            "GET", self.repo, f"/repos/{{owner}}/{{repo}}/issues/{packet['issue']}",
        )
        labels = sorted({item.get("name") for item in issue.get("labels", []) if item.get("name")})
        delivery.require(label in labels, "review label readback failed")
        self._checkpoint_if_pending(packet, "label", {"issue": packet["issue"], "labels": labels})
        self._verify_policy(packet)
        self._approval(packet, "plan_approval")
        self._approval(packet)
        final_pr = self._get_pr(current["number"])
        for field in ("repo", "head", "head_sha", "base", "base_sha"):
            delivery.require(final_pr[field] == current[field],
                             f"terminal PR {field} changed")
        delivery.require(final_pr["state"] == "OPEN" and not final_pr["draft"],
                         "terminal PR is not open and ready")
        self._verify_app_pr_author(packet, final_pr)
        self._verify_pr_provenance(packet, final_pr)
        terminal_ci = self._finalization_ci(packet, final_pr)
        if terminal_ci["status"] not in {"success", "deferred"}:
            suffix = "waiting" if terminal_ci["status"] == "waiting" else "blocked"
            return {"schema_version": 1, "action": "finalize",
                    "status": f"post_ready_ci_{suffix}", "pr": final_pr, "ci": terminal_ci}
        terminal_issue = self._verify_issue(packet)
        terminal_labels = sorted({item.get("name") for item in terminal_issue.get("labels", [])
                                  if item.get("name")})
        delivery.require(label in terminal_labels, "terminal review label readback failed")
        return {
            "schema_version": 1,
            "action": "finalize",
            "status": "review_ready",
            "pr": final_pr,
            "issue": {"number": packet["issue"], "labels": terminal_labels},
            "ci": terminal_ci,
        }


def main() -> int:
    app_client = None
    try:
        packet = json.load(sys.stdin)
        delivery.require(
            os.environ.get("DELIVERY_PUBLISHER_ISOLATED") == "1",
            "publisher isolation marker is missing",
        )
        root_value = os.environ.get("DELIVERY_PUBLISHER_ROOT")
        delivery.require(bool(root_value), "trusted publisher root is missing")
        app_config = os.environ.get("DELIVERY_APP_CONFIG")
        session = None
        client = GitHubClient()
        git_factory = TrustedGit
        if packet.get("credential_mode") == "app":
            delivery.require(bool(app_config), "protected App binding is missing")
            binding = AppBinding.load(
                Path(app_config), expected_digest=packet.get("app_binding_digest"),
            )
            delivery.require(Path(root_value).resolve().is_relative_to(binding.state_dir),
                             "publisher root is outside the protected App state directory")
            session = AppAuthenticator(binding).mint()
            auth_env = session.auth_env()
            app_client = session.publisher_client()
            client = app_client
            git_factory = lambda root, url: TrustedGit(
                root, url, auth_env=auth_env, require_explicit_token=True,
            )
        else:
            delivery.require(not app_config, "App binding cannot be used in user-token mode")
        publisher = Publisher(
            repo=os.environ.get("DELIVERY_PUBLISHER_REPO", ""),
            root=Path(root_value),
            client=client,
            git_factory=git_factory,
            app_session=session,
        )
        result = publisher.execute(packet)
        if app_client is not None:
            app_client.revoke()
            app_client = None
        print(json.dumps(result, sort_keys=True))
        return 0
    except (delivery.DeliveryError, KeyError, TypeError, ValueError, OSError,
            json.JSONDecodeError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True))
        return 2
    finally:
        if app_client is not None:
            try:
                app_client.revoke()
            except (delivery.DeliveryError, OSError):
                pass


if __name__ == "__main__":
    raise SystemExit(main())
