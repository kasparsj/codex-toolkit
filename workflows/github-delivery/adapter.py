#!/usr/bin/env python3
"""Trusted adapter for a separately isolated agent-launcher executable.

Launcher protocol: read one task packet JSON object from stdin; write exactly
one result manifest JSON object to stdout; write diagnostics to stderr.  The
launcher receives no GitHub/git credential environment from this process.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

import delivery
import agent_isolation


SKILL_FOR_KIND = {"rank": "next-issue", "plan": "plan-pr",
                  "implement": "implement-plan", "closeout": "pr-closeout"}
ALLOWED_STATUS = {"rank": {"claimed", "rank_required", "plan_required"},
                  "plan": {"plan_required", "plan_review"},
                  "implement": {"implementation_required", "implementation_review", "publication_pending"},
                  "closeout": {"github_ready", "review_ready", "ci_waiting", "blocked"}}


def isolated_env(scratch: Path) -> dict[str, str]:
    home = (scratch / "home").resolve(); config = home / ".config" / "gh"
    home.mkdir(parents=True, exist_ok=True, mode=0o700); config.mkdir(parents=True, exist_ok=True)
    keep = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
    keep.update({"HOME": str(home), "GH_CONFIG_DIR": str(config), "DELIVERY_AGENT_ISOLATED": "1"})
    delivery.validate_agent_environment(keep, scratch)
    return keep


def run_agent(*, launcher: Path, kind: str, state: dict, skills_root: Path,
              worktree: Path, scratch: Path) -> dict:
    delivery.require(kind in SKILL_FOR_KIND, "unsupported adapter kind")
    delivery.require(state["status"] in ALLOWED_STATUS[kind],
                     f"{kind} is out of order from {state['status']}")
    current_hashes = delivery.skill_hashes(skills_root)
    delivery.require(current_hashes == state["skill_hashes"], "pinned skill source changed")
    worktree = worktree.resolve(); scratch = scratch.resolve()
    delivery.require(worktree.is_dir(), "dedicated worktree missing")
    delivery.require(launcher.is_file() and os.access(launcher, os.X_OK), "agent launcher must be executable")
    skill = SKILL_FOR_KIND[kind]; skill_path = (skills_root / skill / "SKILL.md").resolve()
    if kind == "implement" and state["requirements"]["plan"]:
        from publisher_adapter import check_approval

        _, verdict = check_approval(state, Path(state["publisher_launcher"]), "plan")
        delivery.require(verdict == "approve", "current plan approval required before implementation")
    app_mode = state.get("credential_mode") == "app"
    profile = None
    packet_worktree = worktree
    packet_scratch = scratch
    packet_skill_path = skill_path
    if app_mode:
        profile = agent_isolation.preflight(state=state, launcher=launcher, worktree=worktree,
            scratch=scratch, skills_root=skills_root)
        packet_worktree = agent_isolation.CONTAINER_WORKTREE
        packet_scratch = agent_isolation.CONTAINER_SCRATCH
        packet_skill_path = agent_isolation.CONTAINER_SKILLS / skill / "SKILL.md"
    packet = {"schema_version": 1, "kind": kind, "delivery_id": state["delivery_id"],
              "repo": state["repo"], "issue": state.get("issue"), "status": state["status"],
              "skill": {"name": skill, "path": str(packet_skill_path),
                        "sha256": delivery.digest_bytes(skill_path.read_bytes()),
                        "package_sha256": current_hashes[skill]},
              "worktree": str(packet_worktree), "scratch": str(packet_scratch),
              "policy": state["policy_values"],
              "plan": state.get("manifests", {}).get("plan", {}).get("value"),
              "publication": state.get("publication", {}),
              "instruction": "Load the exact pinned skill. Keep GitHub read-only. Return only its delivery manifest."}
    if kind in ("plan", "implement"):
        packet["candidate_bundle"] = str(packet_scratch / "candidate.bundle")
        packet["candidate_ref"] = "refs/heads/delivery-candidate"
    if app_mode:
        packet["read_snapshot"] = {"path": str(agent_isolation.CONTAINER_SNAPSHOT),
                                   "sha256": profile["snapshot_sha256"]}
        packet["instruction"] += " Use only DELIVERY_READ_SNAPSHOT for GitHub reads. Network is unavailable."
        if kind == "implement":
            packet["instruction"] += (
                " Start implementation at the exact reviewed plan revision in this checkout."
                " Export a complete bundle whose candidate extends that revision."
                " Report changed paths against the pinned default-branch base."
            )
        argv = agent_isolation.command(profile=profile, launcher=launcher, worktree=worktree,
            scratch=scratch, skills_root=skills_root)
        env = profile["env"]
    else:
        argv = [str(launcher)]
        env = isolated_env(scratch)
    completed = subprocess.run(argv, input=json.dumps(packet), text=True, capture_output=True,
                               cwd=worktree, env=env, check=False)
    if completed.returncode:
        raise delivery.DeliveryError(f"agent launcher failed: {completed.stderr.strip()}")
    try: manifest = json.loads(completed.stdout)
    except json.JSONDecodeError as exc: raise delivery.DeliveryError("agent launcher emitted invalid JSON") from exc
    delivery.validate_manifest(manifest, kind)
    return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run", choices=("run",)); parser.add_argument("--kind", choices=tuple(SKILL_FOR_KIND), required=True)
    parser.add_argument("--state-dir", type=Path, required=True); parser.add_argument("--repo", required=True)
    parser.add_argument("--delivery-id", required=True); parser.add_argument("--skills-root", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, required=True); parser.add_argument("--worktree", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        coordinator = delivery.Coordinator(args.state_dir); state = coordinator.load(args.repo, args.delivery_id)
        with coordinator.runner_step(state) as state:
            if state.get("credential_mode") == "app":
                persisted = state["agent"]
                supplied = {"launcher": str(args.launcher.resolve()),
                            "worktree": str(args.worktree.resolve()),
                            "skills_root": str(args.skills_root.resolve())}
                delivery.require(all(persisted.get(key) == value for key, value in supplied.items()),
                                 "App adapter arguments differ from protected delivery state")
                expected_scratch = (Path(persisted["scratch"]) / args.kind).resolve()
                delivery.require(args.scratch.resolve() == expected_scratch,
                                 "App adapter scratch differs from protected delivery state")
            manifest = run_agent(launcher=args.launcher.resolve(), kind=args.kind, state=state,
                skills_root=args.skills_root.resolve(), worktree=args.worktree, scratch=args.scratch)
            state = coordinator.accept_manifest(state, manifest)
        print(json.dumps({"status": state["status"], "manifest_digest":
              state["manifests"][args.kind]["digest"]}, sort_keys=True)); return 0
    except (delivery.DeliveryError, OSError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True)); return 2


if __name__ == "__main__":
    raise SystemExit(main())
