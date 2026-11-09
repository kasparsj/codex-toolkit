"""Installed entry point for developer-mediated GitHub delivery."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote

from .resources import delivery_runtime, skills_root

RUNTIME = delivery_runtime()
SKILLS = skills_root()
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+")
GITHUB_REMOTE = re.compile(
    r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com(?::22)?/)([^/]+/[^/]+)/?",
    re.IGNORECASE,
)
LOCAL_INPUTS = ("agent_launcher", "worktree", "agent_scratch", "container_image")
CHECK_ERRORS = (RuntimeError, OSError, ValueError, KeyError, TypeError, AttributeError,
                subprocess.SubprocessError)


class ConfigurationError(RuntimeError):
    pass


def repo_name(value):
    if not REPOSITORY.fullmatch(value) or value.split("/")[1] in (".", ".."):
        raise ConfigurationError("use --repo OWNER/REPO for a GitHub.com repository")
    return value.lower()


def git_read(*args):
    # Read the checkout's remotes without using ambient Git settings.
    env = {"PATH": os.environ.get("PATH", ""), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
    return subprocess.run(["git", *args], env=env, capture_output=True, check=False,
                          text=True, timeout=10)


def checkout_root():
    if not shutil.which("git"):
        return None
    result = git_read("rev-parse", "--show-toplevel")
    return Path(result.stdout.strip()).resolve() if result.returncode == 0 else None


def infer_repo(root):
    if root is None:
        raise ConfigurationError("no Git checkout found; supply --repo OWNER/REPO")
    result = git_read("-C", str(root), "remote", "-v")
    if result.returncode:
        raise ConfigurationError("cannot read Git remotes; supply --repo OWNER/REPO")
    repositories = set()
    for record in result.stdout.splitlines():
        url, _, mode = record.partition("\t")[2].rpartition(" ")
        match = GITHUB_REMOTE.fullmatch(url) if mode in ("(fetch)", "(push)") else None
        if match:
            try:
                repositories.add(repo_name(match[1].removesuffix(".git")))
            except ConfigurationError:
                continue
    if len(repositories) != 1:
        raise ConfigurationError(
            "Git remotes must identify one GitHub.com repository; supply --repo OWNER/REPO")
    return repositories.pop()


def profile_path(explicit, repo, root, worktree=None):
    owner, name = repo.split("/")
    default = Path.home() / ".config" / "codex-toolkit" / "delivery" / owner / f"{name}.json"
    path = explicit or default
    if not path.is_absolute():
        raise ConfigurationError("--developer-config must be an absolute path")
    resolved = path.resolve()
    for checkout in (root, worktree.resolve() if worktree is not None else None):
        if checkout is not None and (path.is_relative_to(checkout)
                                     or resolved.is_relative_to(checkout)):
            raise ConfigurationError("developer configuration must be outside the checkout")
    if not path.is_file():
        raise ConfigurationError(
            "developer configuration is missing; provide --developer-config or install the "
            "per-repository profile under ~/.config/codex-toolkit/delivery")
    return path


def load_profile(path, repo):
    import effective_policy

    try:
        profile = effective_policy.load(path)
    except CHECK_ERRORS as exc:
        raise ConfigurationError("cannot load developer configuration; use owner-only JSON "
                                 "in a protected directory") from exc
    configured = profile.get("repository")
    if not isinstance(configured, str) or configured.lower() != repo:
        raise ConfigurationError("developer configuration repository mismatch")
    return profile


def state_directory(profile):
    directory = profile.get("state_dir")
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        raise ConfigurationError("developer configuration requires an absolute state_dir")
    return Path(directory)


def parser():
    result = argparse.ArgumentParser(prog="codex-toolkit", description="Codex Toolkit")
    commands = result.add_subparsers(required=True)
    delivery = commands.add_parser("delivery", help="developer-mediated GitHub delivery")
    operations = delivery.add_subparsers(dest="operation", required=True)
    help_text = {
        "doctor": "check preview and delivery prerequisites",
        "preview": "rank eligible issues using GitHub reads",
        "start": "claim an issue and start delivery",
        "status": "inspect recorded delivery state",
        "resume": "continue a paused or failed delivery",
        "recover": "continue after the recorded runner has died",
    }
    for name, description in help_text.items():
        command = operations.add_parser(name, help=description, description=description)
        command.add_argument("--repo", metavar="OWNER/REPO", help="override Git remote inference")
        command.add_argument("--developer-config", type=Path, metavar="ABS_PATH",
                             help="override the owner-only per-repository profile")
        if name in ("start", "doctor"):
            for key in LOCAL_INPUTS:
                command.add_argument("--" + key.replace("_", "-"),
                                     type=str if key == "container_image" else Path,
                                     required=name == "start")
        if name == "start":
            command.add_argument("--issue", type=int, required=True)
        if name in ("start", "status", "resume", "recover"):
            command.add_argument("--delivery-id")
        if name == "resume":
            command.add_argument("--pr", type=int, help="bind the developer-published planning draft")
            command.add_argument("--result", type=Path, help="submit a correction manifest")
    return result


def run_coordinator(args, repo, config, profile):
    if args.operation == "preview":
        command = ["run", repo, "--preview", "--developer-config", str(config)]
    else:
        import delivery

        state = delivery.validate_protected_state_dir(state_directory(profile))
        command = [args.operation, "--repo", repo, "--state-dir", str(state)]
        if args.delivery_id is not None:
            command += ["--delivery-id", args.delivery_id]
        if args.operation != "status":
            command += ["--skills-root", str(SKILLS)]
        if args.operation == "start":
            command += ["--developer-config", str(config), "--issue", str(args.issue)]
            for key in LOCAL_INPUTS:
                command += ["--" + key.replace("_", "-"), str(getattr(args, key))]
        if args.operation == "resume":
            for key in ("pr", "result"):
                if (value := getattr(args, key)) is not None:
                    command += [f"--{key}", str(value)]
    # The coordinator owns the PID, lease, and exit status of this invocation.
    os.execv(sys.executable, [sys.executable, str(RUNTIME / "delivery.py"), *command])


def report(preview_blockers, delivery_blockers):
    def readiness(blockers):
        return {"status": "blocked" if blockers else "ready", "blockers": blockers}

    print(json.dumps({"preview": readiness(preview_blockers),
                      "delivery": readiness(preview_blockers + delivery_blockers)}, sort_keys=True))
    return 2 if preview_blockers or delivery_blockers else 0


def doctor(args, repo, config, profile):
    import agent_isolation
    import delivery
    import manual
    import onboarding
    import preview

    preview_blockers = []
    delivery_blockers = []

    def check(blockers, diagnostic, operation, *args, **kwargs):
        # Subprocess and profile errors can contain operator values. Emit a fixed diagnostic.
        try:
            return operation(*args, **kwargs)
        except CHECK_ERRORS:
            blockers.append(diagnostic)
            return None

    if sys.version_info < (3, 11) or not os.access(sys.executable, os.X_OK):
        preview_blockers.append("install with an executable Python 3.11 or newer")
    for tool in ("git", "uvx", "docker"):
        if not shutil.which(tool):
            delivery_blockers.append(f"install {tool} and make it available on PATH")
    if profile.get("read_auth") == "gh" and not shutil.which("gh"):
        preview_blockers.append("install gh and sign in to the configured GitHub CLI read session")

    session = None
    if not preview_blockers:
        session = check(preview_blockers, "check the developer profile, repository ID and read authentication",
                        manual.Session, config, repo)
    revision = None
    if session is not None:
        def resolve_policy():
            branch = session.repository()["default_branch"]
            sha = preview.branch_tip(f"repos/{session.repo}", branch, session.reader)
            return sha, session.resolve(session.repo, branch, sha)

        revision = check(preview_blockers, "verify GitHub read access, repository identity and delivery policy",
                         resolve_policy)
    if revision is not None:
        sha, policy = revision

        def verify_publication():
            session.paths([])
            onboarding.reviewer_check(policy, session.reader)
            author = session.reader(f"user/{session.author_id}")
            delivery.require(author.get("id") == session.author_id and author.get("type") == "User",
                             "invalid developer publisher")
            label = policy["tracking"]["review_label"]
            delivery.require(session.reader(f"repos/{session.repo}/labels/{quote(label, safe='')}").get("name")
                             == label, "missing tracking label")

        check(delivery_blockers, "check the developer publisher, human reviewers, tracking label and path allowlist",
              verify_publication)
        check(delivery_blockers, "check the local verifier image, command, Docker access and pinned workflow audit",
              onboarding.verify_local_readiness, session.repo, sha, session.verifier, session.reader)

    state = check(delivery_blockers, "provision the profile's absolute owner-only state_dir",
                  lambda: delivery.validate_protected_state_dir(state_directory(profile)))
    check(delivery_blockers, "reinstall the wheel to restore the bundled delivery workflow, adapters and skills",
          lambda: (delivery.adapter_hashes(), delivery.skill_hashes(SKILLS)))
    missing = [f"--{key.replace('_', '-')}" for key in LOCAL_INPUTS if getattr(args, key) is None]
    if missing:
        delivery_blockers.append("supply " + ", ".join(missing))
    else:
        mounts = check(delivery_blockers, "check the executable launcher, dedicated checkout, scratch and pinned agent image",
                       agent_isolation.validate_local_inputs, launcher=args.agent_launcher,
                       worktree=args.worktree, scratch=args.agent_scratch, skills_root=SKILLS,
                       image=args.container_image, expected_sha=revision[0] if revision else None)
        if mounts is not None:
            if state is not None:
                protected = {"config": config}
                token_file = profile.get("read_token_file")
                if isinstance(token_file, str):
                    protected["read_token_file"] = Path(token_file)
                check(delivery_blockers, "keep the launcher, state, profile and credentials outside the agent mounts",
                      agent_isolation.validate_mount_boundaries, launcher=mounts["launcher"],
                      mounts={name: mounts[name] for name in ("worktree", "scratch", "skills_root")},
                      state_root=state, protected_paths=protected)
            with tempfile.TemporaryDirectory(prefix="codex-toolkit-doctor-") as cli_config:
                check(delivery_blockers, "check the local Docker daemon and pull the pinned agent image",
                      agent_isolation.probe_docker, image=args.container_image, cli_config=Path(cli_config))
    return report(preview_blockers, delivery_blockers)


def main(argv=None):
    args = parser().parse_args(argv)
    sys.path.insert(0, str(RUNTIME))
    try:
        root = checkout_root()
        repo = repo_name(args.repo) if args.repo is not None else infer_repo(root)
        config = profile_path(args.developer_config, repo, root, getattr(args, "worktree", None))
        profile = load_profile(config, repo)
        if args.operation == "doctor":
            return doctor(args, repo, config, profile)
        return run_coordinator(args, repo, config, profile)
    except ConfigurationError as exc:
        message = str(exc)
    except ImportError:
        message = "reinstall the pinned codex-toolkit wheel to restore the delivery modules"
    except CHECK_ERRORS:
        message = "cannot initialize delivery; verify the installation, Git checkout and developer configuration"
    if args.operation == "doctor":
        return report([message], [])
    print(json.dumps({"status": "blocked", "error": message}, sort_keys=True))
    return 2
