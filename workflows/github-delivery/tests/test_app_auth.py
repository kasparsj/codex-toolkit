from __future__ import annotations

import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))
SPEC = importlib.util.spec_from_file_location("github_delivery_app_auth", MODULE_DIR / "app_auth.py")
app_auth = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = app_auth
SPEC.loader.exec_module(app_auth)


NOW = dt.datetime(2026, 11, 9, 10, 0, tzinfo=dt.timezone.utc)


class FakeApi:
    def __init__(self, binding):
        self.binding = binding
        self.requests = []
        self.app = {"id": binding.app_id, "client_id": binding.client_id,
                    "slug": binding.app_slug, "permissions": binding.permissions}
        self.installation = {
            "id": binding.installation_id,
            "account": {"id": binding.account_id},
            "app_id": binding.app_id,
            "app_slug": binding.app_slug,
            "target_id": binding.account_id,
            "suspended_at": None,
            "repository_selection": "selected",
            "permissions": binding.permissions,
        }
        self.repository_installation = copy.deepcopy(self.installation)
        self.scoped = {
            "token": "installation-token",
            "expires_at": (NOW + dt.timedelta(minutes=55)).isoformat(),
            "permissions": binding.permissions,
            "repositories": [{"id": binding.repository_id, "full_name": binding.repository}],
        }
        self.repository = {"id": binding.repository_id, "full_name": binding.repository}
        self.repositories = [self.repository]
        self.bot = {"id": binding.bot_user_id, "login": binding.bot_login, "type": "Bot"}

    def request(self, method, path, *, token, payload=None):
        self.requests.append((method, path, token, payload))
        if path == "/app":
            return copy.deepcopy(self.app)
        if path.startswith("/app/installations/") and path.endswith("/access_tokens"):
            self.token_request = payload
            return copy.deepcopy(self.scoped)
        if path.startswith("/app/installations/"):
            return copy.deepcopy(self.installation)
        if path.endswith("/installation"):
            return copy.deepcopy(self.repository_installation)
        if path.startswith("/repos/"):
            return copy.deepcopy(self.repository)
        if path.startswith("/users/"):
            return copy.deepcopy(self.bot)
        raise AssertionError(path)

    def paginated(self, path, *, token):
        self.requests.append(("GET-PAGES", path, token, None))
        return copy.deepcopy(self.repositories)


class AppAuthTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.key = self.root / "app.pem"
        self.key.write_text("private-key-placeholder\n")
        self.key.chmod(0o600)
        self.config = self.root / "app.json"
        self.value = {
            "schema_version": 1,
            "host": "github.com",
            "app": {"id": 11, "client_id": "Iv1.fixture", "slug": "delivery-fixture",
                    "bot_user_id": 22},
            "installation": {"id": 33, "account_id": 44},
            "repository": {"id": 55, "full_name": "acme/private-fixture"},
            "permissions": {"metadata": "read", "contents": "write",
                            "pull_requests": "write", "issues": "read", "actions": "read"},
            "private_key_path": str(self.key),
            "state_dir": str(self.state),
            "allowed_path_prefixes": ["docs/", "src/"],
            "ci": {"workflow_id": 66, "workflow_path": ".github/workflows/ci.yml",
                   "workflow_sha256": "a" * 64,
                   "event": "pull_request", "required_job": "test"},
        }
        self._write_config()

    def tearDown(self):
        self.temporary.cleanup()

    def _write_config(self):
        self.config.write_text(json.dumps(self.value, sort_keys=True))
        self.config.chmod(0o600)

    def binding(self):
        digest = hashlib.sha256(self.config.read_bytes()).hexdigest()
        return app_auth.AppBinding.load(self.config, expected_digest=digest)

    def test_issues_write_can_be_pinned_for_tracking(self):
        self.value["permissions"]["issues"] = "write"
        self._write_config()
        session, _ = self.mint()
        self.assertEqual(session.binding.permissions["issues"], "write")

    def mint(self, binding=None, api=None):
        binding = binding or self.binding()
        api = api or FakeApi(binding)
        session = app_auth.AppAuthenticator(
            binding, api=api, jwt_factory=lambda _binding: "app-jwt", now=lambda: NOW,
        ).mint()
        return session, api

    def test_loads_protected_binding_and_mints_repository_scoped_token(self):
        binding = self.binding()
        session, api = self.mint(binding)
        self.assertEqual(session.auth_env(), {"GH_TOKEN": "installation-token",
                                              "GH_HOST": "github.com"})
        self.assertEqual(api.token_request, {
            "repository_ids": [55], "permissions": binding.permissions,
        })
        self.assertIn(("GET", "/repos/acme/private-fixture/installation", "app-jwt", None),
                      api.requests)
        self.assertEqual(session.identity_evidence()["repository_id"], 55)
        self.assertNotIn("token", session.identity_evidence())
        binding.verify_candidate_paths(["docs/plan.md", "src/change.py"])
        with self.assertRaisesRegex(Exception, "outside the App allowlist"):
            binding.verify_candidate_paths([".github/workflows/ci.yml"])

    def test_rejects_app_identity_mismatches_before_mint(self):
        binding = self.binding()
        for field, value in (("id", 999), ("client_id", "wrong"), ("slug", "wrong")):
            with self.subTest(field=field):
                api = FakeApi(binding)
                api.app[field] = value
                with self.assertRaisesRegex(Exception, "GitHub App"):
                    self.mint(binding, api)
                self.assertFalse(any(path.endswith("access_tokens")
                                     for _, path, _, _ in api.requests))

    def test_rejects_installation_account_permissions_and_suspension_before_mint(self):
        binding = self.binding()
        mutations = (
            ("id", 999),
            ("account", {"id": 999}),
            ("suspended_at", "2026-11-09T09:00:00Z"),
            ("repository_selection", "all"),
            ("permissions", {"metadata": "read"}),
        )
        for field, value in mutations:
            with self.subTest(field=field):
                api = FakeApi(binding)
                api.installation[field] = value
                with self.assertRaises(Exception):
                    self.mint(binding, api)
                self.assertFalse(any(path.endswith("access_tokens")
                                     for _, path, _, _ in api.requests))

    def test_rejects_token_scope_repo_bot_and_expiry_mismatches(self):
        binding = self.binding()
        cases = []
        api = FakeApi(binding); api.scoped["permissions"] = {"metadata": "read"}; cases.append(api)
        api = FakeApi(binding); api.repositories = []; cases.append(api)
        api = FakeApi(binding); api.repositories[0] = {**api.repository, "id": 999}; cases.append(api)
        api = FakeApi(binding); api.repository["full_name"] = "acme/wrong"; cases.append(api)
        api = FakeApi(binding); api.bot["id"] = 999; cases.append(api)
        api = FakeApi(binding); api.scoped["expires_at"] = NOW.isoformat(); cases.append(api)
        for api in cases:
            with self.subTest(api=api):
                with self.assertRaises(Exception):
                    self.mint(binding, api)
                self.assertIn(("DELETE", "/installation/token", "installation-token", None),
                              api.requests)

    def test_rejects_app_profile_and_repository_installation_drift_before_mint(self):
        binding = self.binding()
        for mutate in (
            lambda api: api.app.update(permissions={"metadata": "read"}),
            lambda api: api.repository_installation.update(app_id=999),
            lambda api: api.repository_installation.update(app_slug="other"),
            lambda api: api.repository_installation.update(target_id=999),
            lambda api: api.repository_installation.pop("suspended_at"),
        ):
            api = FakeApi(binding)
            mutate(api)
            with self.assertRaises(Exception):
                self.mint(binding, api)
            self.assertFalse(any(path.endswith("access_tokens")
                                 for _, path, _, _ in api.requests))

    def test_rejects_tampered_or_unprotected_binding_and_key(self):
        digest = hashlib.sha256(self.config.read_bytes()).hexdigest()
        with self.assertRaisesRegex(Exception, "digest mismatch"):
            app_auth.AppBinding.load(self.config, expected_digest="0" * 64)
        self.config.chmod(0o644)
        with self.assertRaisesRegex(Exception, "only by its owner"):
            app_auth.AppBinding.load(self.config)
        self.config.chmod(0o600)
        self.key.chmod(0o644)
        with self.assertRaisesRegex(Exception, "only by its owner"):
            app_auth.AppBinding.load(self.config)

    def test_verifies_exact_app_bot_pr_author(self):
        binding = self.binding()
        binding.verify_pr_author({"user": {"id": 22, "login": "delivery-fixture[bot]",
                                                    "type": "Bot"}})
        for user in (
            {"id": 23, "login": "delivery-fixture[bot]", "type": "Bot"},
            {"id": 22, "login": "delivery-fixture", "type": "User"},
            {"id": 22, "login": "other[bot]", "type": "Bot"},
        ):
            with self.subTest(user=user), self.assertRaises(Exception):
                binding.verify_pr_author({"user": user})

    def test_http_transport_refuses_unallowlisted_operations(self):
        api = app_auth.GitHubAppApi(opener=object())
        for method, path, payload in (
            ("POST", "/graphql", {}),
            ("DELETE", "/app", None),
            ("GET", "/repos/acme/private-fixture/issues", None),
            ("POST", "/app/installations/33/access_tokens", None),
        ):
            with self.subTest(method=method, path=path), self.assertRaisesRegex(
                    Exception, "not allowlisted"):
                api.request(method, path, token="redacted", payload=payload)

    def test_publisher_client_binds_repo_and_allows_only_delivery_operations(self):
        session, _ = self.mint()

        class Transport:
            def __init__(self): self.calls = []
            def request(self, method, path, *, token, payload=None):
                self.calls.append((method, path, token, payload)); return {"ok": True}
            def paginated(self, path, *, token):
                self.calls.append(("PAGES", path, token, None)); return []
            def graphql(self, query, variables, *, token):
                self.calls.append(("GRAPHQL", query, token, variables)); return {"data": {}}

        transport = Transport()
        client = session.publisher_client(transport)
        client.api("GET", "github.com/acme/private-fixture", "/repos/{owner}/{repo}/issues/1")
        client.paginated("acme/private-fixture",
                         "/repos/{owner}/{repo}/actions/workflows?per_page=100")
        client.graphql(
            "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id})"
            "{pullRequest{id isDraft}}}", {"id": "PR_node"},
        )
        client.revoke()
        self.assertEqual(transport.calls[-1][0:2], ("DELETE", "/installation/token"))
        with self.assertRaisesRegex(Exception, "differs from binding"):
            client.api("GET", "acme/other", "/repos/{owner}/{repo}")

    def test_transport_allows_publisher_reads_writes_graphql_and_empty_revoke(self):
        class Response:
            def __init__(self, value): self.value = value
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self): return self.value

        class Opener:
            def __init__(self): self.requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                return Response(b"")

        opener = Opener()
        api = app_auth.GitHubAppApi(opener=opener)
        repo = "/repos/acme/private-fixture"
        sha = "1" * 40
        allowed = (
            ("GET", f"{repo}/contents/.github/delivery.toml?ref={sha}", None),
            ("GET", f"{repo}/actions/workflows?per_page=100", None),
            ("GET", f"{repo}/actions/workflows/66/runs?event=pull_request&per_page=100", None),
            ("PATCH", f"{repo}/pulls/1", {"title": "x", "body": "y", "base": "main"}),
            ("POST", f"{repo}/issues/1/labels", {"labels": ["status: review"]}),
            ("DELETE", "/installation/token", None),
        )
        for method, path, payload in allowed:
            self.assertEqual(api.request(method, path, token="secret", payload=payload), {})
        query = ("mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id})"
                 "{pullRequest{id isDraft}}}")
        self.assertEqual(api.graphql(query, {"id": "PR_node"}, token="secret"), {})
        with self.assertRaisesRegex(Exception, "not allowlisted"):
            api.request("POST", f"{repo}/dispatches", token="secret", payload={})
        with self.assertRaisesRegex(Exception, "not allowlisted"):
            api.graphql("mutation{deleteRepository(input:{}){clientMutationId}}", {}, token="secret")

    def test_pagination_preserves_existing_page_size_and_adds_page_once(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self): return b"[]"
        class Opener:
            def open(self, request, timeout):
                self.url = request.full_url
                return Response()
        opener = Opener()
        api = app_auth.GitHubAppApi(opener=opener)
        result = api.paginated(
            "/repos/acme/private-fixture/pulls?state=all&per_page=100", token="secret",
        )
        self.assertEqual(result, [])
        self.assertEqual(opener.url.count("per_page=100"), 1)
        self.assertEqual(opener.url.count("&page=1"), 1)


if __name__ == "__main__":
    unittest.main()
