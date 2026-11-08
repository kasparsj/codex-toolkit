#!/usr/bin/env python3
"""Trusted Git boundary for publisher-side candidate verification and pushes."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
from urllib.parse import urlparse

import delivery


FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
OWNER_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
CANDIDATE_REF = "refs/heads/delivery-candidate"


class TrustedGit:
    """A disposable bare repository isolated from agent-controlled Git state."""

    def __init__(self, root: Path, canonical_url: str,
                 auth_env: dict[str, str] | None = None):
        self.root = root.resolve()
        self.canonical_url = self._validate_canonical_url(canonical_url)
        self._auth_env = dict(auth_env) if auth_env is not None else None
        self._token: str | None = None
        self.repo: Path | None = None
        self._runtime: Path | None = None
        self.candidate_sha: str | None = None
        self.base_sha: str | None = None

    def __enter__(self) -> "TrustedGit":
        delivery.require(self.root.is_dir(), "trusted Git root must already exist")
        delivery.require(not self.root.is_symlink(), "trusted Git root must not be a symlink")
        self._runtime = Path(tempfile.mkdtemp(prefix="publisher-git-", dir=self.root))
        os.chmod(self._runtime, 0o700)
        self._token = self._resolve_token()
        self.repo = self._runtime / "repo.git"
        self._git("init", "--bare", str(self.repo), use_repo=False)
        self._git("remote", "add", "origin", self.canonical_url)
        return self

    def __exit__(self, _kind, _value, _traceback) -> None:
        runtime = self._runtime
        self.repo = None
        self._runtime = None
        self.candidate_sha = None
        self.base_sha = None
        self._token = None
        if runtime is not None:
            delivery.require(runtime.parent == self.root and runtime.name.startswith("publisher-git-"),
                             "refusing unsafe trusted Git cleanup")
            shutil.rmtree(runtime)

    def import_candidate(self, bundle_path: Path, sha: str, base_sha: str,
                         paths: list[str], hashes: dict[str, str] | None) -> None:
        self._require_open()
        self._require_sha(sha, "candidate")
        self._require_sha(base_sha, "base")
        delivery.require(not bundle_path.is_symlink(), "candidate bundle must not be a symlink")
        assert self._runtime is not None
        bundle = self._runtime / "candidate.bundle"
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            source_fd = os.open(bundle_path, flags)
            with os.fdopen(source_fd, "rb") as source:
                delivery.require(stat.S_ISREG(os.fstat(source.fileno()).st_mode),
                                 "candidate bundle must be a regular file")
                with bundle.open("xb") as target:
                    shutil.copyfileobj(source, target)
                    target.flush()
                    os.fsync(target.fileno())
        except OSError as exc:
            raise delivery.DeliveryError(f"cannot stage candidate bundle: {exc}") from exc
        delivery.require(bundle.is_file(), "candidate bundle must be a regular file")
        normalized_paths = self._validate_paths(paths)
        if hashes is not None:
            delivery.require(set(hashes) == set(normalized_paths),
                             "artifact hashes must cover exactly the changed paths")
            delivery.require(all(SHA256.fullmatch(value) for value in hashes.values()),
                             "artifact hashes must be lowercase SHA-256 values")

        advertised = self._git("bundle", "list-heads", str(bundle), CANDIDATE_REF,
                               use_repo=False, allow_file=True).stdout.splitlines()
        delivery.require(advertised == [f"{sha} {CANDIDATE_REF}"],
                         "bundle must advertise the exact candidate ref and SHA")
        self._git("bundle", "verify", str(bundle), allow_file=True)
        self._git("fetch", "--no-tags", "--no-write-fetch-head", str(bundle),
                  f"{CANDIDATE_REF}:refs/delivery/candidate", allow_file=True)
        delivery.require(self._rev_parse("refs/delivery/candidate^{commit}") == sha,
                         "imported candidate SHA mismatch")
        delivery.require(self._object_exists(f"{base_sha}^{{commit}}"),
                         "bundle does not contain the expected base commit")
        ancestor = self._git("merge-base", "--is-ancestor", base_sha, sha, check=False)
        delivery.require(ancestor.returncode == 0, "candidate is not based on the expected base")

        actual_paths = self._diff_paths(base_sha, sha)
        delivery.require(actual_paths, "candidate must change at least one path")
        delivery.require(actual_paths == normalized_paths, "candidate changed paths do not match manifest")
        for path in actual_paths:
            entry = self._tree_entry(sha, path)
            if entry is None:
                delivery.require(hashes is None, "hashed plan artifacts may not be deleted")
                continue
            mode, kind, oid = entry
            delivery.require(mode not in {"120000", "160000"} and kind == "blob",
                             f"candidate path has unsupported Git object type: {path}")
            delivery.require(mode in {"100644", "100755"},
                             f"candidate path has unsupported mode: {path}")
            if hashes is not None:
                blob = self._git("cat-file", "blob", oid, text=False).stdout
                delivery.require(hashlib.sha256(blob).hexdigest() == hashes[path],
                                 f"artifact hash mismatch: {path}")
        self.candidate_sha = sha
        self.base_sha = base_sha

    def fetch_base(self, branch: str, expected_sha: str) -> None:
        """Fetch and pin the exact current base required by an incremental bundle."""
        self._require_open()
        self._require_sha(expected_sha, "base")
        ref = self._branch_ref(branch)
        delivery.require(self.remote_head(branch) == expected_sha,
                         "remote base branch moved before candidate import")
        self._git("fetch", "--no-tags", "--no-write-fetch-head", "origin",
                  f"{ref}:refs/delivery/base")
        delivery.require(self._rev_parse("refs/delivery/base^{commit}") == expected_sha,
                         "fetched base SHA mismatch")

    def remote_head(self, branch: str) -> str | None:
        self._require_open()
        ref = self._branch_ref(branch)
        result = self._git("ls-remote", "--heads", "origin", ref)
        lines = [line for line in result.stdout.splitlines() if line]
        if not lines:
            return None
        delivery.require(len(lines) == 1, "remote returned multiple branch heads")
        fields = lines[0].split("\t")
        delivery.require(len(fields) == 2 and fields[1] == ref and FULL_SHA.fullmatch(fields[0]),
                         "remote returned an invalid branch head")
        return fields[0]

    def push(self, branch: str, sha: str, previous: str | None) -> None:
        self._require_open()
        self._require_sha(sha, "candidate")
        delivery.require(sha == self.candidate_sha, "push SHA is not the imported candidate")
        if previous is not None:
            self._require_sha(previous, "previous remote")
        ref = self._branch_ref(branch)
        current = self.remote_head(branch)
        delivery.require(current == previous, "remote branch changed before push")
        if previous is not None:
            self._git("fetch", "--no-tags", "--no-write-fetch-head", "origin",
                      f"{ref}:refs/delivery/previous")
            delivery.require(self._rev_parse("refs/delivery/previous^{commit}") == previous,
                             "fetched remote head changed before push")
            ancestor = self._git("merge-base", "--is-ancestor", previous, sha, check=False)
            delivery.require(ancestor.returncode == 0,
                             "candidate is not a fast-forward of the previous remote head")
        expected = previous or ""
        self._git("push", "--porcelain", f"--force-with-lease={ref}:{expected}",
                  "origin", f"{sha}:{ref}")
        delivery.require(self.remote_head(branch) == sha, "remote branch readback mismatch")

    def require_material_change(self, previous: str) -> None:
        """Require the imported candidate to change the prior commit's tree."""
        self._require_open()
        self._require_sha(previous, "superseded")
        delivery.require(self.candidate_sha is not None, "candidate has not been imported")
        delivery.require(self._object_exists(f"{previous}^{{commit}}"),
                         "bundle does not contain the superseded commit")
        ancestor = self._git("merge-base", "--is-ancestor", previous, self.candidate_sha,
                             check=False)
        delivery.require(ancestor.returncode == 0,
                         "corrected candidate is not a fast-forward of the superseded commit")
        delivery.require(
            self._rev_parse(f"{previous}^{{tree}}") != self._rev_parse(f"{self.candidate_sha}^{{tree}}"),
            "correction must change committed material",
        )

    @staticmethod
    def _validate_canonical_url(value: str) -> str:
        parsed = urlparse(value)
        path = parsed.path.removeprefix("/").removesuffix(".git")
        delivery.require(parsed.scheme == "https" and parsed.hostname == "github.com",
                         "canonical remote must use HTTPS github.com")
        delivery.require(parsed.port is None and not parsed.username and not parsed.password,
                         "canonical remote may not contain credentials or a port")
        delivery.require(not parsed.query and not parsed.fragment and OWNER_REPO.fullmatch(path),
                         "canonical remote must identify one GitHub repository")
        return f"https://github.com/{path}.git"

    @staticmethod
    def _require_sha(value: str, label: str) -> None:
        delivery.require(bool(FULL_SHA.fullmatch(value)), f"{label} SHA must be full lowercase SHA")

    @staticmethod
    def _validate_paths(paths: list[str]) -> list[str]:
        delivery.require(isinstance(paths, list) and paths, "candidate paths must be nonempty")
        normalized: list[str] = []
        for value in paths:
            delivery.require(isinstance(value, str) and value and "\x00" not in value,
                             "candidate path must be a nonempty string")
            path = PurePosixPath(value)
            delivery.require(not path.is_absolute() and value == path.as_posix(),
                             f"candidate path is not normalized: {value!r}")
            delivery.require(all(part not in {"", ".", ".."} for part in path.parts),
                             f"candidate path escapes repository: {value!r}")
            delivery.require(not value.startswith("-"), f"candidate path starts with '-': {value!r}")
            normalized.append(value)
        delivery.require(len(normalized) == len(set(normalized)), "candidate paths must be unique")
        return sorted(normalized)

    def _branch_ref(self, branch: str) -> str:
        delivery.require(isinstance(branch, str) and branch and not branch.startswith("-"),
                         "invalid branch name")
        checked = self._git("check-ref-format", "--branch", branch, use_repo=False, check=False)
        delivery.require(checked.returncode == 0, "invalid branch name")
        return f"refs/heads/{branch}"

    def _diff_paths(self, base_sha: str, sha: str) -> list[str]:
        output = self._git("diff", "--name-only", "-z", "--no-renames", base_sha, sha,
                           text=False).stdout
        return sorted(part.decode("utf-8", "surrogateescape") for part in output.split(b"\0") if part)

    def _tree_entry(self, sha: str, path: str) -> tuple[str, str, str] | None:
        output = self._git("ls-tree", "-z", sha, "--", path, text=False).stdout
        if not output:
            return None
        records = [record for record in output.split(b"\0") if record]
        delivery.require(len(records) == 1, f"ambiguous tree entry: {path}")
        metadata, returned_path = records[0].split(b"\t", 1)
        delivery.require(returned_path.decode("utf-8", "surrogateescape") == path,
                         f"tree entry path mismatch: {path}")
        mode, kind, oid = metadata.decode("ascii").split(" ")
        return mode, kind, oid

    def _rev_parse(self, revision: str) -> str:
        return self._git("rev-parse", "--verify", revision).stdout.strip()

    def _object_exists(self, revision: str) -> bool:
        return self._git("cat-file", "-e", revision, check=False).returncode == 0

    def _git(self, *args: str, use_repo: bool = True, allow_file: bool = False,
             check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
        if use_repo:
            self._require_open()
        argv = ["git", "--no-optional-locks"]
        if use_repo:
            argv += ["--git-dir", str(self.repo)]
        argv += ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=!gh auth git-credential"]
        argv += ["-c", f"protocol.file.allow={'always' if allow_file else 'never'}"]
        argv += ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
                 "-c", "http.followRedirects=false", *args]
        network = args[0] in {"ls-remote", "fetch", "push"} and not allow_file
        completed = subprocess.run(argv, cwd=self._runtime,
                                   env=self._environment(include_token=network), capture_output=True,
                                   text=text, check=False)
        if check and completed.returncode:
            stderr = completed.stderr.strip() if text else completed.stderr.decode(errors="replace").strip()
            raise delivery.DeliveryError(f"trusted Git command failed ({args[0]}): {stderr}")
        return completed

    def _environment(self, *, include_token: bool = True) -> dict[str, str]:
        self._require_open(require_repo=False)
        assert self._runtime is not None
        runtime_home = self._runtime / "home"
        runtime_home.mkdir(mode=0o700, exist_ok=True)
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(runtime_home),
               "XDG_CONFIG_HOME": str(runtime_home / ".config"), "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0",
               "GIT_SSH_COMMAND": "false", "GIT_ASKPASS": "false", "SSH_ASKPASS": "false",
               "LC_ALL": "C"}
        if self._token and include_token:
            env["GH_TOKEN"] = self._token
        env["GH_HOST"] = "github.com"
        return env

    def _resolve_token(self) -> str | None:
        source = self._auth_env if self._auth_env is not None else os.environ
        token = source.get("GH_TOKEN") or source.get("GITHUB_TOKEN")
        if token:
            return token
        environment = {name: source[name] for name in
                       ("PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME") if source.get(name)}
        environment["GH_HOST"] = "github.com"
        result = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"],
                                env=environment, capture_output=True, text=True, check=False)
        if result.returncode:
            return None
        resolved = result.stdout.strip()
        delivery.require(bool(resolved) and "\n" not in resolved and "\r" not in resolved,
                         "gh returned an invalid authentication token")
        return resolved

    def _require_open(self, require_repo: bool = True) -> None:
        delivery.require(self._runtime is not None, "trusted Git context is not open")
        if require_repo:
            delivery.require(self.repo is not None and self.repo.is_dir(),
                             "trusted bare repository is unavailable")
