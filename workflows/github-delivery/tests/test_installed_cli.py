"""Repository discovery and operator profile selection for the installed CLI."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from codex_toolkit import delivery_cli


class RepositoryDiscoveryTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        self.git("init", "-q")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.checkout), *args], capture_output=True, check=True)

    def test_matching_https_ssh_and_push_urls(self):
        self.git("remote", "add", "origin", "https://github.com/Owner/Repo.git")
        self.git("remote", "add", "upstream", "git@github.com:owner/repo.git")
        self.git("remote", "set-url", "--push", "origin", "ssh://git@github.com:22/owner/repo")
        self.assertEqual(delivery_cli.infer_repo(self.checkout), "owner/repo")
        self.git("remote", "set-url", "--push", "origin", "git@github.com:owner/fork")
        with self.assertRaisesRegex(delivery_cli.ConfigurationError, "supply --repo"):
            delivery_cli.infer_repo(self.checkout)

    def test_unsupported_hosts_and_outside_git_require_override(self):
        self.git("remote", "add", "origin", "https://github.com.invalid/owner/repo")
        self.git("remote", "add", "ssh", "git@github.example.com:owner/repo.git")
        for root in (self.checkout, None):
            with self.subTest(root=root), self.assertRaisesRegex(delivery_cli.ConfigurationError, "supply --repo"):
                delivery_cli.infer_repo(root)

    def test_profile_selection_ignores_checkout_and_rejects_symlink(self):
        local = self.checkout / ".config/codex-toolkit/delivery/owner/repo.json"
        local.parent.mkdir(parents=True)
        local.write_text("{}")
        home = self.root / "home"
        with patch("pathlib.Path.home", return_value=home):
            with self.assertRaisesRegex(delivery_cli.ConfigurationError, "configuration is missing"):
                delivery_cli.profile_path(None, "owner/repo", self.checkout)
            default = home / ".config/codex-toolkit/delivery/owner/repo.json"
            default.parent.mkdir(parents=True)
            default.symlink_to(local)
            with self.assertRaisesRegex(delivery_cli.ConfigurationError, "outside the checkout"):
                delivery_cli.profile_path(None, "owner/repo", self.checkout)
            default.unlink()
            default.write_text("{}")
            self.assertEqual(delivery_cli.profile_path(None, "owner/repo", self.checkout), default)
            with self.assertRaisesRegex(delivery_cli.ConfigurationError, "outside the checkout"):
                delivery_cli.profile_path(local, "owner/repo", self.checkout)

    def test_repository_name_cannot_escape_profile_directory(self):
        for value in ("owner/..", "../repo", "github.com/owner/repo", "owner/repo/other"):
            with self.subTest(value=value), self.assertRaises(delivery_cli.ConfigurationError):
                delivery_cli.repo_name(value)
