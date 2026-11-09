"""Fail-closed local container boundary for App-mode delivery agents."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any

import delivery


CONTAINER_WORKTREE = Path("/delivery/worktree")
CONTAINER_SCRATCH = Path("/delivery/scratch")
CONTAINER_SKILLS = Path("/delivery/skills")
CONTAINER_LAUNCHER = Path("/delivery/bin/agent-launcher")
CONTAINER_SNAPSHOT = Path("/delivery/input/github-read-snapshot.json")


def _inside(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def _require_disjoint(paths: dict[str, Path]) -> None:
    values = list(paths.items())
    for index, (left_name, left) in enumerate(values):
        for right_name, right in values[index + 1:]:
            delivery.require(not _inside(left, right) and not _inside(right, left),
                             f"agent {left_name} and {right_name} must be disjoint")


def _git_output(worktree: Path, *args: str, allow_missing: bool = False) -> str:
    env = {"PATH": os.environ.get("PATH", ""), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_NO_LAZY_FETCH": "1",
           "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1"}
    completed = subprocess.run(
        ["git", "-C", str(worktree), "-c", "protocol.allow=never", *args],
        text=True, capture_output=True, check=False, env=env,
    )
    delivery.require(completed.returncode == 0 or allow_missing and completed.returncode == 1,
                     "App agent checkout Git validation failed")
    return completed.stdout.strip()


def validate_checkout(worktree: Path, *, expected_sha: str | None = None) -> None:
    """Require a self-contained checkout so no host repository metadata is mounted."""
    worktree = worktree.resolve()
    delivery.require(not worktree.is_symlink(), "App agent checkout may not be a symlink")
    dot_git = worktree / ".git"
    delivery.require(dot_git.is_dir() and not dot_git.is_symlink(),
                     "App agent checkout requires local non-symlink Git metadata")
    delivery.require(not (dot_git / "config").is_symlink(),
                     "App agent checkout Git config may not be a symlink")
    delivery.require(not (dot_git / "objects/info/alternates").exists()
                     and not (dot_git / "commondir").exists(),
                     "App agent checkout must not use shared Git metadata")
    delivery.require(not any(path.is_symlink() for path in dot_git.rglob("*")),
                     "App agent checkout Git metadata must not contain symlinks")
    git_dir = Path(_git_output(worktree, "rev-parse", "--absolute-git-dir")).resolve()
    delivery.require(_inside(git_dir, worktree),
                     "App agent checkout Git metadata must be self-contained")
    delivery.require(_git_output(worktree, "config", "--local", "--bool",
                                 "delivery.agentCheckout") == "true",
                     "App agent checkout is missing its dedicated-checkout marker")
    if expected_sha is not None:
        _git_output(worktree, "cat-file", "-e", f"{expected_sha}^{{commit}}")
    forbidden = ("credential.helper", "core.sshCommand", "http.extraHeader")
    for key in forbidden:
        value = _git_output(worktree, "config", "--local", "--get-all", key,
                            allow_missing=True)
        delivery.require(not value, f"App agent checkout contains forbidden Git setting {key}")
    remotes = _git_output(worktree, "remote", "-v")
    delivery.require("@" not in remotes and "http.extraheader" not in remotes.lower(),
                     "App agent checkout remote may contain credentials")


def validate_snapshot(snapshot: Path, *, repo: str, repository_id: int,
                      repository_full_name: str, policy_sha: str) -> tuple[dict[str, Any], str]:
    delivery.require(snapshot.is_file(), "trusted GitHub read snapshot missing")
    raw = snapshot.read_bytes()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise delivery.DeliveryError("trusted GitHub read snapshot is invalid JSON") from exc
    delivery.require(isinstance(value, dict) and value.get("schema_version") == 1,
                     "unsupported trusted GitHub read snapshot")
    delivery.require(value.get("repo") == repo, "trusted GitHub read snapshot repository mismatch")
    delivery.require(isinstance(value.get("repository"), dict), "snapshot repository identity missing")
    delivery.require(type(value["repository"].get("id")) is int,
                     "snapshot repository numeric ID missing")
    delivery.require(isinstance(value["repository"].get("full_name"), str),
                     "snapshot canonical repository name missing")
    delivery.require(value["repository"]["id"] == repository_id,
                     "trusted GitHub read snapshot repository ID mismatch")
    delivery.require(value["repository"]["full_name"] == repository_full_name,
                     "trusted GitHub read snapshot canonical name mismatch")
    delivery.require(isinstance(value.get("issues"), list), "snapshot issues must be a list")
    delivery.require(isinstance(value.get("pull_requests"), list),
                     "snapshot pull requests must be a list")
    source = value.get("source")
    delivery.require(isinstance(source, dict) and isinstance(source.get("sha"), str)
                     and len(source["sha"]) == 40, "snapshot source SHA missing")
    delivery.require(source["sha"] == policy_sha, "trusted GitHub read snapshot policy SHA mismatch")
    delivery.require(isinstance(value.get("fetched_at"), str), "snapshot fetch time missing")
    return value, hashlib.sha256(raw).hexdigest()


def preflight(*, state: dict[str, Any], launcher: Path, worktree: Path,
              scratch: Path, skills_root: Path) -> dict[str, Any]:
    """Prove the local isolation inputs before any App-mode agent dispatch."""
    agent = state.get("agent", {})
    app = state.get("app") or state.get("manual", {})
    delivery.require(delivery.protected_delivery(state), "container profile requires protected delivery mode")
    delivery.require(agent.get("isolation_profile") == "container",
                     "App mode requires the container isolation profile")
    image = agent.get("container_image")
    delivery.require(isinstance(image, str) and re.fullmatch(r"[^\s@]+@sha256:[0-9a-f]{64}", image),
                     "App agent container image must be pinned by digest")
    launcher = launcher.resolve(); worktree = worktree.resolve()
    scratch = scratch.resolve(); skills_root = skills_root.resolve()
    delivery.require(launcher.is_file() and os.access(launcher, os.X_OK),
                     "agent launcher must be executable")
    delivery.require(worktree.is_dir(), "dedicated agent worktree missing")
    delivery.require(skills_root.is_dir(), "pinned skills root missing")
    scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
    _require_disjoint({"worktree": worktree, "scratch": scratch, "skills": skills_root})
    validate_checkout(worktree, expected_sha=state["policy"]["sha"])
    publisher_root = Path(app.get("publisher_root", "")).resolve()
    delivery.require(len(publisher_root.parents) >= 3 and publisher_root.name == "publisher"
                     and publisher_root.parents[1].name == "repos",
                     "App publisher root layout is invalid")
    state_root = publisher_root.parents[2]
    expected_snapshot = (publisher_root.parent / "deliveries" / state["delivery_id"]
                         / "github-read-snapshot.json").resolve()
    snapshot = Path(agent.get("read_snapshot", expected_snapshot)).resolve()
    delivery.require(snapshot == expected_snapshot,
                     "trusted read snapshot must use the protected delivery state path")
    for mounted in (worktree, scratch, skills_root):
        delivery.require(not _inside(launcher, mounted),
                         "App agent launcher must be outside other agent mounts")
        delivery.require(not _inside(state_root, mounted) and not _inside(mounted, state_root),
                         "protected delivery state must be outside agent mounts")
        delivery.require(not _inside(Path.home().resolve(), mounted),
                         "host home must be outside agent mounts")
        protected_labels = ("config", "publisher_root")
        if state.get("credential_mode") == "app":
            protected_labels += ("private_key_path",)
        elif app.get("read_token_file"):
            protected_labels += ("read_token_file",)
        if app.get("operator_app"):
            protected_labels += ("operator_app", "operator_policy")
        for label in protected_labels:
            raw_protected = app.get(label)
            delivery.require(isinstance(raw_protected, str) and Path(raw_protected).is_absolute(),
                             f"protected App {label} path must be absolute")
            protected = Path(raw_protected).resolve()
            delivery.require(not _inside(protected, mounted)
                             and not _inside(mounted, protected),
                             f"protected App {label} must be outside agent mounts")
    _, snapshot_digest = validate_snapshot(snapshot, repo=state["repo"],
        repository_id=app.get("repository_id"),
        repository_full_name=app.get("repository_full_name"), policy_sha=state["policy"]["sha"])
    docker = agent.get("container_runtime", "docker")
    delivery.require(docker == "docker", "unsupported App agent container runtime")
    docker_path = Path(shutil.which(docker) or "").resolve()
    delivery.require(docker_path.is_file() and docker_path.stat().st_mode & 0o022 == 0,
                     "Docker client must be installed in a non-writable system path")
    delivery.require(not os.environ.get("DOCKER_HOST") and not os.environ.get("DOCKER_CONTEXT"),
                     "ambient Docker host or context override is forbidden")
    cli_config = publisher_root / "docker-cli"
    cli_config.mkdir(mode=0o700, exist_ok=True)
    runtime_env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
    runtime_env.update(HOME=str(cli_config), DOCKER_CONFIG=str(cli_config))
    def probe(*args: str) -> subprocess.CompletedProcess:
        try:
            return subprocess.run([str(docker_path), *args], text=True, capture_output=True,
                                  check=False, env=runtime_env, timeout=30)
        except subprocess.TimeoutExpired as exc:
            raise delivery.DeliveryError("Docker preflight timed out") from exc

    context = probe("context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}')
    delivery.require(context.returncode == 0 and context.stdout.strip().startswith("unix://"),
                     "App agent isolation requires a local Unix-socket Docker context")
    info = probe("info", "--format", "{{json .ServerVersion}}")
    delivery.require(info.returncode == 0 and info.stdout.strip(),
                     "Docker daemon unavailable for App agent isolation")
    inspect = probe("image", "inspect", image, "--format", "{{.Id}}")
    delivery.require(inspect.returncode == 0 and inspect.stdout.strip().startswith("sha256:"),
                     "pinned App agent container image unavailable")
    return {"image": image, "runtime": str(docker_path), "snapshot": snapshot,
            "policy_sha": state["policy"]["sha"], "env": runtime_env,
            "snapshot_sha256": snapshot_digest}


def command(*, profile: dict[str, Any], launcher: Path, worktree: Path,
            scratch: Path, skills_root: Path) -> list[str]:
    """Build the auditable Docker invocation. No network or ambient host mounts."""
    uid = os.getuid(); gid = os.getgid()
    delivery.require(all(not any(char in str(path) for char in ',"\n\r')
                         for path in (worktree, scratch, skills_root, launcher, profile["snapshot"])),
                     "App agent mount paths contain Docker option delimiters")
    return [
        profile["runtime"], "run", "--rm", "--interactive", "--init", "--pull", "never",
        "--network", "none",
        "--user", f"{uid}:{gid}", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "256",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--mount", f"type=bind,src={worktree.resolve()},dst={CONTAINER_WORKTREE}",
        "--mount", f"type=bind,src={scratch.resolve()},dst={CONTAINER_SCRATCH}",
        "--mount", f"type=bind,src={skills_root.resolve()},dst={CONTAINER_SKILLS},readonly",
        "--mount", f"type=bind,src={launcher.resolve()},dst={CONTAINER_LAUNCHER},readonly",
        "--mount", f"type=bind,src={profile['snapshot']},dst={CONTAINER_SNAPSHOT},readonly",
        "--workdir", str(CONTAINER_WORKTREE),
        "--env", "HOME=/delivery/scratch/home",
        "--env", "GH_CONFIG_DIR=/delivery/scratch/home/.config/gh",
        "--env", "DELIVERY_AGENT_ISOLATED=1",
        "--env", f"DELIVERY_READ_SNAPSHOT={CONTAINER_SNAPSHOT}",
        "--env", f"DELIVERY_BASE_SHA={profile['policy_sha']}",
        "--entrypoint", "/bin/sh", profile["image"], "-ec",
        "git -c core.hooksPath=/dev/null -c credential.helper= checkout --detach --force \"$DELIVERY_BASE_SHA\" >/dev/null 2>&1 && "
        "git -c core.hooksPath=/dev/null clean -fdx >/dev/null && exec /delivery/bin/agent-launcher",
    ]
