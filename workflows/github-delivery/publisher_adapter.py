#!/usr/bin/env python3
"""Trusted publisher-launcher adapter and approval verifier."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess

import delivery


def call_launcher(launcher: Path, packet: dict, *, app: dict | None = None) -> dict:
    delivery.require(launcher.is_file() and os.access(launcher, os.X_OK),
                     "publisher launcher must be executable")
    if app is None:
        env = dict(os.environ)
    else:
        env = {key: os.environ[key] for key in ("PATH", "DELIVERY_PUBLISHER_FAULT_AFTER")
               if key in os.environ}
        env.update(DELIVERY_APP_CONFIG=app["config"], DELIVERY_PUBLISHER_ROOT=app["publisher_root"],
                   DELIVERY_PUBLISHER_REPO=packet["target_repo"])
    env["DELIVERY_PUBLISHER_ISOLATED"] = "1"
    completed = subprocess.run([str(launcher)], input=json.dumps(packet), text=True,
                               capture_output=True, env=env, check=False)
    if completed.returncode:
        try:
            detail = json.loads(completed.stdout).get("error")
        except (AttributeError, json.JSONDecodeError):
            detail = None
        diagnostic = detail or ("App publisher interrupted" if app else completed.stderr.strip())
        raise delivery.DeliveryError(f"publisher launcher failed: {diagnostic}")
    try: result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc: raise delivery.DeliveryError("publisher launcher emitted invalid JSON") from exc
    delivery.require(isinstance(result, dict) and result.get("schema_version") == 1,
                     "invalid publisher response schema")
    delivery.require(result.get("action") == packet["action"], "publisher action mismatch")
    return result


def call_mutation(state: dict, launcher: Path, packet: dict, save, validate, *, transport_options=None) -> dict:
    op_id = delivery.digest_bytes(delivery.canonical_json(packet))[:20]
    if packet.get("credential_mode") == "app" and packet["action"] == "finalize" and state["status"] == "tracking_pending":
        # A verified binding upgrade can change the credential digest after mark-ready.
        # Resume the original write intents only when every other request field matches.
        pending = [item for item in state["operations"]
                   if item["kind"] == "finalize" and item["status"] == "intent"]
        delivery.require(len(pending) == 1, "tracking requires one pending finalization intent")
        recorded = pending[0]["payload"]
        previous = {key: value for key, value in recorded.items()
                    if key not in {"operation_id", "app_binding_digest"}}
        current = {key: value for key, value in packet.items() if key != "app_binding_digest"}
        delivery.require(previous == current, "tracking request differs from the pending finalization intent")
        op_id = pending[0]["id"]
    packet = {**packet, "operation_id": op_id}
    operation = next((item for item in state["operations"] if item["id"] == op_id), None)
    if operation is None:
        operation = {"id": op_id, "kind": packet["action"], "payload": packet,
                     "status": "intent", "recorded_at": delivery.utc_now()}
        state["operations"].append(operation); save(state)
    response = call_launcher(launcher, {**packet, **(transport_options or {})},
                             **({"app": state["app"]} if "app" in state else {}))
    validate(response)
    if state.get("credential_mode") == "app" and packet["action"] == "finalize" and (
            response.get("status") != "review_ready"):
        return response
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
        sha = result.get("plan_revision"); base_info = result.get("base", result.get("baseline", {}))
        template = policy["branches"]["plan_template"]
    else:
        sha = result.get("candidate_sha"); base_info = result.get("base", {})
        template = policy["branches"]["implementation_template"]
    delivery.require(isinstance(sha, str) and delivery.FULL_SHA.fullmatch(sha), f"{stage} SHA invalid")
    base = base_info.get("ref"); delivery.require(isinstance(base, str), f"{stage} base ref missing")
    base_sha = base_info.get("sha"); delivery.require(isinstance(base_sha, str) and delivery.FULL_SHA.fullmatch(base_sha),
                                                      f"{stage} base SHA missing")
    delivery.require(delivery.repo_identity(base_info.get("repo", "")) == delivery.repo_identity(state["repo"]),
                     f"{stage} base repository mismatch")
    delivery.require(result.get("issue") == issue, f"{stage} issue mismatch")
    delivery.validate_ref(base)
    if state.get("credential_mode") == "app":
        delivery.require(base == delivery.policy_branch(state["policy"]["ref"])
                         and base_sha == state["policy"]["sha"],
                         "App candidate differs from the pinned default-branch revision")
    branches = policy["branches"]
    prefixes = branches.get("allowed_parent_prefixes", [])
    delivery.require(base == branches["default_parent"] or
                     any(base.startswith(prefix.rstrip("/") + "/") for prefix in prefixes),
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
    delivery.require(delivery.repo_identity(pr.get("repo", "")) == delivery.repo_identity(expected["repo"]),
                     "publisher PR repo mismatch")
    for key in ("head", "head_sha", "base", "base_sha"):
        delivery.require(pr.get(key) == expected[key], f"publisher PR {key} mismatch")
    delivery.require(pr.get("draft") is draft and pr.get("state") == "OPEN", "publisher PR state mismatch")


def packet_for(state: dict, action: str) -> dict:
    packet = {"schema_version": 1, "action": action, "delivery_id": state["delivery_id"],
              "target_repo": state["repo"], "policy": state["policy"],
              "policy_values": state["policy_values"]}
    if state.get("credential_mode") == "app":
        packet.update(credential_mode="app", app_binding_digest=state["app"]["digest"], issue=state["issue"])
    return packet


def publish(state: dict, launcher: Path, stage: str, save=lambda _state: None) -> dict:
    allowed = {"plan": {"plan_review", "implementation_required"},
               "implementation": {"implementation_review", "publication_pending"}}
    delivery.require(state["status"] in allowed[stage], f"publish {stage} is out of order")
    expected = expected_publication(state, stage)
    kind = "plan" if stage == "plan" else "implement"
    manifest = state["manifests"][kind]["value"]["result"]
    bundle = Path(state["agent"]["scratch"]) / kind / "candidate.bundle"
    correction = state.get("corrections", {}).get(kind)
    supersedes_pr = None
    supersedes_digest = None
    if correction is not None:
        delivery.require(isinstance(correction, dict), f"{stage} correction record is invalid")
        supersedes_pr = correction.get("pr")
        supersedes_digest = correction.get("manifest_digest")
        delivery.require(isinstance(supersedes_pr, dict), f"{stage} correction PR is invalid")
        delivery.require(
            isinstance(supersedes_digest, str) and len(supersedes_digest) == 64,
            f"{stage} correction manifest digest is invalid",
        )
    packet = {**packet_for(state, f"publish_{stage}"), "expected": expected,
              "prior_pr": state.get("publication", {}).get("plan", {}).get("pr"),
              "supersedes_pr": supersedes_pr,
              "supersedes_manifest_digest": supersedes_digest,
              "candidate": {"bundle_path": str(bundle), "paths": manifest["artifact_paths"],
                            "hashes": manifest.get("artifact_hashes")},
              "plan_approval": approval_request(state, "plan") if stage == "implementation" else None}
    def validate(result: dict) -> None:
        pr = result.get("pr", {})
        validate_pr(pr, expected, draft=True)
        if state.get("credential_mode") == "app" and stage == "implementation":
            delivery.require(pr["number"] == packet["prior_pr"]["number"]
                             and pr["node_id"] == packet["prior_pr"]["node_id"],
                             "App implementation must reuse the planning draft")

    response = call_mutation(state, launcher, packet, save, validate)
    state.setdefault("publication", {})[stage] = {"pr": response["pr"], "published_at": delivery.utc_now(),
        "generation": expected["generation"], "manifest_digest": expected["manifest_digest"]}
    if correction is not None:
        state["corrections"].pop(kind, None)
        if not state["corrections"]:
            state.pop("corrections")
    save(state)
    return state


def approval_context(state: dict, stage: str) -> tuple[str, dict, str]:
    publication = state.get("publication", {}).get(stage)
    delivery.require(publication is not None, f"{stage} publication missing")
    kind = "plan" if stage == "plan" else "implement"
    manifest = state["manifests"][kind]
    result = manifest["value"]["result"]
    pr = publication["pr"]
    expected_head = result["plan_revision" if stage == "plan" else "candidate_sha"]
    delivery.require(publication.get("generation") == manifest["generation"],
                     f"{stage} publication generation is stale")
    delivery.require(publication.get("manifest_digest") == manifest["digest"],
                     f"{stage} publication manifest is stale")
    delivery.require(pr.get("head_sha") == expected_head,
                     f"{stage} publication head is stale")
    if stage == "plan":
        paths = result.get("artifact_paths")
        artifact_hashes = result.get("artifact_hashes")
        delivery.require(
            isinstance(paths, list)
            and paths
            and isinstance(artifact_hashes, dict)
            and set(artifact_hashes) == set(paths)
            and all(
                isinstance(value, str)
                and len(value) == 64
                and all(character in "0123456789abcdef" for character in value)
                for value in artifact_hashes.values()
            ),
            "plan publication artifact hashes are invalid",
        )
    hashes = (result.get("artifact_hashes", {}) if stage == "plan" else
              {path: result["candidate_sha"] for path in result.get("artifact_paths", [])})
    baseline = state["manifests"]["plan"]["value"]["result"]["baseline"]
    context = delivery.review_context(stage=stage, generation=manifest["generation"], issue=state["issue"],
        material_hashes=hashes, baseline_sha=baseline["sha"], base_repo=pr["repo"],
        base_ref=pr["base"], base_sha=pr["base_sha"], final_repo=state["repo"],
        final_ref=state["policy_values"]["delivery"]["final_target"], policy_digest=state["policy"]["digest"])
    return context, pr, pr["head_sha"]


def approval_request(state: dict, stage: str) -> dict | None:
    if not state["requirements"][stage]:
        return None
    context, pr, _ = approval_context(state, stage)
    kind = "plan" if stage == "plan" else "implement"
    return {"stage": stage, "pr": pr, "context_digest": context,
            "generation": state["manifests"][kind]["generation"],
            "minimum": state["requirements"][stage],
            "reviewer_ids": state["policy_values"]["approvals"][stage]["reviewer_ids"]}


def check_approval(state: dict, launcher: Path, stage: str) -> tuple[dict, str]:
    context, pr, commit_id = approval_context(state, stage)
    packet = {**packet_for(state, "list_reviews"),
              "stage": stage, "pr": pr, "context_digest": context,
              "generation": state["manifests"]["plan" if stage == "plan" else "implement"]["generation"]}
    response = call_launcher(launcher, packet, **({"app": state["app"]} if "app" in state else {}))
    delivery.require(response.get("paginated") is True, "publisher did not prove review pagination")
    validate_pr(response.get("pr", {}), pr, draft=True)
    config = state["policy_values"]["approvals"][stage]
    verdict = delivery.evaluate_reviews(response.get("reviews", []), stage=stage,
        generation=packet["generation"], context_digest=context, commit_id=commit_id,
        authorized_ids=config["reviewer_ids"], publisher_id=state["policy_values"]["delivery"]["publisher_id"],
        minimum=state["requirements"][stage], require_human=state.get("credential_mode") == "app")
    state.setdefault("receipts", {})[stage] = {**verdict, "context_digest": context,
        "commit_id": commit_id, "checked_at": delivery.utc_now()}
    if verdict["approved"]: return state, "approve"
    if verdict["rejectors"]: return state, "reject"
    return state, "pending"


def finalize(state: dict, launcher: Path, save=lambda _state: None) -> dict:
    app = state.get("credential_mode") == "app"
    allowed = delivery.APP_FINALIZING if app else {"publication_pending"}
    delivery.require(state["status"] in allowed, "finalize is out of order")
    receipt = state.get("receipts", {}).get("implementation", {})
    delivery.require(state["requirements"]["implementation"] == 0 or receipt.get("approved") is True,
                     "implementation approval missing")
    publication = state.get("publication", {}).get("implementation")
    delivery.require(publication is not None, "implementation publication missing")
    label = state["policy_values"].get("tracking", {}).get("review_label")
    delivery.require(isinstance(label, str) and label, "policy existing review label mapping missing")
    packet = {**packet_for(state, "finalize"), "pr": publication["pr"],
              "issue": state["issue"], "existing_review_label": label,
              "expected": expected_publication(state, "implementation"),
              "prior_pr": state.get("publication", {}).get("plan", {}).get("pr"),
              "approval": approval_request(state, "implementation"),
              "plan_approval": approval_request(state, "plan")}
    deferred_head = state.get("actions_deferred_head") if app else None
    local = app and not state["policy_values"]["delivery"].get("require_github_actions", True)
    if deferred_head is not None:
        delivery.require(deferred_head == publication["pr"]["head_sha"],
                         "Actions deferral is for a different implementation revision")
        packet["actions_deferred_head"] = deferred_head

    def validate(result: dict) -> None:
        if app:
            status = result.get("status")
            delivery.require(status in (delivery.APP_FINALIZING - {"publication_pending"}) | {"review_ready"},
                             "invalid trusted App finalization state")
            validate_pr(result.get("pr", {}), publication["pr"], draft=status.startswith("pre_ready"))
            if local and status in {"tracking_pending", "review_ready"}:
                ci = result.get("ci", {})
                delivery.require(ci.get("status") == "success" and ci.get("source") == "local"
                                 and ci.get("head_sha") == publication["pr"]["head_sha"]
                                 and ci.get("base_sha") == publication["pr"]["base_sha"],
                                 "successful exact-revision local verification readback required")
            if status != "review_ready":
                return
            ci = result.get("ci", {})
            if deferred_head is not None:
                delivery.require(ci.get("status") == "deferred" and ci.get("head_sha") == deferred_head,
                                 "trusted Actions deferral readback required")
            else:
                delivery.require(ci.get("status") == "success", "successful trusted CI readback required")
        validate_pr(result.get("pr", {}), publication["pr"], draft=False)
        issue = result.get("issue", {})
        delivery.require(issue.get("number") == state["issue"], "issue readback mismatch")
        delivery.require(label in issue.get("labels", []), "review label readback missing")

    if app and state["status"] != "tracking_pending":
        response = call_mutation(state, launcher, packet, save, validate,
                                 transport_options={"checkpoint_tracking": True})
        if response["status"] == "tracking_pending":
            state["status"] = "tracking_pending"
            state["publication"]["progress"] = response
            save(state)
            response = call_mutation(state, launcher, packet, save, validate)
    else:
        response = call_mutation(state, launcher, packet, save, validate)
    state["status"] = response["status"] if app else "github_ready"
    if app:
        state["publication"]["progress"] = response
    if not app or state["status"] == "review_ready":
        state["publication"]["final"] = response
    save(state)
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
        with coordinator.runner_step(state) as state:
            if state.get("credential_mode") == "app":
                delivery.require(args.launcher.resolve() == Path(state["publisher_launcher"]),
                                 "App publisher launcher differs from protected state")
            if args.command.startswith("publish-"):
                state = publish(state, args.launcher.resolve(), args.command.removeprefix("publish-"), coordinator.save)
                verdict = None
            elif args.command.startswith("check-"):
                state, verdict = check_approval(state, args.launcher.resolve(), args.command.removeprefix("check-"))
            else:
                state = finalize(state, args.launcher.resolve(), coordinator.save)
                verdict = None
            coordinator.save(state)
        print(json.dumps({"status": state["status"], "verdict": verdict}, sort_keys=True))
        return 0
    except (delivery.DeliveryError, OSError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True)); return 2


if __name__ == "__main__": raise SystemExit(main())
