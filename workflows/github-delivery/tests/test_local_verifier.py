"""Automatic local verification isolation and exact-revision tests."""

from contextlib import contextmanager
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE))
import delivery
import local_verifier
import trusted_git


IMAGE = "example/verify@sha256:" + "a" * 64
SHA = "b" * 40


class FakeTrustedGit:
    def __init__(self, checkout_log):
        self.checkout_log = checkout_log

    def materialize_remote_revision(self, branch, expected_sha, destination):
        self.checkout_log.append((branch, expected_sha))
        (destination / "verify.txt").write_text("exact revision\n")


class LocalVerifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.checkout_log = []

    def factory(self, root, canonical_url):
        self.assertEqual(root, self.root)
        self.assertEqual(canonical_url, "https://github.com/acme/widget.git")
        trusted = FakeTrustedGit(self.checkout_log)

        @contextmanager
        def opened():
            yield trusted

        return opened()

    def exercise(self, inspect, bounded, profile=None):
        with patch.object(local_verifier, "_runtime", return_value=Path("/usr/bin/true")), \
                patch.object(local_verifier.subprocess, "run", return_value=inspect) as process, \
                patch.object(local_verifier, "_run_bounded", return_value=bounded) as runner:
            result = local_verifier.verify(
                root=self.root, git_factory=self.factory,
                canonical_url="https://github.com/acme/widget.git",
                pr={"head": "codex/issue-42", "head_sha": SHA},
                profile=profile or {"image": IMAGE, "argv": ["./scripts/check", "two words"]},
            )
        return result, process, runner

    def test_exact_revision_runs_in_networkless_ephemeral_container(self):
        inspect = SimpleNamespace(returncode=0, stdout=json.dumps([IMAGE]), stderr="")
        result, process, runner = self.exercise(inspect, (0, ""))
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["head_sha"], SHA)
        self.assertEqual(self.checkout_log, [("codex/issue-42", SHA)])
        argv = runner.call_args.args[0]
        self.assertIn("--network", argv)
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        self.assertIn("--read-only", argv)
        self.assertIn("--cap-drop", argv)
        self.assertNotIn("/var/run/docker.sock", " ".join(argv))
        self.assertNotIn(str(Path.home()), " ".join(argv))
        self.assertIn("'two words'", argv[-1])
        mount = argv[argv.index("--mount") + 1]
        checkout = Path(mount.split(",")[1].removeprefix("src="))
        self.assertFalse(checkout.exists(), "verification checkout was not cleaned")

    def test_failed_tests_block_and_sanitize_diagnostic(self):
        inspect = SimpleNamespace(returncode=0, stdout=json.dumps([IMAGE]), stderr="")
        result, _, _ = self.exercise(inspect, (7, "bad?failure"))
        self.assertEqual(result, {
            "status": "blocked", "reason": "local_tests_failed", "head_sha": SHA,
            "exit_code": 7, "duration_seconds": result["duration_seconds"],
            "diagnostic": "bad?failure",
        })

    def test_timeout_force_removes_only_named_container(self):
        inspect = SimpleNamespace(returncode=0, stdout=json.dumps([IMAGE]), stderr="")
        result, _, _ = self.exercise(inspect, (None, ""))
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason"], "local_tests_timed_out")

    def test_unverified_image_digest_never_runs_tests(self):
        inspect = SimpleNamespace(returncode=0, stdout="[]", stderr="")
        result, process, runner = self.exercise(inspect, (0, ""))
        self.assertEqual(result["reason"], "image_digest_unverified")
        self.assertEqual(process.call_count, 1)
        runner.assert_not_called()

    def test_bounded_runner_discards_stdout_caps_stderr_and_removes_timeout(self):
        class Process:
            stderr = io.BytesIO(b"x" * 4000 + b"diagnostic")
            calls = 0

            def wait(self, timeout):
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired(["docker"], timeout)
                return 137

            def kill(self):
                self.killed = True

        process = Process()
        removed = SimpleNamespace(returncode=0)
        with patch.object(local_verifier.subprocess, "Popen", return_value=process) as popen, \
                patch.object(local_verifier.subprocess, "run", return_value=removed) as run:
            returncode, diagnostic = local_verifier._run_bounded(
                ["docker", "run"], env={}, timeout=1, runtime=Path("/usr/bin/true"),
                container="delivery-verify-fixed",
            )
        self.assertIsNone(returncode)
        self.assertLessEqual(len(diagnostic), local_verifier.MAX_DIAGNOSTIC)
        self.assertTrue(diagnostic.endswith("diagnostic"))
        self.assertIs(popen.call_args.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.args[0][-3:],
                         ["rm", "--force", "delivery-verify-fixed"])

    def test_profile_rejects_unpinned_image_and_shell_string(self):
        with self.assertRaisesRegex(local_verifier.delivery.DeliveryError, "registry digest"):
            local_verifier.verify(
                root=self.root, git_factory=self.factory,
                canonical_url="https://github.com/acme/widget.git",
                pr={"head": "codex/issue-42", "head_sha": SHA},
                profile={"image": "example/latest", "argv": ["check"]},
            )
        with self.assertRaisesRegex(local_verifier.delivery.DeliveryError, "string list"):
            local_verifier.verify(
                root=self.root, git_factory=self.factory,
                canonical_url="https://github.com/acme/widget.git",
                pr={"head": "codex/issue-42", "head_sha": SHA},
                profile={"image": IMAGE, "argv": "check"},
            )

    def test_trusted_git_materializes_exact_clean_revision_with_real_git(self):
        source = self.root / "source"
        source.mkdir()
        subprocess.run(["git", "init", "-b", "main"], cwd=source, check=True,
                       stdout=subprocess.DEVNULL)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=source,
                       check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
        (source / "checked.txt").write_text("exact\n")
        subprocess.run(["git", "add", "checked.txt"], cwd=source, check=True)
        subprocess.run(["git", "commit", "-m", "fixture"], cwd=source, check=True,
                       stdout=subprocess.DEVNULL)
        sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, check=True,
                             text=True, capture_output=True).stdout.strip()
        runtime = self.root / "trusted"
        runtime.mkdir()
        bare = runtime / "repo.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True,
                       stdout=subprocess.DEVNULL)
        subprocess.run(["git", "--git-dir", str(bare), "remote", "add", "origin", str(source)],
                       check=True)

        class LocalGit(trusted_git.TrustedGit):
            def _git(self, *args, use_repo=True, allow_file=False, check=True, text=True,
                     lock_fd=None):
                argv = ["git"]
                if use_repo:
                    argv += ["--git-dir", str(self.repo)]
                argv += ["-c", "protocol.file.allow=always", *args]
                result = subprocess.run(argv, cwd=self._runtime, text=text, capture_output=True,
                                        check=False)
                if check and result.returncode:
                    raise delivery.DeliveryError("local Git fixture failed")
                return result

        repository = LocalGit.__new__(LocalGit)
        repository._runtime = runtime
        repository.repo = bare
        destination = self.root / "checkout"
        destination.mkdir()
        repository.materialize_remote_revision("main", sha, destination)
        self.assertEqual((destination / "checked.txt").read_text(), "exact\n")
        self.assertFalse((destination / ".git").exists())
        self.assertFalse(any(path.is_symlink() for path in destination.rglob("*")))


if __name__ == "__main__":
    unittest.main()
