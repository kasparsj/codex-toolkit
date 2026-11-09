from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))
SPEC = importlib.util.spec_from_file_location("github_delivery_trusted_git", MODULE_DIR / "trusted_git.py")
trusted_git = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(trusted_git)


def git(directory: Path, *args: str, input_value: bytes | None = None) -> str:
    result = subprocess.run(["git", "-C", str(directory), *args], input=input_value,
                            capture_output=True, check=True)
    return result.stdout.decode().strip()


class TrustedGitTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.trusted = self.root / "trusted"
        self.source.mkdir()
        self.trusted.mkdir()
        git(self.source, "init", "-q")
        git(self.source, "config", "user.name", "Delivery Test")
        git(self.source, "config", "user.email", "delivery@example.invalid")
        (self.source / "README.md").write_text("base\n")
        git(self.source, "add", "README.md")
        git(self.source, "commit", "-qm", "base")
        self.base = git(self.source, "rev-parse", "HEAD")
        git(self.source, "branch", "delivery-base", self.base)
        (self.source / "docs").mkdir()
        (self.source / "docs" / "plan.md").write_text("reviewed plan\n")
        git(self.source, "add", "docs/plan.md")
        git(self.source, "commit", "-qm", "plan")
        self.candidate = git(self.source, "rev-parse", "HEAD")
        git(self.source, "branch", "delivery-candidate", self.candidate)
        self.bundle = self.root / "candidate.bundle"
        git(self.source, "bundle", "create", str(self.bundle), "refs/heads/delivery-candidate")
        self.plan_hash = hashlib.sha256(b"reviewed plan\n").hexdigest()

    def tearDown(self):
        self.temporary.cleanup()

    def open_git(self):
        return trusted_git.TrustedGit(self.trusted, "https://github.com/acme/widget.git",
                                      auth_env={"GH_TOKEN": "test-token"})

    def test_imports_exact_bundle_and_removes_disposable_repo(self):
        with self.open_git() as repository:
            repository.import_candidate(self.bundle, self.candidate, self.base,
                ["docs/plan.md"], {"docs/plan.md": self.plan_hash})
            runtime = repository._runtime
            self.assertEqual(repository.candidate_sha, self.candidate)
            self.assertEqual(repository.base_sha, self.base)
            self.assertTrue(runtime.is_dir())
        self.assertFalse(runtime.exists())

    def test_app_checks_intermediate_changes_even_if_reverted_in_final_tree(self):
        workflow = ".github/workflows/temporary.yml"
        (self.source / workflow).parent.mkdir(parents=True)
        (self.source / workflow).write_text("temporary workflow\n")
        git(self.source, "add", workflow)
        git(self.source, "commit", "-qm", "add temporary workflow")
        git(self.source, "rm", workflow)
        git(self.source, "commit", "-qm", "remove temporary workflow")
        candidate = git(self.source, "rev-parse", "HEAD")
        git(self.source, "branch", "-f", "delivery-candidate", candidate)
        bundle = self.root / "transient.bundle"
        git(self.source, "bundle", "create", str(bundle), "refs/heads/delivery-candidate")

        def allow_docs(paths):
            if any(not path.startswith("docs/") for path in paths):
                raise trusted_git.delivery.DeliveryError("path outside fixture allowlist")

        with self.open_git() as repository:
            repository.import_candidate(bundle, candidate, self.base, ["docs/plan.md"], None)
            with self.assertRaisesRegex(trusted_git.delivery.DeliveryError, "outside fixture allowlist"):
                repository.verify_introduced_paths(self.base, allow_paths=allow_docs)

    def test_fetches_base_before_importing_incremental_bundle(self):
        incremental = self.root / "incremental.bundle"
        git(self.source, "bundle", "create", str(incremental),
            "refs/heads/delivery-candidate", f"^{self.base}")
        with self.open_git() as repository:
            original_git = repository._git

            def redirect_base_fetch(*args, **kwargs):
                if len(args) > 3 and args[0] == "fetch" and args[3] == "origin":
                    return original_git("fetch", "--no-tags", "--no-write-fetch-head",
                        str(self.source), "refs/heads/delivery-base:refs/delivery/base",
                        allow_file=True)
                return original_git(*args, **kwargs)

            with mock.patch.object(repository, "remote_head", return_value=self.base), \
                    mock.patch.object(repository, "_git", side_effect=redirect_base_fetch):
                repository.fetch_base("main", self.base)
                repository.import_candidate(incremental, self.candidate, self.base,
                    ["docs/plan.md"], {"docs/plan.md": self.plan_hash})

    def test_rejects_wrong_sha_base_paths_and_hash(self):
        cases = (
            ("0" * 40, self.base, ["docs/plan.md"], {"docs/plan.md": self.plan_hash}),
            (self.candidate, "1" * 40, ["docs/plan.md"], {"docs/plan.md": self.plan_hash}),
            (self.candidate, self.base, ["README.md"], {"README.md": self.plan_hash}),
            (self.candidate, self.base, ["docs/plan.md"], {"docs/plan.md": "2" * 64}),
        )
        for values in cases:
            with self.subTest(values=values), self.open_git() as repository:
                with self.assertRaises(Exception):
                    repository.import_candidate(self.bundle, *values)

    def test_allows_implementation_deletion_but_rejects_symlink(self):
        git(self.source, "rm", "docs/plan.md")
        git(self.source, "commit", "-qm", "delete plan")
        deleted = git(self.source, "rev-parse", "HEAD")
        git(self.source, "branch", "-f", "delivery-candidate", deleted)
        deleted_bundle = self.root / "deleted.bundle"
        git(self.source, "bundle", "create", str(deleted_bundle), "refs/heads/delivery-candidate")
        with self.open_git() as repository:
            repository.import_candidate(deleted_bundle, deleted, self.candidate, ["docs/plan.md"], None)

        os.symlink("README.md", self.source / "unsafe-link")
        git(self.source, "add", "unsafe-link")
        git(self.source, "commit", "-qm", "add symlink")
        linked = git(self.source, "rev-parse", "HEAD")
        git(self.source, "branch", "-f", "delivery-candidate", linked)
        linked_bundle = self.root / "linked.bundle"
        git(self.source, "bundle", "create", str(linked_bundle), "refs/heads/delivery-candidate")
        with self.open_git() as repository, self.assertRaisesRegex(Exception, "unsupported Git object"):
            repository.import_candidate(linked_bundle, linked, deleted, ["unsafe-link"], None)

    def test_ignores_hostile_git_environment_and_disables_hooks(self):
        hostile = self.root / "hostile-config"
        hostile.write_text("[url \"file:///tmp/attacker\"]\n\tinsteadOf = https://github.com/\n")
        values = {"GIT_CONFIG_GLOBAL": str(hostile), "GIT_CONFIG_COUNT": "1",
                  "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/tmp/hooks",
                  "GIT_DIR": "/tmp/attacker.git", "GIT_WORK_TREE": "/tmp/attacker"}
        with mock.patch.dict(os.environ, values, clear=False), self.open_git() as repository:
            environment = repository._environment()
            for name in ("GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
                         "GIT_DIR", "GIT_WORK_TREE"):
                self.assertNotIn(name, environment)
            self.assertEqual(environment["GIT_CONFIG_GLOBAL"], os.devnull)
            configured = repository._git("config", "--get", "core.hooksPath").stdout.strip()
            self.assertEqual(configured, "/dev/null")

    def test_push_uses_exact_lease_and_fast_forward_check(self):
        with self.open_git() as repository:
            repository.import_candidate(self.bundle, self.candidate, self.base,
                ["docs/plan.md"], {"docs/plan.md": self.plan_hash})
            repository._git("update-ref", "refs/delivery/previous", self.base)
            original_git = repository._git
            observed = []

            def fake_git(*args, **kwargs):
                if args[0] in {"fetch", "push"}:
                    observed.append(args)
                    return subprocess.CompletedProcess(args, 0, "", "")
                return original_git(*args, **kwargs)

            with mock.patch.object(repository, "remote_head",
                                   side_effect=[self.base, self.candidate]), \
                    mock.patch.object(repository, "_git", side_effect=fake_git):
                repository.push("codex/delivery", self.candidate, self.base)
            self.assertIn(("push", "--porcelain",
                f"--force-with-lease=refs/heads/codex/delivery:{self.base}", "origin",
                f"{self.candidate}:refs/heads/codex/delivery"), observed)

    def test_rejects_noncanonical_remote_and_unsafe_paths(self):
        for url in ("git@github.com:acme/widget.git", "https://example.com/acme/widget.git",
                    "https://user@github.com/acme/widget.git", "https://github.com/acme/widget/extra"):
            with self.subTest(url=url), self.assertRaises(Exception):
                trusted_git.TrustedGit(self.trusted, url)
        with self.open_git() as repository, self.assertRaises(Exception):
            repository.import_candidate(self.bundle, self.candidate, self.base, ["../escape"], None)
        linked_bundle = self.root / "linked.bundle"
        linked_bundle.symlink_to(self.bundle)
        with self.open_git() as repository, self.assertRaisesRegex(Exception, "must not be a symlink"):
            repository.import_candidate(linked_bundle, self.candidate, self.base,
                                        ["docs/plan.md"], None)
        fifo = self.root / "bundle.fifo"
        os.mkfifo(fifo)
        with self.open_git() as repository, self.assertRaisesRegex(Exception, "regular file"):
            repository.import_candidate(fifo, self.candidate, self.base, ["docs/plan.md"], None)

    def test_resolves_cached_gh_token_once_and_uses_scratch_home(self):
        repository = trusted_git.TrustedGit(self.trusted, "https://github.com/acme/widget.git",
                                            auth_env={"PATH": os.environ["PATH"], "HOME": "/trusted/home"})
        result = subprocess.CompletedProcess([], 0, "cached-token\n", "")
        with mock.patch.object(trusted_git.subprocess, "run", return_value=result) as invoked:
            self.assertEqual(repository._resolve_token(), "cached-token")
        command = invoked.call_args.args[0]
        environment = invoked.call_args.kwargs["env"]
        self.assertEqual(command, ["gh", "auth", "token", "--hostname", "github.com"])
        self.assertEqual(environment["HOME"], "/trusted/home")

    def test_app_mode_requires_explicit_token_and_never_reads_ambient_auth(self):
        repository = trusted_git.TrustedGit(
            self.trusted, "https://github.com/acme/widget.git",
            auth_env={"PATH": os.environ["PATH"], "HOME": "/trusted/home"},
            require_explicit_token=True,
        )
        with mock.patch.object(trusted_git.subprocess, "run") as invoked, \
                self.assertRaisesRegex(Exception, "explicit GitHub token"):
            repository._resolve_token()
        invoked.assert_not_called()


if __name__ == "__main__":
    unittest.main()
