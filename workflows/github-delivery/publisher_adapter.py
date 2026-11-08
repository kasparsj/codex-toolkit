#!/usr/bin/env python3
"""Trusted publisher-launcher adapter and approval verifier."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess

import delivery


def call_launcher(launcher: Path, packet: dict) -> dict:
    delivery.require(launcher.is_file() and os.access(launcher, os.X_OK),
                     "publisher launcher must be executable")
    env = dict(os.environ)
    env["DELIVERY_PUBLISHER_ISOLATED"] = "1"
    completed = subprocess.run([str(launcher)], input=json.dumps(packet), text=True,
                               capture_output=True, env=env, check=False)
    if completed.returncode:
        raise delivery.DeliveryError(f"publisher launcher failed: {completed.stderr.strip()}")
    try: result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc: raise delivery.DeliveryError("publisher launcher emitted invalid JSON") from exc
    delivery.require(isinstance(result, dict) and result.get("schema_version") == 1,
                     "invalid publisher response schema")
    delivery.require(result.get("action") == packet["action"], "publisher action mismatch")
    return result


def call_mutation(state: dict, launcher: Path, packet: dict, save) -> dict:
    op_id = delivery.digest_bytes(delivery.canonical_json(packet))[:20]
    packet = {**packet, "operation_id": op_id}
    operation = next((item for item in state["operations"] if item["id"] == op_id), None)
    if operation and operation["status"] == "completed":
        return operation["receipt"]
    if operation is None:
        operation = {"id": op_id, "kind": packet["action"], "payload": packet,
                     "status": "intent", "recorded_at": delivery.utc_now()}
        state["operations"].append(operation); save(state)
    response = call_launcher(launcher, packet)
    operation["status"] = "completed"; operation["receipt"] = response
    operation["completed_at"] = delivery.utc_now(); save(state)
    return response


def expected_publication(state: dict, stage: str) -> dict:
    issue = state.get("issue"); delivery.require(isinstance(issue, int), "issue required for publication")
    record = state.get("manifests", {}).get("plan" if stage == "plan" else "implement")
    delivery.require(record is not None, f"{stage} manifest missing")
    result = record["value"]["result"]
    policy = state["policy_values"]
    if stage == "plan":
        sha = result.get("plan_revision"); base_info = result.get("baseline", {})
        template = policy["branches"]["plan_template"]
    else:
        sha = result.get("candidate_sha"); base_info = result.get("base", {})
        template = policy["branches"]["implementation_template"]
    delivery.require(isinstance(sha, str) and delivery.FULL_SHA.fullmatch(sha), f"{stage} SHA invalid")
    base = base_info.get("ref"); delivery.require(isinstance(base, str), f"{stage} base ref missing")
    base_sha = base_info.get("sha"); delivery.require(isinstance(base_sha, str) and delivery.FULL_SHA.fullmatch(base_sha),
                                                      f"{stage} base SHA missing")
    delivery.validate_ref(base)
    prefixes = policy["branches"].get("allowed_parent_prefixes", [])
    delivery.require(any(base == prefix or base.startswith(prefix) for prefix in prefixes),
                     "publication base is not policy-allowed")
    head = template.format(issue=issue); delivery.validate_ref(head)
    return {"repo": state["repo"], "issue": issue, "head": head, "head_sha": sha,
            "base": base, "base_sha": base_sha,
            "generation": record["generation"], "manifest_digest": record["digest"],
            "plan_revision": state.get("manifests", {}).get("plan", {}).get("value", {}).get("result", {}).get("plan_revision")}


def validate_pr(pr: dict, expected: dict, *, draft: bool) -> None:
    delivery.require(isinstance(pr.get("number"), int) and pr["number"] > 0, "publisher PR number invalid")
    if "number" in expected:
        delivery.require(pr["number"] == expected["number"], "publisher PR number mismatch")
    for key in ("repo", "head", "head_sha", "base", "base_sha"):
        delivery.require(pr.get(key) == expected[key], f"publisher PR {key} mismatch")
    delivery.require(pr.get("draft") is draft and pr.get("state") == "OPEN", "publisher PR state mismatch")


def publish(state: dict, launcher: Path, stage: str, save=lambda _state: None) -> dict:
    allowed = {"plan": {"plan_review", "implementation_required"},
               "implementation": {"implementation_review", "publication_pending"}}
    delivery.require(state["status"] in allowed[stage], f"publish {stage} is out of order")
    expected = expected_publication(state, stage)
    packet = {"schema_version": 1, "action": f"publish_{stage}", "delivery_id": state["delivery_id"],
              "expected": expected, "policy": state["policy"],
              "prior_pr": state.get("publication", {}).get("plan", {}).get("pr"),
              "worktree": state["agent"]["worktree"]}
    response = call_mutation(state, launcher, packet, save); validate_pr(response.get("pr", {}), expected, draft=True)
    state.setdefault("publication", {})[stage] = {"pr": response["pr"], "published_at": delivery.utc_now(),
        "generation": expected["generation"], "manifest_digest": expected["manifest_digest"]}
    return state


def approval_context(state: dict, stage: str) -> tuple[str, dict, str]:
    publication = state.get("publication", {}).get(stage)
    delivery.require(publication is not None, f"{stage} publication missing")
    kind = "plan" if stage == "plan" else "implement"
    manifest = state["manifests"][kind]
    result = manifest["value"]["result"]
    pr = publication["pr"]
    if stage == "plan":
        hashes = result.get("artifact_hashes", {}); baseline = result["baseline"]
    else:
        hashes = {path: result["candidate_sha"] for path in result.get("artifact_paths", [])}
        baseline = result["base"]
    context = delivery.review_context(stage=stage, generation=manifest["generation"], issue=state["issue"],
        material_hashes=hashes, baseline_sha=baseline["sha"], base_repo=pr["repo"],
        base_ref=pr["base"], base_sha=baseline["sha"], final_repo=state["repo"],
        final_ref=state["policy_values"]["delivery"]["final_target"], policy_digest=state["policy"]["digest"])
    return context, pr, pr["head_sha"]


def check_approval(state: dict, launcher: Path, stage: str) -> tuple[dict, str]:
    context, pr, commit_id = approval_context(state, stage)
    packet = {"schema_version": 1, "action": "list_reviews", "delivery_id": state["delivery_id"],
              "stage": stage, "pr": pr, "context_digest": context,
              "generation": state["manifests"]["plan" if stage == "plan" else "implement"]["generation"]}
    response = call_launcher(launcher, packet)
    delivery.require(response.get("paginated") is True, "publisher did not prove review pagination")
    validate_pr(response.get("pr", {}), pr, draft=True)
    config = state["policy_values"]["approvals"][stage]
    verdict = delivery.evaluate_reviews(response.get("reviews", []), stage=stage,
        generation=packet["generation"], context_digest=context, commit_id=commit_id,
        authorized_ids=config["reviewer_ids"], publisher_id=state["policy_values"]["delivery"]["publisher_id"],
        minimum=state["requirements"][stage])
    state.setdefault("receipts", {})[stage] = {**verdict, "context_digest": context,
        "commit_id": commit_id, "checked_at": delivery.utc_now()}
    if verdict["approved"]: return state, "approve"
    if verdict["rejectors"]: return state, "reject"
    return state, "pending"


def finalize(state: dict, launcher: Path, save=lambda _state: None) -> dict:
    delivery.require(state["status"] == "publication_pending", "finalize is out of order")
    receipt = state.get("receipts", {}).get("implementation", {})
    delivery.require(state["requirements"]["implementation"] == 0 or receipt.get("approved") is True,
                     "implementation approval missing")
    publication = state.get("publication", {}).get("implementation")
    delivery.require(publication is not None, "implementation publication missing")
    label = state["policy_values"].get("tracking", {}).get("review_label")
    delivery.require(isinstance(label, str) and label, "policy existing review label mapping missing")
    packet = {"schema_version": 1, "action": "finalize", "delivery_id": state["delivery_id"],
              "pr": publication["pr"], "issue": state["issue"], "existing_review_label": label}
    response = call_mutation(state, launcher, packet, save)
    expected = dict(publication["pr"]); validate_pr(response.get("pr", {}), expected, draft=False)
    delivery.require(response.get("issue", {}).get("number") == state["issue"], "issue readback mismatch")
    delivery.require(label in response.get("issue", {}).get("labels", []), "review label readback missing")
    state["status"] = "review_ready"; state["publication"]["final"] = response
    return state


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="command", required=True)
    for name in ("publish-plan", "publish-implementation", "check-plan", "check-implementation", "finalize"):
        cmd = sub.add_parser(name); cmd.add_argument("--state-dir", type=Path, required=True)
        cmd.add_argument("--repo", required=True); cmd.add_argument("--delivery-id", required=True)
        cmd.add_argument("--launcher", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        coordinator = delivery.Coordinator(args.state_dir); state = coordinator.load(args.repo, args.delivery_id)
        if args.command.startswith("publish-"):
            state = publish(state, args.launcher.resolve(), args.command.removeprefix("publish-"), coordinator.save)
            verdict = None
        elif args.command.startswith("check-"):
            state, verdict = check_approval(state, args.launcher.resolve(), args.command.removeprefix("check-"))
        else:
            state = finalize(state, args.launcher.resolve(), coordinator.save); verdict = None
        coordinator.save(state); print(json.dumps({"status": state["status"], "verdict": verdict}, sort_keys=True)); return 0
    except (delivery.DeliveryError, OSError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True)); return 2


if __name__ == "__main__": raise SystemExit(main())
