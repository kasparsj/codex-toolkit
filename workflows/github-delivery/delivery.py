#!/usr/bin/env python3
"""Trusted, resumable GitHub delivery coordinator (Python standard library only).

The coordinator deliberately separates agent-produced manifests from publisher
operations.  It does not execute prose and never passes manifest fields through
a shell.  A real GitHub transport is intentionally not embedded: an operator
must provide a separately isolated publisher launcher after the local workflow
has produced and validated its write intents.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from typing import Any, Iterator

SCHEMA_VERSION = 1
STAGES = ("rank", "plan", "implement", "finalize", "closeout")
STATUS_VALUES = {
    "claimed", "rank_required", "plan_required", "plan_review", "implementation_required",
    "implementation_review", "publication_pending", "review_ready",
    "ci_waiting", "blocked", "completed",
}
SKILLS = ("next-issue", "plan-pr", "implement-plan", "pr-closeout")
WRITE_KINDS = ("push", "create_pr", "edit_pr", "mark_ready", "track_issue")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^(?:[A-Za-z0-9.-]+/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SPEC_KIT_PIN = "55264c2f2f2d1146f02abc543cb913dcdf1f9342"


class DeliveryError(RuntimeError):
    pass


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise DeliveryError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DeliveryError(f"JSON object required: {path}")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


@contextlib.contextmanager
def mutex(path: Path) -> Iterator[None]:
    try:
        path.mkdir(parents=True)
    except FileExistsError as exc:
        raise DeliveryError(f"delivery mutex busy: {path}") from exc
    try:
        atomic_json(path / "owner.json", {"pid": os.getpid(), "created_at": utc_now()})
        yield
    finally:
        shutil.rmtree(path, ignore_errors=True)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise DeliveryError("timestamp must include timezone")
    return parsed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DeliveryError(message)


def validate_repo(repo: str) -> None:
    require(bool(REPO.fullmatch(repo)), "repo must be [host/]owner/name")


def repo_identity(repo: str) -> str:
    validate_repo(repo)
    repo = repo.lower()
    return f"github.com/{repo}" if repo.count("/") == 1 else repo


def validate_ref(ref: str) -> None:
    require(bool(ref) and not ref.startswith("-") and ".." not in ref and " " not in ref,
            f"unsafe ref: {ref!r}")


def validate_delivery_id(delivery_id: str) -> None:
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", delivery_id)),
            "invalid delivery ID")


def load_policy(path: Path, *, expected_digest: str, source_ref: str,
                source_sha: str, fetched_at: str, now: dt.datetime | None = None) -> dict[str, Any]:
    raw = path.read_bytes()
    require(digest_bytes(raw) == expected_digest, "policy digest mismatch")
    require(bool(FULL_SHA.fullmatch(source_sha)), "policy source SHA must be full lowercase SHA")
    validate_ref(source_ref)
    try:
        policy = tomllib.loads(raw.decode())
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise DeliveryError(f"invalid policy TOML: {exc}") from exc
    require(policy.get("version") == 1, "policy version must be 1")
    delivery = policy.get("delivery", {})
    branches = policy.get("branches", {})
    eligibility = policy.get("eligibility", {})
    approvals = policy.get("approvals", {})
    require(isinstance(delivery, dict) and isinstance(branches, dict), "policy tables missing")
    require(isinstance(eligibility, dict) and isinstance(approvals, dict), "policy tables missing")
    for key in ("final_target", "default_parent", "plan_template", "implementation_template"):
        table = delivery if key == "final_target" else branches
        require(isinstance(table.get(key), str) and bool(table[key]), f"policy {key} required")
    validate_ref(delivery["final_target"])
    validate_ref(branches["default_parent"])
    for key in ("required_labels", "excluded_labels"):
        require(all(isinstance(x, str) and x for x in eligibility.get(key, [])), f"invalid {key}")
    require(all(isinstance(x, str) and x for x in branches.get("allowed_parent_prefixes", [])),
            "invalid allowed_parent_prefixes")
    for stage in ("plan", "implementation"):
        cfg = approvals.get(stage, {})
        require(isinstance(cfg.get("minimum"), int) and cfg["minimum"] >= 0,
                f"approval minimum missing for {stage}")
        ids = cfg.get("reviewer_ids", [])
        require(len(ids) == len(set(ids)) and all(isinstance(x, int) and x > 0 for x in ids),
                f"invalid reviewer_ids for {stage}")
        require(cfg["minimum"] <= len(ids), f"approval minimum exceeds reviewers for {stage}")
    publisher = delivery.get("publisher_id")
    require(isinstance(publisher, int) and publisher > 0, "publisher_id required")
    require(all(publisher not in approvals[s].get("reviewer_ids", []) for s in approvals),
            "publisher cannot be an authorized reviewer")
    max_age = delivery.get("policy_max_age_seconds", 86400)
    require(isinstance(max_age, int) and max_age > 0, "invalid policy_max_age_seconds")
    current = now or dt.datetime.now(dt.timezone.utc)
    require((current - parse_time(fetched_at)).total_seconds() <= max_age, "policy is stale")
    policy["_source"] = {"ref": source_ref, "sha": source_sha, "digest": expected_digest,
                         "fetched_at": fetched_at}
    return policy


def policy_requirements(policy: dict[str, Any], escalation: dict[str, int] | None = None) -> dict[str, int]:
    result = {stage: policy["approvals"][stage]["minimum"] for stage in ("plan", "implementation")}
    for stage, value in (escalation or {}).items():
        require(stage in result and isinstance(value, int), "invalid escalation")
        require(value >= result[stage], "workflow escalation cannot lower policy requirements")
        require(value <= len(policy["approvals"][stage]["reviewer_ids"]), "escalation exceeds reviewers")
        result[stage] = value
    return result


def skill_hashes(skills_root: Path) -> dict[str, str]:
    hashes = {}
    for skill in SKILLS:
        path = skills_root / skill / "SKILL.md"
        require(path.is_file(), f"missing pinned skill: {path}")
        hashes[skill] = digest_bytes(path.read_bytes())
    return hashes


def adapter_hashes() -> dict[str, str]:
    root = Path(__file__).resolve().parent
    names = ("delivery.py", "adapter.py", "publisher_adapter.py", "publisher.py",
             "trusted_git.py", "workflow.yaml")
    return {name: digest_bytes((root / name).read_bytes()) for name in names}


def validate_manifest(manifest: dict[str, Any], kind: str) -> None:
    require(manifest.get("schema_version") == SCHEMA_VERSION, "manifest schema_version must be 1")
    require(manifest.get("kind") == kind, f"manifest kind must be {kind}")
    require(isinstance(manifest.get("delivery_id"), str), "manifest delivery_id required")
    require(isinstance(manifest.get("repo"), str), "manifest repo required")
    require(isinstance(manifest.get("result"), dict), "manifest result object required")
    allowed = {
        "rank": {"winner", "no_candidate", "shortlist"},
        "plan": {"artifact_paths", "artifact_hashes", "plan_revision", "issue", "baseline", "base"},
        "implement": {"candidate_sha", "artifact_paths", "verification", "issue", "base"},
        "closeout": {"status", "head_sha", "base_sha", "checks"},
    }[kind]
    require(set(manifest["result"]) <= allowed, f"unexpected {kind} manifest fields")


def validate_agent_environment(env: dict[str, str], scratch: Path) -> None:
    require(env.get("DELIVERY_AGENT_ISOLATED") == "1", "agent launcher isolation marker missing")
    forbidden = ("GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK",
                 "GIT_ASKPASS", "SSH_ASKPASS")
    present = [name for name in forbidden if env.get(name)]
    require(not present, f"agent environment contains write credentials: {', '.join(present)}")
    home = Path(env.get("HOME", "")).resolve()
    config = Path(env.get("GH_CONFIG_DIR", home / ".config" / "gh")).resolve()
    scratch = scratch.resolve()
    require(home == scratch or scratch in home.parents, "isolated HOME must be under scratch")
    require(config == scratch or scratch in config.parents, "GH_CONFIG_DIR must be under scratch")
    require(not (config / "hosts.yml").exists(), "gh credential file present in agent environment")


def review_body(stage: str, generation: int, context_digest: str, decision: str) -> str:
    return f"delivery-review {stage} {generation} {context_digest} {decision}"


def review_context(*, stage: str, generation: int, issue: int, material_hashes: dict[str, str],
                   baseline_sha: str, base_repo: str, base_ref: str, base_sha: str,
                   final_repo: str, final_ref: str, policy_digest: str) -> str:
    """Digest every material fact that a stage receipt authorizes."""
    value = {"stage": stage, "generation": generation, "issue": issue,
             "material_hashes": material_hashes, "baseline_sha": baseline_sha,
             "immediate_base": {"repo": base_repo, "ref": base_ref, "sha": base_sha},
             "final_target": {"repo": final_repo, "ref": final_ref},
             "policy_digest": policy_digest}
    return digest_bytes(canonical_json(value))


def gate_route(plan_gate: bool, implementation_gate: bool, *, plan_approved: bool = False,
               implementation_approved: bool = False) -> str:
    if plan_gate and not plan_approved:
        return "plan_review"
    if implementation_gate and not implementation_approved:
        return "implementation_review"
    return "publication_pending"


def closeout_verdict(checks: list[str], *, draft: bool, merge_requested: bool = False) -> dict[str, Any]:
    """Read-only delivery status; it never performs a merge."""
    require(all(value in ("pending", "success", "failure") for value in checks), "invalid check state")
    if draft or "failure" in checks:
        status = "BLOCKED"
    elif "pending" in checks or not checks:
        status = "WAITING"
    else:
        status = "READY"
    return {"delivery_status": status, "merge_readiness": status,
            "merge_requested": merge_requested, "merge_performed": False}


def run_spec_kit(state: dict[str, Any], state_dir: Path, *, run_id: str | None = None,
                 plan_verdict: str = "", implementation_verdict: str = "",
                 runner=subprocess.run) -> dict[str, Any]:
    """Dispatch only the reviewed local YAML through the exact pinned runner."""
    workflow_dir = Path(__file__).resolve().parent
    validate_delivery_id(state["delivery_id"])
    runner_dir = state_dir.resolve() / "runner" / state["delivery_id"]
    runner_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    trusted_workflow = runner_dir / "workflow.yaml"
    source = (workflow_dir / "workflow.yaml").read_bytes()
    if trusted_workflow.exists():
        require(trusted_workflow.read_bytes() == source, "trusted workflow snapshot changed")
    else:
        fd, temporary = tempfile.mkstemp(prefix=".workflow.", dir=runner_dir)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(source); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, trusted_workflow)
        finally:
            with contextlib.suppress(FileNotFoundError): os.unlink(temporary)
    base = ["uvx", "--from", f"git+https://github.com/github/spec-kit.git@{SPEC_KIT_PIN}",
            "specify", "workflow"]
    if run_id:
        argv = base + ["resume", run_id, "--json"]
    else:
        argv = base + ["run", "workflow.yaml", "--json"]
        manifests = state.get("manifests", {})
        publication = state.get("publication", {})
        status = state["status"]
        plan_gate = state["requirements"]["plan"] > 0 and status in (
            "rank_required", "plan_required", "plan_review",
        )
        implementation_gate = state["requirements"]["implementation"] > 0 and status in (
            "rank_required", "plan_required", "plan_review", "implementation_required",
            "implementation_review",
        )
        for key, value in (("state_dir", str(state_dir.resolve())), ("repo", state["repo"]),
                           ("delivery_id", state["delivery_id"]),
                           ("adapter_dir", str(workflow_dir)),
                           ("agent_launcher", state["agent"]["launcher"]),
                           ("publisher_launcher", state["publisher_launcher"]),
                           ("worktree", state["agent"]["worktree"]),
                           ("agent_scratch", state["agent"]["scratch"]),
                           ("skills_root", state["agent"]["skills_root"]),
                           ("run_rank", str(state.get("issue") is None).lower()),
                           ("run_plan", str("plan" not in manifests).lower()),
                           ("publish_plan", str("plan" not in publication).lower()),
                           ("run_implementation", str("implement" not in manifests).lower()),
                           ("publish_implementation", str("implementation" not in publication).lower()),
                           ("finalize", str("final" not in publication).lower()),
                           ("plan_gate", str(plan_gate).lower()),
                           ("implementation_gate", str(implementation_gate).lower())):
            argv += ["--input", f"{key}={value}"]
    if plan_verdict: argv += ["--input", f"plan_verdict={plan_verdict}"]
    if implementation_verdict: argv += ["--input", f"implementation_verdict={implementation_verdict}"]
    completed = runner(argv, cwd=runner_dir, text=True, capture_output=True, check=False)
    try: result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc: raise DeliveryError("pinned Spec Kit emitted invalid JSON") from exc
    require(result.get("workflow_id") == "github-delivery", "unexpected runner workflow identity")
    require(result.get("status") in ("paused", "completed", "failed", "aborted"), "invalid runner status")
    if completed.returncode and result.get("status") not in ("failed", "aborted"):
        raise DeliveryError(f"pinned Spec Kit runner failed: {completed.stderr.strip()}")
    return result


def evaluate_reviews(reviews: list[dict[str, Any]], *, stage: str, generation: int,
                     context_digest: str, commit_id: str, authorized_ids: list[int],
                     publisher_id: int, minimum: int) -> dict[str, Any]:
    expected = {review_body(stage, generation, context_digest, d): d for d in ("approve", "reject")}
    latest: dict[int, tuple[str, int, str]] = {}
    for review in reviews:
        rid = review.get("user", {}).get("id")
        if rid not in authorized_ids or rid == publisher_id:
            continue
        if review.get("state") != "COMMENTED" or review.get("dismissed") is True:
            continue
        if review.get("commit_id") != commit_id or review.get("body") not in expected:
            continue
        submitted = review.get("submitted_at")
        review_id = review.get("id")
        if not isinstance(submitted, str) or not isinstance(review_id, int):
            continue
        key = (submitted, review_id, expected[review["body"]])
        if rid not in latest or key[:2] > latest[rid][:2]:
            latest[rid] = key
    decisions = {rid: value[2] for rid, value in latest.items()}
    rejects = sorted(rid for rid, decision in decisions.items() if decision == "reject")
    approvals = sorted(rid for rid, decision in decisions.items() if decision == "approve")
    return {"approved": not rejects and len(approvals) >= minimum, "approvers": approvals,
            "rejectors": rejects, "minimum": minimum}


class Coordinator:
    def __init__(self, state_dir: Path):
        self.root = state_dir.resolve()

    def _repo_dir(self, repo: str) -> Path:
        return self.root / "repos" / digest_bytes(repo_identity(repo).encode())

    def _delivery_path(self, repo: str, delivery_id: str) -> Path:
        validate_delivery_id(delivery_id)
        return self._repo_dir(repo) / "deliveries" / delivery_id / "state.json"

    def start(self, *, repo: str, issue: int | None, policy: dict[str, Any],
              skills_root: Path, delivery_id: str | None = None) -> dict[str, Any]:
        validate_repo(repo)
        repo_dir = self._repo_dir(repo)
        with mutex(repo_dir / "mutex"):
            active_path = repo_dir / "active.json"
            if active_path.exists():
                active = read_json(active_path)
                if active.get("status") not in ("completed", "released"):
                    raise DeliveryError(f"active delivery already claimed: {active['delivery_id']}")
            stable = delivery_id or digest_bytes(canonical_json({"repo": repo, "issue": issue,
                "policy": policy["_source"]["digest"], "nonce": secrets.token_hex(8)}))[:24]
            validate_delivery_id(stable)
            require(issue is None or type(issue) is int and issue > 0, "invalid issue number")
            require(not self._delivery_path(repo, stable).exists(), "delivery ID already exists")
            claim = {"delivery_id": stable, "repo": repo, "issue": None, "status": "claimed",
                     "claimed_at": utc_now()}
            atomic_json(active_path, claim)  # durable claim precedes candidate selection
            claim["issue"] = issue
            state = {"schema_version": SCHEMA_VERSION, **claim, "attempt": 1,
                     "runner_pid": None, "runner_status": "idle", "policy": policy["_source"],
                     "policy_values": policy, "skill_hashes": skill_hashes(skills_root),
                     "adapter_hashes": adapter_hashes(),
                     "requirements": policy_requirements(policy), "operations": [],
                     "receipts": {}, "history": [{"event": "claimed", "at": utc_now()}],
                     "status": "plan_required" if issue is not None else "rank_required"}
            atomic_json(self._delivery_path(repo, stable), state)
            claim["status"] = "active"; atomic_json(active_path, claim)
            return state

    def load(self, repo: str, delivery_id: str) -> dict[str, Any]:
        return read_json(self._delivery_path(repo, delivery_id))

    def save(self, state: dict[str, Any]) -> None:
        atomic_json(self._delivery_path(state["repo"], state["delivery_id"]), state)

    def release(self, state: dict[str, Any]) -> None:
        active_path = self._repo_dir(state["repo"]) / "active.json"
        active = read_json(active_path)
        require(active.get("delivery_id") == state["delivery_id"], "active claim identity changed")
        atomic_json(active_path, {"delivery_id": state["delivery_id"], "repo": state["repo"],
            "issue": state.get("issue"), "status": "released", "released_at": utc_now()})

    def verify_resume(self, state: dict[str, Any], skills_root: Path) -> None:
        require(skill_hashes(skills_root) == state["skill_hashes"], "pinned skill source changed")
        require(adapter_hashes() == state["adapter_hashes"], "pinned adapter source changed")

    def accept_manifest(self, state: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
        kind = manifest.get("kind")
        require(kind in ("rank", "plan", "implement", "closeout"), "unsupported manifest kind")
        validate_manifest(manifest, kind)
        require(manifest["delivery_id"] == state["delivery_id"], "manifest delivery mismatch")
        require(manifest["repo"] == state["repo"], "manifest repository mismatch")
        manifest_digest = digest_bytes(canonical_json(manifest))
        previous = state.get("manifests", {}).get(kind)
        material = dict(manifest["result"])
        if kind == "implement":
            material.pop("verification", None)
        if kind in ("plan", "implement"):
            material["artifact_paths"] = sorted(material.get("artifact_paths", []))
        material_digest = digest_bytes(canonical_json(material))
        generation = previous["generation"] if previous and previous.get("material_digest") == material_digest else (
            (previous["generation"] + 1) if previous else 1)
        state.setdefault("manifests", {})[kind] = {
            "digest": manifest_digest, "material_digest": material_digest,
            "generation": generation, "value": manifest,
            "accepted_at": utc_now(),
        }
        if kind == "rank":
            result = manifest["result"]
            if result.get("no_candidate"):
                state["status"] = "completed"
                active = {"delivery_id": state["delivery_id"], "repo": state["repo"], "issue": None,
                          "status": "released", "released_at": utc_now()}
                atomic_json(self._repo_dir(state["repo"]) / "active.json", active)
            else:
                require(isinstance(result.get("winner"), int) and result["winner"] > 0,
                        "rank manifest requires winner or no_candidate")
                state["issue"] = result["winner"]; state["status"] = "plan_required"
        elif kind == "plan":
            minimum = state["requirements"]["plan"]
            state["status"] = "plan_review" if minimum else "implementation_required"
        elif kind == "implement":
            minimum = state["requirements"]["implementation"]
            state["status"] = "implementation_review" if minimum else "publication_pending"
        else:
            result = manifest["result"]
            published = state.get("publication", {}).get("final", {}).get("pr")
            if published:
                require(result.get("head_sha") == published["head_sha"]
                        and result.get("base_sha") == published["base_sha"],
                        "closeout revisions differ from verified publication")
            verdict = result.get("status")
            require(verdict in ("READY", "WAITING", "BLOCKED"), "invalid closeout status")
            state["status"] = {"READY": "review_ready", "WAITING": "ci_waiting", "BLOCKED": "blocked"}[verdict]
        state["history"].append({"event": f"{kind}_manifest", "generation": generation,
                                 "digest": manifest_digest, "at": utc_now()})
        self.save(state)
        if kind == "closeout" and state["status"] == "review_ready":
            self.release(state)
        return state

    def recover(self, state: dict[str, Any], *, old_pid_alive: bool) -> dict[str, Any]:
        require(state["runner_status"] == "running", "recover requires stranded running state")
        require(not old_pid_alive, "old runner process is still alive")
        state["attempt"] += 1
        state["runner_status"] = "idle"
        state["runner_pid"] = None
        state["history"].append({"event": "recovered", "attempt": state["attempt"], "at": utc_now()})
        self.save(state)
        return state

    def publish(self, state: dict[str, Any], transport: Any, kind: str,
                payload: dict[str, Any]) -> dict[str, Any]:
        require(kind in WRITE_KINDS, "write kind not allowlisted")
        require(payload.get("repo") == state["repo"], "write escapes verified target repository")
        op_id = digest_bytes(canonical_json({"kind": kind, "payload": payload}))[:20]
        existing = next((op for op in state["operations"] if op["id"] == op_id), None)
        if existing and existing["status"] == "completed":
            return existing["receipt"]
        if existing is None:
            existing = {"id": op_id, "kind": kind, "payload": payload, "status": "intent",
                        "recorded_at": utc_now()}
            state["operations"].append(existing); self.save(state)
        if kind == "create_pr":
            matches = transport.find_prs(payload)
            require(len(matches) <= 1, "ambiguous matching PRs; refusing adoption")
            if matches:
                receipt = matches[0]
            else:
                receipt = transport.apply(kind, payload)
        else:
            receipt = transport.apply(kind, payload)
        existing["status"] = "completed"; existing["receipt"] = receipt; existing["completed_at"] = utc_now()
        self.save(state)
        return receipt


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="github-delivery")
    sub = result.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start")
    start.add_argument("--state-dir", type=Path, required=True); start.add_argument("--repo", required=True)
    start.add_argument("--issue", type=int); start.add_argument("--delivery-id")
    start.add_argument("--policy", type=Path, required=True); start.add_argument("--policy-ref", required=True)
    start.add_argument("--policy-sha", required=True); start.add_argument("--policy-digest", required=True)
    start.add_argument("--policy-fetched-at", required=True); start.add_argument("--skills-root", type=Path, required=True)
    start.add_argument("--no-dispatch", action="store_true", help=argparse.SUPPRESS)
    start.add_argument("--agent-launcher", type=Path, required=True)
    start.add_argument("--publisher-launcher", type=Path, required=True)
    start.add_argument("--worktree", type=Path, required=True); start.add_argument("--agent-scratch", type=Path, required=True)
    for name in ("status", "resume", "recover", "advance"):
        cmd = sub.add_parser(name); cmd.add_argument("--state-dir", type=Path, required=True)
        cmd.add_argument("--repo", required=True); cmd.add_argument("--delivery-id", required=True)
        if name in ("resume", "recover"): cmd.add_argument("--skills-root", type=Path, required=True)
        if name == "resume":
            cmd.add_argument("--result", type=Path)
        if name == "advance": cmd.add_argument("--stage", choices=("plan", "implementation"), required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        coordinator = Coordinator(args.state_dir)
        if args.command == "start":
            policy = load_policy(args.policy, expected_digest=args.policy_digest,
                source_ref=args.policy_ref, source_sha=args.policy_sha, fetched_at=args.policy_fetched_at)
            value = coordinator.start(repo=args.repo, issue=args.issue, policy=policy,
                                      skills_root=args.skills_root, delivery_id=args.delivery_id)
            value["agent"] = {"launcher": str(args.agent_launcher.resolve()),
                              "worktree": str(args.worktree.resolve()),
                              "scratch": str(args.agent_scratch.resolve()),
                              "skills_root": str(args.skills_root.resolve())}
            value["publisher_launcher"] = str(args.publisher_launcher.resolve())
            coordinator.save(value)
            if not args.no_dispatch:
                value["runner_status"] = "running"; value["runner_pid"] = os.getpid(); coordinator.save(value)
                runner_result = run_spec_kit(value, args.state_dir)
                value = coordinator.load(args.repo, value["delivery_id"])
                value["runner"] = runner_result; value["runner_status"] = runner_result["status"]
                value["runner_pid"] = None
                value["runner_run_id"] = runner_result["run_id"]; coordinator.save(value)
        else:
            value = coordinator.load(args.repo, args.delivery_id)
            if args.command == "resume":
                coordinator.verify_resume(value, args.skills_root)
                if args.result:
                    value = coordinator.accept_manifest(value, read_json(args.result))
                current = value.get("runner", {}).get("current_step_id")
                stage = "plan" if current == "plan-review" else (
                    "implementation" if current == "implementation-review" else None)
                if stage:
                    import publisher_adapter
                    value, verdict = publisher_adapter.check_approval(
                        value, Path(value["publisher_launcher"]), stage)
                    coordinator.save(value)
                    if verdict != "pending":
                        value["runner_status"] = "running"; value["runner_pid"] = os.getpid(); coordinator.save(value)
                        runner_result = run_spec_kit(value, args.state_dir, run_id=value["runner_run_id"],
                            plan_verdict=verdict if stage == "plan" else "",
                            implementation_verdict=verdict if stage == "implementation" else "")
                        value = coordinator.load(args.repo, args.delivery_id)
                        value["runner"] = runner_result; value["runner_status"] = runner_result["status"]
                        value["runner_pid"] = None; coordinator.save(value)
                elif value.get("runner_status") == "failed" and value.get("runner_run_id"):
                    value["runner_status"] = "running"; value["runner_pid"] = os.getpid(); coordinator.save(value)
                    runner_result = run_spec_kit(value, args.state_dir, run_id=value["runner_run_id"])
                    value = coordinator.load(args.repo, args.delivery_id)
                    value["runner"] = runner_result; value["runner_status"] = runner_result["status"]
                    value["runner_pid"] = None; coordinator.save(value)
                elif value.get("runner_status") == "completed" and value.get("status") == "ci_waiting":
                    import adapter
                    manifest = adapter.run_agent(launcher=Path(value["agent"]["launcher"]), kind="closeout",
                        state=value, skills_root=Path(value["agent"]["skills_root"]),
                        worktree=Path(value["agent"]["worktree"]),
                        scratch=Path(value["agent"]["scratch"]) / "closeout-resume")
                    value = coordinator.accept_manifest(value, manifest)
            elif args.command == "recover":
                coordinator.verify_resume(value, args.skills_root)
                pid = value.get("runner_pid")
                alive = bool(pid) and _pid_alive(pid)
                value = coordinator.recover(value, old_pid_alive=alive)
                value["runner_status"] = "running"; value["runner_pid"] = os.getpid(); coordinator.save(value)
                runner_result = run_spec_kit(value, args.state_dir)
                value = coordinator.load(args.repo, args.delivery_id)
                value["runner"] = runner_result; value["runner_status"] = runner_result["status"]
                value["runner_pid"] = None; value["runner_run_id"] = runner_result["run_id"]
                coordinator.save(value)
            elif args.command == "advance":
                expected = "plan_review" if args.stage == "plan" else "implementation_review"
                target = "implementation_required" if args.stage == "plan" else "publication_pending"
                require(value["status"] == expected, f"cannot advance {args.stage} from {value['status']}")
                value["status"] = target
                value["history"].append({"event": f"{args.stage}_runner_gate_completed", "at": utc_now()})
                coordinator.save(value)
        print(json.dumps(value, sort_keys=True))
        return 0
    except (DeliveryError, OSError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True))
        return 2


def _pid_alive(pid: int) -> bool:
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    except PermissionError: return True
    return True


if __name__ == "__main__":
    raise SystemExit(main())
