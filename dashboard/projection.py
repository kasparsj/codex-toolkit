#!/usr/bin/env python3
"""Project one configured Delivery run into a small atomic dashboard snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any

RUNNER = Path(__file__).resolve().parents[1] / "workflows" / "github-delivery"
sys.path.insert(0, str(RUNNER))
import delivery  # type: ignore  # noqa: E402
import publisher_adapter  # type: ignore  # noqa: E402

FULL_SHA = delivery.FULL_SHA
MAX_AGE = 30


class ProjectionError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ProjectionError(message)


def _safe_artifacts(result: dict[str, Any]) -> list[dict[str, str]]:
    paths = result.get("artifact_paths")
    hashes = result.get("artifact_hashes")
    _require(isinstance(paths, list) and paths, "plan artifacts unavailable")
    _require(isinstance(hashes, dict) and set(paths) == set(hashes), "plan artifact hashes invalid")
    projected = []
    for path in paths:
        _require(isinstance(path, str) and len(path) <= 240, "plan artifact path invalid")
        pure = PurePosixPath(path)
        _require(not pure.is_absolute() and ".." not in pure.parts and pure.suffix.lower() == ".md",
                 "plan artifact path is unsafe")
        digest = hashes[path]
        _require(isinstance(digest, str) and len(digest) == 64
                 and all(c in "0123456789abcdef" for c in digest), "plan artifact digest invalid")
        projected.append({"path": path, "sha256": digest})
    return projected


def build_projection(state_dir: Path, repo: str, delivery_id: str, *, max_age: int = MAX_AGE) -> dict[str, Any]:
    delivery.validate_repo(repo)
    delivery.validate_delivery_id(delivery_id)
    _require(5 <= max_age <= 300, "snapshot max age is invalid")
    coordinator = delivery.Coordinator(state_dir)
    state = coordinator.load(repo, delivery_id)
    _require(state.get("schema_version") == delivery.SCHEMA_VERSION, "delivery schema unsupported")
    _require(state.get("repo") == repo and state.get("delivery_id") == delivery_id,
             "delivery binding mismatch")
    _require(state.get("credential_mode") == "app", "delivery is not App mode")
    app = state.get("app")
    _require(isinstance(app, dict) and isinstance(app.get("repository_id"), int), "App binding unavailable")
    active = delivery.read_json(coordinator._repo_dir(repo) / "active.json")
    claim_status = active.get("status") if active.get("delivery_id") == delivery_id else "other_delivery"

    manifests = state.get("manifests", {})
    plan_manifest = manifests.get("plan")
    plan_publication = state.get("publication", {}).get("plan")
    _require(isinstance(plan_manifest, dict) and isinstance(plan_publication, dict),
             "plan publication unavailable")
    plan_result = plan_manifest.get("value", {}).get("result", {})
    _require(isinstance(plan_result, dict), "plan manifest invalid")
    artifacts = _safe_artifacts(plan_result)
    pr = plan_publication.get("pr")
    _require(isinstance(pr, dict), "plan pull request unavailable")
    required_pr = ("repo", "number", "node_id", "head", "head_sha", "base", "base_sha", "draft", "state")
    _require(all(key in pr for key in required_pr)
             and delivery.repo_identity(pr.get("repo", "")) == delivery.repo_identity(repo),
             "plan pull request invalid")
    _require(isinstance(pr.get("number"), int) and FULL_SHA.fullmatch(str(pr.get("head_sha", "")))
             and FULL_SHA.fullmatch(str(pr.get("base_sha", ""))), "plan pull request revision invalid")

    request = None
    try:
        request = publisher_adapter.approval_request(state, "plan")
    except delivery.DeliveryError:
        request = None
    review = None
    if request:
        approve = delivery.review_body("plan", request["generation"], request["context_digest"], "approve")
        reject = delivery.review_body("plan", request["generation"], request["context_digest"], "reject")
        review = {
            "stage": "plan", "generation": request["generation"],
            "context_digest": request["context_digest"], "minimum": request["minimum"],
            "reviewer_ids": request["reviewer_ids"], "submit_as": "COMMENT",
            "approve": approve, "reject": reject,
            "approval_body_digest": hashlib.sha256(approve.encode()).hexdigest(),
        }

    receipt = state.get("receipts", {}).get("plan")
    projected_receipt = None
    if isinstance(receipt, dict):
        allowed = ("approved", "approvers", "rejectors", "minimum", "review_ids", "commit_id",
                   "context_digest", "checked_at")
        projected_receipt = {key: receipt.get(key) for key in allowed if key in receipt}

    implementation = state.get("publication", {}).get("implementation")
    projected_implementation = None
    if isinstance(implementation, dict) and isinstance(implementation.get("pr"), dict):
        ipr = implementation["pr"]
        projected_implementation = {key: ipr.get(key) for key in required_pr if key in ipr}

    generated = datetime.now(timezone.utc)
    publisher_id = state.get("policy_values", {}).get("delivery", {}).get("publisher_id")
    runner = state.get("runner") if isinstance(state.get("runner"), dict) else {}
    return {
        "projection_version": 1,
        "generated_at": generated.isoformat(),
        "expires_at": (generated + timedelta(seconds=max_age)).isoformat(),
        "binding": {"repo": repo, "repository_id": app["repository_id"], "delivery_id": delivery_id},
        "delivery": {
            "issue": state.get("issue"), "status": state.get("status"), "attempt": state.get("attempt"),
            "runner_status": state.get("runner_status"), "current_step_id": runner.get("current_step_id"),
            "claim_status": claim_status,
        },
        "plan": {
            "generation": plan_manifest.get("generation"), "published_at": plan_publication.get("published_at"),
            "pr": {
                **{key: pr.get(key) for key in required_pr + (
                    "author_id", "author_type", "author_login", "head_repo_id", "base_repo_id",
                    "performed_via_github_app",
                )},
                "repo": repo,
                "body_digest": hashlib.sha256(pr.get("body", "").encode()).hexdigest()
                if isinstance(pr.get("body"), str) and pr.get("body") else None,
            },
            "artifacts": artifacts,
            "review": review,
            "receipt": projected_receipt,
        },
        "implementation": projected_implementation,
        "policy": {"publisher_id": publisher_id,
                   "app_id": app.get("app_id"), "app_slug": app.get("app_slug")},
    }


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--delivery-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-age", type=int, default=MAX_AGE)
    args = parser.parse_args()
    try:
        atomic_write(args.output, build_projection(args.state_dir, args.repo, args.delivery_id,
                                                   max_age=args.max_age))
    except (ProjectionError, delivery.DeliveryError, OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "blocked", "error": "dashboard projection unavailable"}))
        return 2
    print(json.dumps({"status": "ok", "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
