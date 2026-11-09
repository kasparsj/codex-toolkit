#!/usr/bin/env python3
"""Run the installed wheel with a real older python3 first on PATH."""

import argparse
import contextlib
from hashlib import sha256
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from installed_fixture_http import AUTHOR, PR_NUMBER, REPOSITORY_ID, REVIEW_LABEL
from installed_fixture_http import fixture_http, fixture_pr, fixture_review
from installed_fixture_tools import fixture_tools, publish_fixture_bundle
from installed_preflight import exercise_bundled_publisher, exercise_preflight


REPO = "acme/widget"
ISSUE = 42
DELIVERY = "installed-fixture"
IMAGE = "fixture@sha256:" + "a" * 64


def run(argv, *, cwd, env=None, code=0):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == code, result
    return result.stdout


def install(root, wheel):
    run([sys.executable, "-m", "venv", str(root)], cwd=root.parent)
    python = root / "bin" / "python"
    run([str(python), "-m", "pip", "install", "--no-deps", str(wheel)], cwd=root.parent)
    return python, root / "bin" / "codex-toolkit"


def write_profile(path, state, token):
    path.write_text(json.dumps({
        "repository": REPO, "repository_id": REPOSITORY_ID, "state_dir": str(state),
        "read_token_file": str(token), "allowed_path_prefixes": ["README.md", "docs/"],
        "local_verifier": {"image": IMAGE, "argv": ["/bin/true"], "audited_workflows": {}},
        "policy": {
            "version": 1,
            "delivery": {"final_target": "main", "publisher_id": AUTHOR["id"],
                         "require_github_actions": False},
            "branches": {"default_parent": "main", "plan_template": "codex/issue-{issue}",
                         "implementation_template": "codex/issue-{issue}"},
            "eligibility": {"required_labels": ["ready"],
                            "excluded_labels": ["blocked", "duplicate", "invalid", "wontfix", "deferred"]},
            "tracking": {"review_label": REVIEW_LABEL},
            "approvals": {stage: {"minimum": 1, "reviewer_ids": [AUTHOR["id"]]}
                          for stage in ("plan", "implementation")},
        },
    }))
    path.chmod(0o600)


def strand_start(argv, *, cwd, env, recorded, root):
    """Block the first runner dispatch until the installed coordinator can be hard-killed."""
    blocking = root / "blocking-bin"
    blocking.mkdir()
    marker = root / "runner-launched"
    uvx = blocking / "uvx"
    uvx.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(marker))}\nexec /bin/sleep 120\n")
    uvx.chmod(0o700)
    blocked_env = {**env, "PATH": f"{blocking}:{env['PATH']}"}
    process = subprocess.Popen(argv, cwd=cwd, env=blocked_env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        deadline = time.monotonic() + 30
        while not marker.exists():
            if process.poll() is not None:
                raise AssertionError(process.communicate())
            if time.monotonic() >= deadline:
                raise AssertionError("installed start did not dispatch its runner")
            time.sleep(0.05)
        state = json.loads(recorded.read_text())
        assert state["runner_status"] == "running" and state["runner_pid"] == process.pid, state
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=10)
    assert process.returncode == -signal.SIGKILL, process.returncode
    return state


def exercise_delivery(command, other, python, runtime, *, root, env):
    tools = fixture_tools(root, python, REPO, IMAGE)
    http = fixture_http(root, python, REPO, tools["base"], ISSUE)
    state = root / "state"
    state.mkdir(mode=0o700)
    profile = root / "developer.json"
    write_profile(profile, state, http["token"])
    env = {**env, "PATH": f"{tools['bin']}:{env['PATH']}"}
    local = ["--agent-launcher", str(tools["launcher"]), "--worktree", str(tools["checkout"]),
             "--agent-scratch", str(tools["scratch"]), "--container-image", IMAGE]
    exercise_preflight(command, directory=root, env=env, profile=profile, repo=REPO,
                       local_args=local, issue=ISSUE, secret=http["secret"])
    cwd = root / "outside" / "checkout"
    exercise_bundled_publisher(python, cwd=cwd, env=env)
    assert all(json.loads(line)[0] != "run" for line in tools["docker_log"].read_text().splitlines())

    def argv(operation, *extra, executable=command):
        return [str(executable), "delivery", operation, "--repo", REPO,
                "--developer-config", str(profile), *extra]

    def cli(operation, *extra, code=0, executable=command):
        return json.loads(run(argv(operation, *extra, executable=executable), cwd=cwd, env=env, code=code))

    repo_dir = state / "repos" / sha256(f"github.com/{REPO}".encode()).hexdigest()
    recorded = repo_dir / "deliveries" / DELIVERY / "state.json"
    active = repo_dir / "active.json"
    before = strand_start(argv("start", "--issue", str(ISSUE), "--delivery-id", DELIVERY, *local),
                          cwd=cwd, env=env, recorded=recorded, root=root)
    state_before, claim_before = recorded.read_bytes(), active.read_bytes()
    status = cli("status")
    assert status["runner_status"] == "running" and status["claim_status"] == "active", status
    refused = cli("resume", code=2)
    assert "requires recover" in refused["error"], refused
    incompatible = cli("recover", code=2, executable=other)
    assert "requires its pinned codex-toolkit installation" in incompatible["error"], incompatible
    assert recorded.read_bytes() == state_before and active.read_bytes() == claim_before

    paused = cli("recover")
    assert paused["status"] == "plan_publication_pending", paused
    assert paused["runner_status"] == "paused" and paused["claim_status"] == "active", paused
    after = json.loads(recorded.read_text())
    assert after["attempt"] == before["attempt"] + 1
    for pin in ("delivery_id", "policy", "skill_hashes", "adapter_hashes", "runtime", "agent"):
        assert after[pin] == before[pin], pin
    assert after["runtime"]["python_executable"] == str(python)
    assert after["adapter_hashes"]["workflow.yaml"] == sha256((runtime / "workflow.yaml").read_bytes()).hexdigest()
    assert active.read_bytes() == claim_before
    state_before = recorded.read_bytes()
    docker_before = tools["docker_log"].read_bytes()
    reads_before = http["log"].read_bytes()

    workflow = runtime / "workflow.yaml"
    original = workflow.read_bytes()
    try:
        workflow.write_bytes(original + b"\n# incompatible installed bytes\n")
        changed = cli("resume", code=2)
        assert "pinned adapter source changed" in changed["error"], changed
    finally:
        workflow.write_bytes(original)
    launcher = tools["launcher"]
    hidden_launcher = launcher.with_suffix(".missing")
    launcher.rename(hidden_launcher)
    try:
        assert cli("status")["claim_status"] == "active"
        missing = cli("resume", code=2)
        assert "restore the pinned agent launcher" in missing["error"], missing
    finally:
        hidden_launcher.rename(launcher)
    assert recorded.read_bytes() == state_before and active.read_bytes() == claim_before
    assert tools["docker_log"].read_bytes() == docker_before and http["log"].read_bytes() == reads_before

    github = json.loads(http["state"].read_text())

    def save():
        http["state"].write_text(json.dumps(github))

    def publish(value, stage):
        handoff = value["manual_handoff"]
        assert handoff["stage"] == stage and handoff["head_sha"] == tools[stage], handoff
        publish_fixture_bundle(tools, handoff)
        github["pr"] = fixture_pr(REPO, handoff)
        save()

    def approve(value, stage, stale, first_id):
        review = value["human_review"]
        assert review["head_sha"] == tools[stage], review
        github["reviews"].append(fixture_review(review, first_id, sha=stale))
        save()
        pending = cli("resume")
        assert pending["status"] == f"{stage}_review" and not pending["receipts"][stage]["approved"], pending
        github["reviews"].append(fixture_review(review, first_id + 1))
        save()
        return cli("resume")

    publish(paused, "plan")
    review = cli("resume", "--pr", str(PR_NUMBER))
    implementation = approve(review, "plan", tools["base"], 1)
    assert implementation["status"] == "implementation_publication_pending", implementation
    publish(implementation, "implementation")
    review = cli("resume")
    verified = approve(review, "implementation", tools["plan"], 3)
    assert verified["operator_action"] == "mark_pr_ready" and verified["ci"]["status"] == "success", verified
    assert verified["ci"]["head_sha"] == tools["implementation"], verified
    github["pr"]["draft"] = False
    save()
    tracking = cli("resume")
    assert tracking["operator_action"] == "apply_issue_label", tracking
    github["issue_labels"].append(REVIEW_LABEL)
    save()
    finished = cli("resume")
    assert finished["status"] == "review_ready" and finished["claim_status"] == "released", finished
    assert finished["delivery_id"] == DELIVERY and finished["attempt"] == after["attempt"], finished
    assert all(json.loads(line)[0] == "GET" for line in http["log"].read_text().splitlines())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--old-python", type=Path, required=True)
    args = parser.parse_args()
    wheel = args.wheel.resolve()
    old_python = args.old_python.absolute()
    with tempfile.TemporaryDirectory(prefix="codex-toolkit-installed-") as name:
        root = Path(name).resolve()
        version = run([str(old_python), "-c", "import platform; print(platform.python_version())"], cwd=root).strip()
        if tuple(map(int, version.split(".")[:2])) >= (3, 11):
            parser.error("--old-python must be older than 3.11")
        python, command = install(root / "tool", wheel)
        _, other = install(root / "other-tool", wheel)
        runtime, skills = map(Path, json.loads(run([str(python), "-c",
            "import json; from codex_toolkit.resources import delivery_runtime, skills_root; "
            "print(json.dumps([str(delivery_runtime()), str(skills_root())]))"], cwd=root)))
        assert runtime.is_relative_to(root / "tool") and skills.is_relative_to(root / "tool")

        old_bin = root / "old-python"
        home = root / "home"
        old_bin.mkdir()
        home.mkdir(mode=0o700)
        marker = root / "old-python-used"
        wrapper = old_bin / "python3"
        wrapper.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(marker))}\n"
                           f"exec {shlex.quote(str(old_python))} \"$@\"\n")
        wrapper.chmod(0o700)
        env = {**os.environ, "PATH": f"{old_bin}:{os.environ['PATH']}", "HOME": str(home)}
        env.pop("PYTHONPATH", None)
        assert shutil.which("python3", path=env["PATH"]) == str(wrapper)
        assert "recover" in run([str(command), "delivery", "--help"], cwd=root, env=env)
        exercise_delivery(command, other, python, runtime, root=root, env=env)
        assert not marker.exists(), "installed workflow selected python3 from PATH"
    print(json.dumps({"old_python_on_path": version, "doctor_and_preview": "passed",
                      "hard_kill_recovery": "passed", "pin_refusal": "passed",
                      "installed_delivery": "review_ready", "claim": "released"}, sort_keys=True))


if __name__ == "__main__":
    main()
