"""Disposable Git remote and Docker boundary doubles for installed delivery."""

import os
from pathlib import Path
import shutil
import subprocess


GIT_SHIM = """
import os
import sys

args = sys.argv[1:]
for operation in ("ls-remote", "fetch", "push"):
    if operation in args and "protocol.https.allow=always" in args:
        if "protocol.file.allow=always" in args:
            break  # TrustedGit is reading a local candidate bundle.
        assert operation != "push", "delivery attempted a remote write"
        args[args.index("protocol.file.allow=never")] = "protocol.file.allow=always"
        args[args.index("origin", args.index(operation))] = REMOTE
        break
os.execv(GIT, [GIT, *args])
"""


DOCKER_SHIM = """
from hashlib import sha256
import json
from pathlib import Path
import shutil
import sys

args = sys.argv[1:]
with Path(LOG).open("a") as stream:
    stream.write(json.dumps(args) + "\\n")
if args[:2] == ["context", "inspect"]:
    print("unix:///fixture.sock")
elif args[0] == "info":
    print('"fixture"')
elif args[:2] == ["image", "inspect"]:
    assert args[2] == IMAGE
    print(json.dumps([IMAGE]) if args[-1] == "{{json .RepoDigests}}" else "sha256:" + "a" * 64)
else:
    assert args[0] == "run", args
    assert args[args.index("--network") + 1] == "none", args
    mounts = {}
    for index, arg in enumerate(args):
        if arg == "--mount":
            source, destination, *flags = args[index + 1].split(",")[1:]
            mounts[destination.removeprefix("dst=")] = (Path(source.removeprefix("src=")), flags)
    if "/input" in mounts:
        checkout, flags = mounts["/input"]
        assert flags == ["readonly"]
        assert not (checkout / ".git").exists()
        assert (checkout / "README.md").read_text() == "# Implemented fixture\\n"
        assert (checkout / "docs/plan.md").read_text() == "# Fixture plan\\n"
        sys.exit(0)
    packet = json.load(sys.stdin)
    kind = packet["kind"]
    assert packet["schema_version"] == 1 and packet["repo"] == REPO
    assert packet["worktree"] == "/delivery/worktree"
    skills, flags = mounts["/delivery/skills"]
    assert flags == ["readonly"]
    skill = Path(packet["skill"]["path"]).relative_to("/delivery/skills")
    assert sha256((skills / skill).read_bytes()).hexdigest() == packet["skill"]["sha256"]
    package = (skills / skill).parent
    hashes = {path.relative_to(package).as_posix(): sha256(path.read_bytes()).hexdigest()
              for path in package.rglob("*") if path.is_file()}
    digest = sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert digest == packet["skill"]["package_sha256"]
    snapshot, flags = mounts["/delivery/input/github-read-snapshot.json"]
    assert flags == ["readonly"]
    assert sha256(snapshot.read_bytes()).hexdigest() == packet["read_snapshot"]["sha256"]
    assert json.loads(snapshot.read_text())["source"]["sha"] == BASE
    scratch, _ = mounts["/delivery/scratch"]
    shutil.copyfile(BUNDLES[kind], scratch / "candidate.bundle")
    issue = packet["issue"]
    base = {"repo": packet["repo"], "ref": "main", "sha": BASE}
    if kind == "plan":
        result = {"artifact_paths": ["docs/plan.md"],
                  "artifact_hashes": {"docs/plan.md": sha256(b"# Fixture plan\\n").hexdigest()},
                  "plan_revision": PLAN, "issue": issue, "baseline": base}
    else:
        assert kind == "implement"
        assert packet["plan"]["result"]["plan_revision"] == PLAN
        result = {"artifact_paths": ["README.md", "docs/plan.md"], "candidate_sha": IMPLEMENTATION,
                  "base": base, "issue": issue, "verification": ["fixture"]}
    print(json.dumps({key: packet[key] for key in ("schema_version", "kind", "delivery_id", "repo")}
                     | {"result": result}))
"""


def git(*args, git_path=None, cwd=None):
    env = {"PATH": os.environ["PATH"], "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": os.devnull}
    result = subprocess.run([git_path or shutil.which("git"), "-c", "core.hooksPath=/dev/null", *args],
                            cwd=cwd, env=env, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def fixture_tools(root, python, repo, image):
    """Set up a dedicated checkout, exact candidate bundles and local fetch shims."""
    git_path = shutil.which("git")
    checkout = root / "agent-checkout"
    remote = root / "fixture.git"
    bindir = root / "fixture-bin"
    bindir.mkdir()
    launcher = root / "launcher"
    launcher.write_text("#!/bin/sh\nexit 99\n")
    launcher.chmod(0o700)

    git("init", "-q", "-b", "main", str(checkout), git_path=git_path)

    def in_checkout(*args):
        return git(*args, git_path=git_path, cwd=checkout)

    in_checkout("config", "user.name", "Delivery Fixture")
    in_checkout("config", "user.email", "delivery-fixture@example.invalid")
    in_checkout("config", "delivery.agentCheckout", "true")
    (checkout / "README.md").write_text("# Fixture\n")
    in_checkout("add", "README.md")
    in_checkout("commit", "-qm", "Base")
    base = in_checkout("rev-parse", "HEAD")
    git("init", "-q", "--bare", "-b", "main", str(remote), git_path=git_path)
    in_checkout("push", "-q", str(remote), "main")
    in_checkout("switch", "-qc", "delivery-candidate")
    (checkout / "docs").mkdir()
    (checkout / "docs/plan.md").write_text("# Fixture plan\n")
    in_checkout("add", "docs/plan.md")
    in_checkout("commit", "-qm", "Plan")
    plan = in_checkout("rev-parse", "HEAD")
    plan_bundle = root / "plan.bundle"
    in_checkout("bundle", "create", str(plan_bundle), "delivery-candidate", f"^{base}")
    (checkout / "README.md").write_text("# Implemented fixture\n")
    in_checkout("add", "README.md")
    in_checkout("commit", "-qm", "Implement")
    implementation = in_checkout("rev-parse", "HEAD")
    implementation_bundle = root / "implementation.bundle"
    in_checkout("bundle", "create", str(implementation_bundle), "delivery-candidate", f"^{base}")
    in_checkout("switch", "-q", "main")

    docker_log = root / "docker.log"

    def shim(name, constants, body):
        script = bindir / name
        assignments = "\n".join(f"{key} = {value!r}" for key, value in constants.items())
        script.write_text(f"#!{python}\n{assignments}\n{body}")
        script.chmod(0o700)

    shim("git", {"GIT": git_path, "REMOTE": remote.as_uri()}, GIT_SHIM)
    shim("docker", {"REPO": repo, "IMAGE": image, "LOG": str(docker_log), "BASE": base, "PLAN": plan,
                    "IMPLEMENTATION": implementation,
                    "BUNDLES": {"plan": str(plan_bundle), "implement": str(implementation_bundle)}},
         DOCKER_SHIM)
    return {"bin": bindir, "checkout": checkout, "remote": remote, "launcher": launcher,
            "scratch": root / "scratch", "docker_log": docker_log, "git": git_path,
            "base": base, "plan": plan, "implementation": implementation}


def publish_fixture_bundle(tools, handoff):
    """Act as the fixture operator by updating the local remote's owned branch."""
    assert handoff["candidate_ref"] == "refs/heads/delivery-candidate"
    branch_ref = "refs/heads/" + handoff["head"]
    git("--git-dir", str(tools["remote"]), "fetch", "--no-tags", handoff["bundle"],
        f"{handoff['candidate_ref']}:{branch_ref}", git_path=tools["git"])
    head = git("--git-dir", str(tools["remote"]), "rev-parse", branch_ref, git_path=tools["git"])
    assert head == handoff["head_sha"], (head, handoff)
