"""Shared protected policy resolution for delivery preview and publication."""

from __future__ import annotations

import base64
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tomllib
from typing import Any, Callable


FULL_SHA = re.compile(r"[0-9a-f]{40}")
EXCLUSION_FLOOR = {"blocked", "duplicate", "invalid", "wontfix", "deferred"}
OVERRIDABLE = {
    ("eligibility", "required_labels"),
    ("eligibility", "excluded_labels"),
    ("tracking", "review_label"),
}


class PolicyResolutionError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PolicyResolutionError(message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _protected_ancestry(path: Path) -> None:
    for parent in path.parents:
        mode = parent.stat().st_mode
        require(not (mode & 0o022 and not mode & 0o1000),
                "operator profile has a group/world-writable parent directory")


def load(path: Path) -> dict[str, Any]:
    """Load an owner-only protected JSON operator profile."""
    require(path.is_absolute(), "operator profile path must be absolute")
    require(not path.is_symlink(), "operator profile must not be a symlink")
    source = path.resolve()
    try:
        info = source.stat()
        require(stat.S_ISREG(info.st_mode), "operator profile must be a regular file")
        require(info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                "operator profile must be readable only by its owner")
        _protected_ancestry(source)
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PolicyResolutionError(f"cannot read operator profile: {exc}") from exc
    require(isinstance(value, dict), "operator profile must be a JSON object")
    return value


def _labels(value: Any, name: str) -> list[str]:
    require(isinstance(value, list) and all(isinstance(item, str) and item for item in value),
            f"{name} must be a list of non-empty label names")
    require(len(value) == len(set(value)), f"{name} contains duplicate labels")
    return sorted(value)


def _validate_profile(profile: dict[str, Any], default_branch: str, *, allow_publisher_review: bool) -> None:
    require(isinstance(profile, dict), "operator profile must be an object")
    require(profile.get("version") == 1, "operator profile version must be 1")
    require(isinstance(default_branch, str) and default_branch, "verified default branch required")
    tables = [profile.get(key) for key in
              ("delivery", "branches", "eligibility", "tracking", "approvals")]
    require(all(isinstance(table, dict) for table in tables),
            "operator profile is missing required policy tables")
    delivery, branches, eligibility, tracking, approvals = tables
    require(delivery.get("final_target") == default_branch,
            "operator final target must match the verified default branch")
    require(branches.get("default_parent") == default_branch,
            "operator default parent must match the verified default branch")
    require(isinstance(branches.get("plan_template"), str)
            and branches["plan_template"]
            and branches["plan_template"] == branches.get("implementation_template"),
            "plan and implementation must reuse one operator-owned delivery branch")
    _labels(eligibility.get("required_labels", []), "operator required_labels")
    excluded = _labels(eligibility.get("excluded_labels", []), "operator excluded_labels")
    require(EXCLUSION_FLOOR <= {name.casefold() for name in excluded},
            "operator excluded_labels must include blocked, duplicate, invalid, wontfix and deferred")
    require(isinstance(tracking.get("review_label"), str) and tracking["review_label"],
            "operator review label required")
    for stage in ("plan", "implementation"):
        stage_policy = approvals.get(stage)
        require(isinstance(stage_policy, dict), f"operator {stage} approval policy required")
        minimum = stage_policy.get("minimum")
        reviewers = stage_policy.get("reviewer_ids")
        require(type(minimum) is int and minimum >= 1,
                f"operator {stage} approval minimum must require a human")
        require(isinstance(reviewers, list) and len(reviewers) == len(set(reviewers))
                and all(type(item) is int and item > 0 for item in reviewers),
                f"invalid operator {stage} reviewers")
    publisher = delivery.get("publisher_id")
    if publisher is not None:
        require(type(publisher) is int and publisher > 0, "invalid operator publisher_id")
        require(allow_publisher_review or all(publisher not in approvals[stage]["reviewer_ids"]
                    for stage in ("plan", "implementation")),
                "publisher cannot be an authorized reviewer")


def _constraints(profile: dict[str, Any]) -> dict[str, Any]:
    raw = profile.get("_override_constraints", {})
    require(isinstance(raw, dict), "invalid operator override constraints")
    allowed = {"required_labels", "additional_excluded_labels", "review_labels"}
    require(set(raw).issubset(allowed), "unknown operator override constraint")
    required = raw.get("required_labels")
    return {
        "required_labels": None if required is None else set(_labels(required, "allowed required_labels")),
        "additional_excluded_labels": set(_labels(
            raw.get("additional_excluded_labels", []), "allowed additional_excluded_labels")),
        "review_labels": set(_labels(
            raw.get("review_labels", [profile["tracking"]["review_label"]]),
            "allowed review_labels")),
    }


def _flatten(value: dict[str, Any], prefix: tuple[str, ...] = ()):
    for key, item in value.items():
        path = (*prefix, key)
        if isinstance(item, dict):
            yield from _flatten(item, path)
        else:
            yield path, item


def _at(value: dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = value
    for key in path:
        require(isinstance(current, dict) and key in current,
                f"repository policy declares unknown field {'.'.join(path)}")
        current = current[key]
    return current


def _validate_override_shape(override: dict[str, Any], operator: dict[str, Any],
                             prefix: tuple[str, ...] = ()) -> None:
    for key, item in override.items():
        path = (*prefix, key)
        expected = _at(operator, path)
        if isinstance(item, dict):
            require(isinstance(expected, dict),
                    f"repository policy type mismatch for {'.'.join(path)}")
            _validate_override_shape(item, operator, path)


def resolve(profile: dict[str, Any], *, default_branch: str, base_sha: str,
            override_bytes: bytes | None, contents_access_verified: bool,
            allow_publisher_review: bool = False) -> dict[str, Any]:
    """Resolve immutable defaults plus one constrained repository override."""
    require(contents_access_verified, "pinned repository contents access was not established")
    require(isinstance(base_sha, str) and FULL_SHA.fullmatch(base_sha) is not None,
            "base SHA must be a full lowercase SHA")
    normalized = deepcopy(profile)
    for table, key in (("delivery", "final_target"), ("branches", "default_parent")):
        if isinstance(normalized.get(table), dict) and normalized[table].get(key) in (None, "$default"):
            normalized[table][key] = default_branch
    _validate_profile(normalized, default_branch, allow_publisher_review=allow_publisher_review)
    limits = _constraints(normalized)
    values = deepcopy({key: value for key, value in normalized.items() if not key.startswith("_")})
    profile_digest = digest(canonical_json(profile))
    override_digest = None

    if override_bytes is not None:
        require(isinstance(override_bytes, bytes), "repository policy must be bytes")
        override_digest = digest(override_bytes)
        try:
            override = tomllib.loads(override_bytes.decode("utf-8"))
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
            raise PolicyResolutionError(f"invalid repository policy TOML: {exc}") from exc
        require(override.get("version") == 1, "repository policy version must be 1")
        require(all(isinstance(key, str) and not key.startswith("_") for key in override),
                "repository policy contains a reserved field")
        _validate_override_shape(override, values)
        for path, item in _flatten(override):
            if path == ("version",):
                continue
            operator_item = _at(values, path)
            if path not in OVERRIDABLE:
                require(type(item) is type(operator_item) and item == operator_item,
                        f"repository policy conflicts with protected field {'.'.join(path)}")
                continue
            if path[1] == "required_labels":
                item = _labels(item, "repository required_labels")
                allowed = limits["required_labels"]
                require(allowed is None or set(item).issubset(allowed),
                        "repository required_labels exceed operator constraints")
            elif path[1] == "excluded_labels":
                item = _labels(item, "repository excluded_labels")
                floor = set(normalized["eligibility"]["excluded_labels"])
                require(floor.issubset(item), "repository policy may not remove protected exclusions")
                require(set(item).issubset(floor | limits["additional_excluded_labels"]),
                        "repository excluded_labels exceed operator constraints")
            else:
                require(isinstance(item, str) and item in limits["review_labels"],
                        "repository review_label exceeds operator constraints")
            values[path[0]][path[1]] = item

    effective_digest = digest(canonical_json(values))
    provenance = {
        "profile_digest": profile_digest,
        "override_present": override_bytes is not None,
        "override_digest": override_digest,
        "effective_digest": effective_digest,
        "base_ref": default_branch,
        "base_sha": base_sha,
    }
    values["_source"] = {
        "ref": f"refs/heads/{default_branch}", "sha": base_sha,
        "digest": effective_digest,
        "source": "default-branch-override" if override_bytes is not None else "operator-defaults",
        **provenance,
    }
    return {
        "values": values,
        "source": "default-branch-override" if override_bytes is not None else "operator-defaults",
        "provenance": provenance,
        "summary": summary(values),
    }


def resolve_at(profile: dict[str, Any], *, default_branch: str, base_sha: str,
               read: Callable[..., Any], allow_publisher_review: bool = False) -> dict[str, Any]:
    """Read the optional policy at a pinned commit, then use ``resolve``.

    ``read`` accepts a repository-relative REST endpoint and ``missing=True``.
    A missing policy is trusted only after a successful pinned root contents read.
    """
    endpoint = f"/contents/.github/delivery.toml?ref={base_sha}"
    source = read(endpoint, missing=True)
    if source is None:
        root = read(f"/contents?ref={base_sha}")
        require(isinstance(root, list), "cannot establish access to pinned repository contents")
        override = None
    else:
        require(isinstance(source, dict) and source.get("type") == "file"
                and source.get("encoding") == "base64" and isinstance(source.get("content"), str),
                "unreadable repository delivery policy")
        try:
            override = base64.b64decode("".join(source["content"].split()), validate=True)
        except ValueError as exc:
            raise PolicyResolutionError("invalid repository delivery policy encoding") from exc
    return resolve(profile, default_branch=default_branch, base_sha=base_sha,
                   override_bytes=override, contents_access_verified=True,
                   allow_publisher_review=allow_publisher_review)


def summary(values: dict[str, Any]) -> dict[str, Any]:
    """Return safe preview output and publication blockers."""
    blockers = []
    publisher = values["delivery"].get("publisher_id")
    if type(publisher) is not int or publisher <= 0:
        blockers.append("missing_publisher_identity")
    approvals = {}
    for stage in ("plan", "implementation"):
        stage_policy = values["approvals"][stage]
        approvals[stage] = {"minimum": stage_policy["minimum"],
                            "reviewer_ids": list(stage_policy["reviewer_ids"])}
        if len(stage_policy["reviewer_ids"]) < stage_policy["minimum"]:
            blockers.append(f"missing_{stage}_reviewers")
    return {
        "required_labels": sorted(values["eligibility"].get("required_labels", [])),
        "excluded_labels": sorted(values["eligibility"].get("excluded_labels", [])),
        "tracking_label": values["tracking"]["review_label"],
        "approvals": approvals,
        "publication_ready": not blockers,
        "publication_blockers": blockers,
    }
