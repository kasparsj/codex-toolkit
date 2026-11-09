#!/usr/bin/env python3
"""Run repository-configured checks for an exact published revision locally."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable

import delivery


IMAGE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
TIMEOUT_SECONDS = 1800
MAX_DIAGNOSTIC = 2000


def _diagnostic(value: str) -> str:
    clean = "".join(character if character in "\n\t" or ord(character) >= 32 else "?"
                    for character in value)
    return clean.strip()[-MAX_DIAGNOSTIC:]


def _runtime(env: dict[str, str]) -> Path:
    delivery.require(not os.environ.get("DOCKER_HOST") and not os.environ.get("DOCKER_CONTEXT"),
                     "local verification forbids Docker host or context overrides")
    runtime = Path(shutil.which("docker") or "").resolve()
    delivery.require(runtime.is_file() and runtime.stat().st_mode & 0o022 == 0,
                     "local verification requires a non-writable system Docker client")
    context = subprocess.run([str(runtime), "context", "inspect", "--format",
                              '{{(index .Endpoints "docker").Host}}'],
                             text=True, capture_output=True, check=False, env=env, timeout=30)
    delivery.require(context.returncode == 0 and context.stdout.strip().startswith("unix://"),
                     "local verification requires a local Unix-socket Docker context")
    info = subprocess.run([str(runtime), "info", "--format", "{{json .ServerVersion}}"],
                          text=True, capture_output=True, check=False, env=env, timeout=30)
    delivery.require(info.returncode == 0 and info.stdout.strip(),
                     "local verification Docker daemon is unavailable")
    return runtime


def _profile(value: dict[str, Any]) -> tuple[str, list[str]]:
    delivery.require(isinstance(value, dict) and set(value) == {"image", "argv"},
                     "local verification profile requires only image and argv")
    image = value.get("image")
    argv = value.get("argv")
    delivery.require(isinstance(image, str) and IMAGE.fullmatch(image),
                     "local verification image must be pinned by registry digest")
    delivery.require(isinstance(argv, list) and argv
                     and all(isinstance(item, str) and item and "\x00" not in item
                             for item in argv),
                     "local verification argv must be a nonempty string list")
    return image, argv


def _run_bounded(argv: list[str], *, env: dict[str, str], timeout: int,
                 runtime: Path, container: str) -> tuple[int | None, str]:
    process = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                               env=env, text=False)
    tail = bytearray()

    def drain() -> None:
        assert process.stderr is not None
        while chunk := process.stderr.read(8192):
            tail.extend(chunk)
            if len(tail) > MAX_DIAGNOSTIC:
                del tail[:-MAX_DIAGNOSTIC]

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run([str(runtime), "rm", "--force", container], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False, env=env, timeout=30)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=30)
        returncode = None
    reader.join(timeout=30)
    return returncode, _diagnostic(tail.decode("utf-8", errors="replace"))


def verify(*, root: Path, git_factory: Callable, canonical_url: str,
           pr: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Verify the exact remote PR head in a network-disabled disposable container."""
    image, argv = _profile(profile)
    head = pr.get("head")
    head_sha = pr.get("head_sha")
    delivery.require(isinstance(head, str) and head
                     and isinstance(head_sha, str) and delivery.FULL_SHA.fullmatch(head_sha),
                     "local verification requires an exact PR head")
    root = root.resolve()
    delivery.require(root.is_dir() and not root.is_symlink(),
                     "local verification root must be an existing non-symlink directory")
    run_root = Path(tempfile.mkdtemp(prefix="local-verifier-", dir=root))
    os.chmod(run_root, 0o700)
    checkout = run_root / "checkout"
    checkout.mkdir(mode=0o700)
    docker_home = run_root / "docker-cli"
    docker_home.mkdir(mode=0o700)
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
    env.update(HOME=str(docker_home), DOCKER_CONFIG=str(docker_home))
    started = time.monotonic()
    try:
        runtime = _runtime(env)
        try:
            with git_factory(root, canonical_url) as trusted:
                trusted.materialize_remote_revision(head, head_sha, checkout)
        except delivery.DeliveryError as exc:
            return {"status": "unknown", "reason": "revision_unavailable",
                    "head_sha": head_sha, "diagnostic": _diagnostic(str(exc))}

        inspect = subprocess.run(
            [str(runtime), "image", "inspect", image, "--format", "{{json .RepoDigests}}"],
            text=True, capture_output=True, check=False, env=env, timeout=30,
        )
        if inspect.returncode:
            return {"status": "unknown", "reason": "image_unavailable", "head_sha": head_sha,
                    "diagnostic": _diagnostic(inspect.stderr)}
        try:
            repo_digests = json.loads(inspect.stdout)
        except json.JSONDecodeError:
            repo_digests = None
        if not isinstance(repo_digests, list) or image not in repo_digests:
            return {"status": "unknown", "reason": "image_digest_unverified",
                    "head_sha": head_sha}

        delivery.require(not any(character in str(checkout) for character in ',"\n\r'),
                         "local verification checkout path contains a Docker delimiter")
        container = f"delivery-verify-{secrets.token_hex(10)}"
        command = (
            "umask 077; mkdir -p /work/repo /work/home; "
            "cp -R -- /input/. /work/repo/; cd /work/repo; exec " + shlex.join(argv)
        )
        docker = [
            str(runtime), "run", "--name", container, "--rm", "--init", "--pull", "never",
            "--log-driver", "none",
            "--network", "none", "--user", f"{os.getuid()}:{os.getgid()}", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
            "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777",
            "--tmpfs", "/work:rw,exec,nosuid,nodev,size=4g,mode=1777",
            "--mount", f"type=bind,src={checkout},dst=/input,readonly",
            "--env", "HOME=/work/home", "--workdir", "/",
            "--entrypoint", "/bin/sh", image, "-ec", command,
        ]
        returncode, diagnostic = _run_bounded(
            docker, env=env, timeout=TIMEOUT_SECONDS, runtime=runtime, container=container,
        )
        if returncode is None:
            return {"status": "unknown", "reason": "local_tests_timed_out",
                    "head_sha": head_sha, "timeout_seconds": TIMEOUT_SECONDS}
        elapsed = round(time.monotonic() - started, 3)
        if returncode:
            return {"status": "blocked", "reason": "local_tests_failed", "head_sha": head_sha,
                    "exit_code": returncode, "duration_seconds": elapsed,
                    "diagnostic": diagnostic}
        return {"status": "success", "reason": "local_tests_passed", "head_sha": head_sha,
                "exit_code": 0, "duration_seconds": elapsed, "image": image}
    except (delivery.DeliveryError, OSError, subprocess.SubprocessError) as exc:
        return {"status": "unknown", "reason": "local_verifier_error", "head_sha": head_sha,
                "diagnostic": _diagnostic(str(exc))}
    finally:
        delivery.require(run_root.parent == root and run_root.name.startswith("local-verifier-"),
                         "refusing unsafe local verifier cleanup")
        shutil.rmtree(run_root)
