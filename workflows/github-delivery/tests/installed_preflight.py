"""Read-only CLI and configuration checks shared by the installed fixture."""

import json
from pathlib import Path
import shutil
import subprocess


def exercise_preflight(command, *, directory, env, profile, repo, local_args, issue, secret):
    """Exercise the public entry point without creating delivery state."""
    profile_values = json.loads(profile.read_text())
    state = Path(profile_values["state_dir"])
    outside = directory / "outside"
    outside.mkdir()
    checkout = outside / "checkout"
    checkout.mkdir()

    def git(*args):
        subprocess.run(["git", "-C", str(checkout), *args], env=env,
                       check=True, capture_output=True)

    def cli(operation, *args, cwd=checkout, code=0):
        result = subprocess.run([str(command), "delivery", operation, *args],
                                cwd=cwd, env=env, capture_output=True, text=True, timeout=45)
        assert not secret or secret not in result.stdout + result.stderr
        assert result.returncode == code, result
        return json.loads(result.stdout)

    git("init", "-q")
    git("remote", "add", "origin", f"https://github.com/{repo}.git")
    git("remote", "add", "mirror", f"git@github.com:{repo}.git")
    owner, name = repo.lower().split("/")
    relative = Path(".config/codex-toolkit/delivery") / owner / f"{name}.json"
    spoof = checkout / relative
    spoof.parent.mkdir(parents=True)
    shutil.copyfile(profile, spoof)
    spoof.chmod(0o600)
    absent = cli("doctor", code=2)
    assert "configuration is missing" in absent["preview"]["blockers"][0], absent
    rejected = cli("preview", "--developer-config", str(spoof), code=2)
    assert "outside the checkout" in rejected["error"], rejected

    default = Path(env["HOME"]) / relative
    default.parent.mkdir(parents=True)
    shutil.copyfile(profile, default)
    default.chmod(0o600)
    partial = cli("doctor", code=2)
    assert partial["preview"]["status"] == "ready", partial
    assert partial["delivery"]["status"] == "blocked", partial
    assert "--agent-launcher" in " ".join(partial["delivery"]["blockers"]), partial
    default.chmod(0o644)
    unprotected = cli("doctor", code=2)
    assert "owner-only JSON" in unprotected["preview"]["blockers"][0], unprotected
    default.chmod(0o600)

    preview_only = {key: value for key, value in profile_values.items() if key != "local_verifier"}
    default.write_text(json.dumps(preview_only))
    no_verifier = cli("doctor", *local_args, code=2)
    assert no_verifier["preview"]["status"] == "ready", no_verifier
    assert any("local verifier" in blocker for blocker in no_verifier["delivery"]["blockers"]), no_verifier
    default.write_text(json.dumps({**profile_values, "repository_id": profile_values["repository_id"] + 1}))
    wrong_identity = cli("doctor", "--repo", repo, *local_args, code=2)
    assert any("repository identity" in blocker for blocker in wrong_identity["preview"]["blockers"]), wrong_identity
    shutil.copyfile(profile, default)

    full = cli("doctor", *local_args)
    assert full == {"preview": {"status": "ready", "blockers": []},
                    "delivery": {"status": "ready", "blockers": []}}, full
    assert not any(state.iterdir()), "doctor created delivery state"
    scratch = Path(local_args[local_args.index("--agent-scratch") + 1])
    assert not scratch.exists(), "doctor created configured scratch"
    ranked = cli("preview")
    assert ranked["repo"] == repo and ranked["winner"] == issue, ranked

    git("remote", "set-url", "mirror", "git@github.com:unrelated/project.git")
    ambiguous = cli("preview", code=2)
    assert "supply --repo" in ambiguous["error"], ambiguous
    for cwd in (checkout, outside):
        result = cli("preview", "--repo", repo, cwd=cwd)
        assert result["repo"] == repo and result["winner"] == issue, result
    wrong = cli("preview", "--repo", "unrelated/project", "--developer-config", str(profile), code=2)
    assert "configuration repository mismatch" in wrong["error"], wrong
    git("remote", "set-url", "origin", "https://github.example.com/acme/widget")
    git("remote", "remove", "mirror")
    unsupported = cli("preview", code=2)
    assert "supply --repo" in unsupported["error"], unsupported
    absent = cli("preview", cwd=outside, code=2)
    assert "no Git checkout" in absent["error"], absent


def exercise_bundled_publisher(python, *, cwd, env):
    """Prove the built-in publisher starts with the tool Python and wheel file permissions."""
    code = """
import os
import sys

from codex_toolkit.resources import delivery_runtime

runtime = delivery_runtime()
sys.path.insert(0, str(runtime))
from delivery import DeliveryError
from publisher_adapter import call_launcher

os.environ.pop("DELIVERY_PUBLISHER_ROOT", None)
publisher = runtime / "publisher.py"
mode = publisher.stat().st_mode & 0o777
publisher.chmod(0o644)
try:
    call_launcher(publisher, {})
except DeliveryError as exc:
    assert str(exc) == "publisher launcher failed: trusted publisher root is missing", str(exc)
else:
    raise AssertionError("publisher accepted a packet without a protected root")
finally:
    publisher.chmod(mode)
"""
    result = subprocess.run([str(python), "-c", code], cwd=cwd, env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result
