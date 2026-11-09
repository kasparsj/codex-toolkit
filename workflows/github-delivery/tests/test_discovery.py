from __future__ import annotations

import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))
SPEC = importlib.util.spec_from_file_location("github_delivery_discovery",
                                              MODULE_DIR / "discovery.py")
discovery = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = discovery
SPEC.loader.exec_module(discovery)

NOW = dt.datetime(2026, 11, 9, 10, 0, tzinfo=dt.timezone.utc)


class FakeApi:
    def __init__(self, profile):
        self.profile = profile
        self.requests = []
        self.installation = {
            "id": 31, "account": {"id": 41}, "app_id": profile.app_id,
            "app_slug": profile.app_slug, "target_id": 41, "suspended_at": None,
            "repository_selection": "selected", "permissions": profile.permissions,
        }
        self.repository = {"id": 51, "full_name": "acme/fixture", "default_branch": "main",
                           "owner": {"id": 41}}
        self.tokens = 0

    def request(self, method, path, *, token, payload=None):
        self.requests.append((method, path, token, payload))
        if path == "/app":
            return {"id": self.profile.app_id, "client_id": self.profile.client_id,
                    "slug": self.profile.app_slug, "permissions": self.profile.permissions}
        if path == "/repos/acme/fixture/installation":
            return copy.deepcopy(self.installation)
        if path.startswith("/app/installations/") and path.endswith("/access_tokens"):
            self.tokens += 1
            permissions = payload["permissions"]
            response = {
                "token": f"token-{self.tokens}", "permissions": permissions,
                "expires_at": (NOW + dt.timedelta(minutes=55)).isoformat(),
            }
            if "repository_ids" in payload:
                response["repositories"] = [copy.deepcopy(self.repository)]
            return response
        if path == "/installation/token":
            return {}
        if path == "/users/delivery-fixture%5Bbot%5D":
            return {"id": 21, "login": "delivery-fixture[bot]", "type": "Bot"}
        if path == "/repos/acme/fixture":
            return copy.deepcopy(self.repository)
        raise AssertionError(path)

    def paginated(self, path, *, token):
        self.requests.append(("GET-PAGES", path, token, None))
        if path.startswith("/app/installations"):
            return [copy.deepcopy(self.installation)]
        if path == "/installation/repositories":
            return [copy.deepcopy(self.repository)]
        raise AssertionError(path)


class DiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.key = self.root / "app.pem"
        self.key.write_text("key")
        self.key.chmod(0o600)
        self.path = self.root / "profile.json"
        self.value = {
            "schema_version": 1, "host": "github.com",
            "app": {"id": 11, "client_id": "Iv1.fixture", "slug": "delivery-fixture",
                    "bot_user_id": 21},
            "allowed_account_ids": [41],
            "permissions": {"actions": "read", "contents": "write", "issues": "write",
                            "metadata": "read", "pull_requests": "write"},
            "private_key_path": str(self.key),
        }
        self.write()

    def tearDown(self):
        self.temporary.cleanup()

    def write(self):
        self.path.write_text(json.dumps(self.value, sort_keys=True))
        self.path.chmod(0o600)

    def profile(self):
        return discovery.OperatorAppProfile.load(self.path)

    def client(self, profile=None, api=None):
        profile = profile or self.profile()
        api = api or FakeApi(profile)
        return discovery.AppDiscovery(profile, api=api,
                                      jwt_factory=lambda _profile: "app-jwt",
                                      now=lambda: NOW), api

    def test_discovers_selected_repository_with_metadata_only_token_and_revokes(self):
        client, api = self.client()
        inventory = client.discover("acme/fixture")
        repository = inventory.repository("ACME/FIXTURE")
        self.assertEqual(repository.default_branch, "main")
        token_calls = [call for call in api.requests if call[1].endswith("/access_tokens")]
        self.assertEqual(token_calls[0][3], {"permissions": {"metadata": "read"}})
        self.assertIn(("DELETE", "/installation/token", "token-1", None), api.requests)
        self.assertIn(("GET", "/repos/acme/fixture/installation", "app-jwt", None), api.requests)
        self.assertNotIn("token", json.dumps(inventory.evidence()))

    def test_repeat_discovery_reflects_removal_without_persisting_a_binding(self):
        client, api = self.client()
        first = client.discover()
        self.assertEqual(len(first.repositories), 1)
        api.repository = None

        original_paginated = api.paginated
        def removed(path, *, token):
            if path == "/installation/repositories":
                api.requests.append(("GET-PAGES", path, token, None))
                return []
            return original_paginated(path, token=token)
        api.paginated = removed
        second = client.discover()
        self.assertEqual(second.repositories, ())
        with self.assertRaisesRegex(Exception, "not uniquely selected"):
            client.discover("acme/fixture")

    def test_rejects_account_suspension_permission_and_identity_drift(self):
        for mutate in (
            lambda api: api.installation.update(account={"id": 99}, target_id=99),
            lambda api: api.installation.update(suspended_at="2026-11-09T09:00:00Z"),
            lambda api: api.installation.update(repository_selection="all"),
            lambda api: api.installation.update(permissions={"metadata": "read"}),
            lambda api: api.repository.update(owner={"id": 99}, full_name="other/fixture"),
        ):
            client, api = self.client()
            mutate(api)
            with self.subTest(mutate=mutate), self.assertRaises(Exception):
                client.discover()

    def test_mints_distinct_single_repository_read_token_after_fresh_discovery(self):
        client, api = self.client()
        session = client.mint_repository("acme/fixture", {
            "metadata": "read", "contents": "read", "issues": "read",
            "pull_requests": "read",
        })
        self.assertEqual(session.repository.repository_id, 51)
        self.assertEqual(session.auth_env()["GH_HOST"], "github.com")
        token_calls = [call for call in api.requests if call[1].endswith("/access_tokens")]
        self.assertEqual(token_calls[-1][3], {
            "repository_ids": [51],
            "permissions": {"contents": "read", "issues": "read", "metadata": "read",
                            "pull_requests": "read"},
        })
        session.revoke(api)
        with self.assertRaisesRegex(Exception, "exceed"):
            client.mint_repository("acme/fixture", {"checks": "read"})

    def test_preview_profile_cannot_construct_publication_binding(self):
        profile = self.profile()
        repository = discovery.DiscoveredRepository(31, 41, 51, "acme/fixture", "main")
        with self.assertRaisesRegex(Exception, "not configured for publication"):
            profile.binding_value(repository)

    def test_publication_profile_writes_loadable_existing_binding(self):
        self.value["publication"] = {
            "state_dir": str(self.state), "allowed_path_prefixes": ["docs/", "src/"],
            "ci": None,
            "local_verifier": {
                "image": "registry.example.test/checks@sha256:" + "a" * 64,
                "argv": ["/verify"], "audited_workflows": {},
            },
        }
        self.write()
        profile = self.profile()
        repository = discovery.DiscoveredRepository(31, 41, 51, "acme/fixture", "main")
        binding_path = self.root / "binding.json"
        binding = profile.write_binding(repository, binding_path)
        self.assertEqual(binding.repository, "acme/fixture")
        self.assertEqual(binding.installation_id, 31)
        self.assertEqual(binding.digest, hashlib.sha256(binding_path.read_bytes()).hexdigest())
        self.assertEqual(binding_path.stat().st_mode & 0o777, 0o600)

    def test_profile_rejects_unprotected_or_unallowed_configuration(self):
        self.path.chmod(0o644)
        with self.assertRaisesRegex(Exception, "only by its owner"):
            self.profile()
        self.path.chmod(0o600)
        self.value["allowed_account_ids"] = []
        self.write()
        with self.assertRaisesRegex(Exception, "allowed accounts"):
            self.profile()


if __name__ == "__main__":
    unittest.main()
