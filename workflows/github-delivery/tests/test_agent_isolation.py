import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1]
for name in ("delivery", "agent_isolation"):
    spec = importlib.util.spec_from_file_location(name, MODULE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)

delivery = sys.modules["delivery"]
agent_isolation = sys.modules["agent_isolation"]


class AgentIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.worktree = self.root / "worktree"
        self.scratch = self.root / "scratch"
        self.skills = self.root / "skills"
        self.launcher = self.root / "launcher"
        for path in (self.worktree, self.scratch, self.skills):
            path.mkdir()
        (self.worktree / ".git").mkdir()
        (self.worktree / ".git" / "config").write_text("")
        self.launcher.write_text("#!/bin/sh\nexit 0\n")
        self.launcher.chmod(0o700)
        self.delivery_id = "isolation-test"
        self.repo_state = self.root / "protected" / "repos" / "repo-hash"
        self.publisher_root = self.repo_state / "publisher"
        self.publisher_root.mkdir(parents=True)
        self.snapshot = (self.repo_state / "deliveries" / self.delivery_id
                         / "github-read-snapshot.json")
        self.snapshot.parent.mkdir(parents=True)
        self.snapshot.write_text(json.dumps({
            "schema_version": 1,
            "repo": "github.com/acme/widget",
            "repository": {"id": 123, "full_name": "acme/widget"},
            "source": {"ref": "refs/heads/main", "sha": "a" * 40},
            "issues": [], "pull_requests": [],
            "fetched_at": "2026-11-09T12:00:00Z",
        }))
        self.state = {
            "credential_mode": "app", "repo": "github.com/acme/widget",
            "delivery_id": self.delivery_id, "policy": {"sha": "a" * 40},
            "app": {"repository_id": 123, "repository_full_name": "acme/widget",
                    "publisher_root": str(self.publisher_root),
                    "config": str(self.root / "protected" / "app.json"),
                    "private_key_path": str(self.root / "protected" / "app.pem")},
            "agent": {"isolation_profile": "container",
                      "container_image": "example/agent@sha256:" + "b" * 64,
                      "read_snapshot": str(self.snapshot)},
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_preflight_accepts_pinned_image_dedicated_worktree_and_snapshot(self):
        completed = [SimpleNamespace(returncode=0, stdout="unix:///var/run/docker.sock\n", stderr=""),
                     SimpleNamespace(returncode=0, stdout='"27.4.0"\n', stderr=""),
                     SimpleNamespace(returncode=0, stdout="sha256:" + "b" * 64, stderr="")]
        git_values = [str(self.worktree / ".git"), "true", "", "", "", "", ""]
        with patch.object(agent_isolation, "_git_output", side_effect=git_values), \
             patch.object(agent_isolation.subprocess, "run", side_effect=completed), \
             patch.object(agent_isolation.shutil, "which", return_value=str(self.launcher)):
            profile = agent_isolation.preflight(state=self.state, launcher=self.launcher,
                worktree=self.worktree, scratch=self.scratch, skills_root=self.skills)
        self.assertEqual(profile["snapshot"], self.snapshot.resolve())
        self.assertEqual(len(profile["snapshot_sha256"]), 64)

    def test_preflight_rejects_unpinned_image_before_runtime_probe(self):
        self.state["agent"]["container_image"] = "example/agent:latest"
        with self.assertRaisesRegex(delivery.DeliveryError, "pinned by digest"):
            agent_isolation.preflight(state=self.state, launcher=self.launcher,
                worktree=self.worktree, scratch=self.scratch, skills_root=self.skills)

    def test_preflight_rejects_checkout_with_external_git_metadata(self):
        with patch.object(agent_isolation, "_git_output", return_value=str(self.root / "primary" / ".git")):
            with self.assertRaisesRegex(delivery.DeliveryError, "self-contained"):
                agent_isolation.preflight(state=self.state, launcher=self.launcher,
                    worktree=self.worktree, scratch=self.scratch, skills_root=self.skills)

    def test_checkout_rejects_credential_helper(self):
        values = [str(self.worktree / ".git"), "true", "osxkeychain"]
        with patch.object(agent_isolation, "_git_output", side_effect=values):
            with self.assertRaisesRegex(delivery.DeliveryError, "credential.helper"):
                agent_isolation.validate_checkout(self.worktree)

    def test_snapshot_rejects_wrong_repository(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "repository mismatch"):
            agent_isolation.validate_snapshot(self.snapshot, repo="github.com/acme/other",
                repository_id=123, repository_full_name="acme/widget", policy_sha="a" * 40)

    def test_snapshot_rejects_wrong_identity_or_policy_revision(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "repository ID mismatch"):
            agent_isolation.validate_snapshot(self.snapshot, repo="github.com/acme/widget",
                repository_id=456, repository_full_name="acme/widget", policy_sha="a" * 40)
        with self.assertRaisesRegex(delivery.DeliveryError, "policy SHA mismatch"):
            agent_isolation.validate_snapshot(self.snapshot, repo="github.com/acme/widget",
                repository_id=123, repository_full_name="acme/widget", policy_sha="b" * 40)

    def test_command_has_no_network_and_only_allowlisted_mounts(self):
        profile = {"runtime": "docker", "image": self.state["agent"]["container_image"],
                   "snapshot": self.snapshot, "policy_sha": "a" * 40}
        argv = agent_isolation.command(profile=profile, launcher=self.launcher,
            worktree=self.worktree, scratch=self.scratch, skills_root=self.skills)
        joined = " ".join(str(value) for value in argv)
        self.assertIn("--network none", joined)
        self.assertIn("--interactive", argv)
        self.assertIn("--read-only", argv)
        self.assertIn("no-new-privileges", argv)
        self.assertEqual(argv.count("--mount"), 5)
        self.assertNotIn(str(Path.home()), joined)
        self.assertNotIn("/var/run/docker.sock", joined)
        self.assertNotIn("GH_TOKEN", joined)
        self.assertIn("core.hooksPath=/dev/null", joined)
        self.assertIn("checkout --detach --force", joined)


if __name__ == "__main__":
    unittest.main()
