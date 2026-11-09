#!/usr/bin/env python3
"""Protected GitHub App binding validation and installation-token minting."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import Any, Callable
import urllib.error
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit
import urllib.request

import delivery


APP_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
FULL_NAME = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
CLIENT_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
WORKFLOW_PATH = re.compile(r"^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$")
ALLOWED_PERMISSIONS = {
    "actions": {"read"},
    "checks": {"read"},
    "contents": {"write"},
    "issues": {"write"},
    "metadata": {"read"},
    "pull_requests": {"write"},
    "statuses": {"read"},
}
REQUIRED_PERMISSIONS = {
    "actions": "read",
    "contents": "write",
    "issues": "write",
    "metadata": "read",
    "pull_requests": "write",
}


def _positive_int(value: Any, label: str) -> int:
    delivery.require(isinstance(value, int) and not isinstance(value, bool) and value > 0,
                     f"App binding {label} must be a positive integer")
    return value


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _require_protected_ancestry(path: Path, label: str) -> None:
    for parent in path.parents:
        mode = parent.stat().st_mode
        delivery.require(not (mode & 0o022 and not mode & 0o1000),
                         f"{label} has a group/world-writable parent directory")


@dataclass(frozen=True)
class AppBinding:
    source: Path
    digest: str
    host: str
    app_id: int
    client_id: str
    app_slug: str
    bot_user_id: int
    installation_id: int
    account_id: int
    repository_id: int
    repository: str
    permissions: dict[str, str]
    private_key_path: Path
    state_dir: Path
    allowed_path_prefixes: tuple[str, ...]
    ci: dict[str, Any]

    @classmethod
    def load(cls, path: Path, *, expected_digest: str | None = None) -> "AppBinding":
        source = path.resolve()
        delivery.require(path.is_absolute(), "App binding path must be absolute")
        delivery.require(source.is_file() and not path.is_symlink(),
                         "App binding must be a regular, non-symlink file")
        stat = source.stat()
        delivery.require(stat.st_uid == os.geteuid() and stat.st_mode & 0o077 == 0,
                         "App binding must be readable only by its owner")
        _require_protected_ancestry(source, "App binding")
        raw = source.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if expected_digest is not None:
            delivery.require(expected_digest == digest, "App binding digest mismatch")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise delivery.DeliveryError("App binding is not valid JSON") from exc
        delivery.require(isinstance(value, dict) and value.get("schema_version") == 1,
                         "unsupported App binding schema")
        delivery.require(set(value) == {
            "schema_version", "host", "app", "installation", "repository",
            "permissions", "private_key_path", "state_dir", "allowed_path_prefixes", "ci",
        }, "App binding contains unexpected fields")
        app = value.get("app")
        installation = value.get("installation")
        repository = value.get("repository")
        permissions = value.get("permissions")
        ci = value.get("ci")
        delivery.require(isinstance(app, dict) and set(app) == {
            "id", "client_id", "slug", "bot_user_id",
        }, "App binding app identity is invalid")
        delivery.require(isinstance(installation, dict) and set(installation) == {
            "id", "account_id",
        }, "App binding installation identity is invalid")
        delivery.require(isinstance(repository, dict) and set(repository) == {
            "id", "full_name",
        }, "App binding repository identity is invalid")
        delivery.require(value.get("host") == "github.com", "App binding host must be github.com")
        delivery.require(isinstance(app.get("client_id"), str)
                         and CLIENT_ID.fullmatch(app["client_id"]),
                         "App binding client ID is invalid")
        delivery.require(isinstance(app.get("slug"), str) and APP_SLUG.fullmatch(app["slug"]),
                         "App binding slug is invalid")
        delivery.require(isinstance(repository.get("full_name"), str)
                         and FULL_NAME.fullmatch(repository["full_name"]),
                         "App binding repository name is invalid")
        delivery.require(isinstance(permissions, dict) and permissions,
                         "App binding permissions are invalid")
        delivery.require(all(isinstance(name, str) and isinstance(level, str)
                             and name in ALLOWED_PERMISSIONS
                             and level in ALLOWED_PERMISSIONS[name]
                             for name, level in permissions.items()),
                         "App binding contains unsupported permissions")
        delivery.require(all(permissions.get(name) == level
                             for name, level in REQUIRED_PERMISSIONS.items()),
                         "App binding is missing a required permission")
        state_value = value.get("state_dir")
        delivery.require(isinstance(state_value, str) and Path(state_value).is_absolute(),
                         "App state directory path must be absolute")
        state_dir = Path(state_value).resolve()
        delivery.require(state_dir.is_dir() and not Path(state_value).is_symlink(),
                         "App state directory must be an existing, non-symlink directory")
        state_stat = state_dir.stat()
        delivery.require(state_stat.st_uid == os.geteuid() and state_stat.st_mode & 0o077 == 0,
                         "App state directory must be accessible only by its owner")
        _require_protected_ancestry(state_dir, "App state directory")
        prefixes = value.get("allowed_path_prefixes")
        delivery.require(isinstance(prefixes, list) and prefixes,
                         "App allowed path prefixes must be a nonempty list")
        normalized_prefixes: list[str] = []
        for prefix in prefixes:
            delivery.require(isinstance(prefix, str) and prefix and not prefix.startswith("/")
                             and prefix.endswith("/") and ".." not in prefix.split("/")
                             and not prefix.lower().startswith((".github/", ".git/")) and "\x00" not in prefix,
                             "App allowed path prefix is invalid")
            normalized_prefixes.append(prefix)
        delivery.require(len(normalized_prefixes) == len(set(normalized_prefixes)),
                         "App allowed path prefixes must be unique")
        delivery.require(isinstance(ci, dict) and set(ci) == {
            "workflow_id", "workflow_path", "workflow_sha256", "event", "required_job",
        }, "App CI binding is invalid")
        _positive_int(ci.get("workflow_id"), "CI workflow ID")
        delivery.require(isinstance(ci.get("workflow_path"), str)
                         and WORKFLOW_PATH.fullmatch(ci["workflow_path"]),
                         "App CI workflow path is invalid")
        delivery.require(ci.get("event") == "pull_request",
                         "App CI event must be pull_request")
        delivery.require(isinstance(ci.get("workflow_sha256"), str)
                         and re.fullmatch(r"[0-9a-f]{64}", ci["workflow_sha256"]),
                         "App CI workflow digest is invalid")
        delivery.require(isinstance(ci.get("required_job"), str)
                         and ci["required_job"].strip() == ci["required_job"]
                         and ci["required_job"], "App CI required job is invalid")
        key_value = value.get("private_key_path")
        delivery.require(isinstance(key_value, str) and Path(key_value).is_absolute(),
                         "App private key path must be absolute")
        key_path = Path(key_value).resolve()
        delivery.require(key_path.is_file() and not Path(key_value).is_symlink(),
                         "App private key must be a regular, non-symlink file")
        key_stat = key_path.stat()
        delivery.require(key_stat.st_uid == os.geteuid() and key_stat.st_mode & 0o077 == 0,
                         "App private key must be readable only by its owner")
        _require_protected_ancestry(key_path, "App private key")
        delivery.require(0 < key_stat.st_size <= 16 * 1024,
                         "App private key size is invalid")
        return cls(
            source=source,
            digest=digest,
            host="github.com",
            app_id=_positive_int(app.get("id"), "ID"),
            client_id=app["client_id"],
            app_slug=app["slug"],
            bot_user_id=_positive_int(app.get("bot_user_id"), "bot user ID"),
            installation_id=_positive_int(installation.get("id"), "installation ID"),
            account_id=_positive_int(installation.get("account_id"), "installation account ID"),
            repository_id=_positive_int(repository.get("id"), "repository ID"),
            repository=repository["full_name"],
            permissions=dict(sorted(permissions.items())),
            private_key_path=key_path,
            state_dir=state_dir,
            allowed_path_prefixes=tuple(sorted(normalized_prefixes)),
            ci=dict(ci),
        )

    @property
    def bot_login(self) -> str:
        return f"{self.app_slug}[bot]"

    @property
    def repository_full_name(self) -> str:
        return self.repository

    def verify_pr_author(self, pull_request: dict[str, Any]) -> None:
        user = pull_request.get("user", {})
        delivery.require(user.get("id") == self.bot_user_id,
                         "pull request author ID is not the bound App bot")
        delivery.require(user.get("type") == "Bot", "pull request author is not a bot")
        delivery.require(user.get("login", "").lower() == self.bot_login.lower(),
                         "pull request author login is not the bound App bot")

    def verify_candidate_paths(self, paths: list[str]) -> None:
        delivery.require(isinstance(paths, list) and paths,
                         "candidate paths must be a nonempty list")
        for path in paths:
            delivery.require(isinstance(path, str) and any(
                path.startswith(prefix) and len(path) > len(prefix)
                for prefix in self.allowed_path_prefixes
            ), f"candidate path is outside the App allowlist: {path!r}")


class GitHubAppApi:
    """Minimal pinned-host REST transport with redirects disabled."""

    def __init__(self, opener=None):
        self.opener = opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _RejectRedirects(),
        )

    def request(self, method: str, path: str, *, token: str,
                payload: dict[str, Any] | None = None) -> Any:
        delivery.require(path.startswith("/") and not path.startswith("//"),
                         "GitHub App API path is invalid")
        self._validate_operation(method, path, payload)
        return self._perform(method, path, token=token, payload=payload)

    def _perform(self, method: str, path: str, *, token: str,
                 payload: dict[str, Any] | None = None) -> Any:
        data = delivery.canonical_json(payload) if payload is not None else None
        request = urllib.request.Request(
            f"https://api.github.com{path}", data=data, method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "github-delivery-app-auth/1",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise delivery.DeliveryError(f"GitHub App request failed with HTTP {exc.code}") from exc
        except (urllib.error.URLError, json.JSONDecodeError, OSError) as exc:
            raise delivery.DeliveryError("GitHub App request failed") from exc

    @staticmethod
    def _validate_operation(method: str, path: str,
                            payload: dict[str, Any] | None) -> None:
        parsed = urlsplit(path)
        plain_path = parsed.path
        query = parse_qs(parsed.query, keep_blank_values=True)
        delivery.require(not parsed.scheme and not parsed.netloc and not parsed.fragment
                         and all(len(values) == 1 for values in query.values()),
                         "GitHub App API path or query is invalid")
        allowed_get = (
            (not query and plain_path == "/app")
            or (not query and bool(re.fullmatch(r"/app/installations/[1-9][0-9]*", plain_path)))
            or (not query and bool(re.fullmatch(
                r"/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", plain_path)))
            or (not query and bool(re.fullmatch(
                r"/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/installation", plain_path)))
            or (not query and bool(re.fullmatch(
                r"/users/[a-z0-9-]+(?:\[bot\]|%5Bbot%5D)", plain_path, re.IGNORECASE)))
            or GitHubAppApi._publisher_get(plain_path, query)
        )
        token_create = bool(re.fullmatch(
            r"/app/installations/[1-9][0-9]*/access_tokens", plain_path,
        ))
        create_pr = bool(re.fullmatch(r"/repos/[\w.-]+/[\w.-]+/pulls", plain_path))
        add_labels = bool(re.fullmatch(r"/repos/[\w.-]+/[\w.-]+/issues/[1-9][0-9]*/labels",
                                       plain_path))
        update_pr = bool(re.fullmatch(r"/repos/[\w.-]+/[\w.-]+/pulls/[1-9][0-9]*",
                                      plain_path))
        delivery.require(
            (method == "GET" and payload is None and allowed_get)
            or (method == "POST" and GitHubAppApi._valid_post_payload(
                payload, token_create=token_create, create_pr=create_pr, add_labels=add_labels))
            or (method == "PATCH" and update_pr and isinstance(payload, dict)
                and set(payload) == {"title", "body", "base"})
            or (method == "DELETE" and payload is None
                and plain_path == "/installation/token" and not query),
            "GitHub App API operation is not allowlisted",
        )

    @staticmethod
    def _valid_post_payload(payload: Any, *, token_create: bool,
                            create_pr: bool, add_labels: bool) -> bool:
        if not isinstance(payload, dict):
            return False
        if token_create:
            return set(payload) == {"repository_ids", "permissions"}
        if create_pr:
            return set(payload) == {"title", "body", "head", "base", "draft"} \
                and payload.get("draft") is True
        if add_labels:
            labels = payload.get("labels")
            return set(payload) == {"labels"} and isinstance(labels, list) and labels \
                and all(isinstance(label, str) and label for label in labels)
        return False

    @staticmethod
    def _publisher_get(path: str, query: dict[str, list[str]]) -> bool:
        repo = r"/repos/[\w.-]+/[\w.-]+"
        no_query = (
            rf"{repo}/issues/[1-9][0-9]*", rf"{repo}/pulls/[1-9][0-9]*",
            rf"{repo}/labels/[^/]+", rf"{repo}/branches/[^/]+",
            rf"{repo}/git/commits/[0-9a-f]{{40}}",
            rf"{repo}/actions/workflows/[1-9][0-9]*", r"/user/[1-9][0-9]*",
            r"/users/[A-Za-z0-9_.%\[\]-]+", rf"{repo}/git/ref/heads/[A-Za-z0-9_.%/-]+",
        )
        if not query and any(re.fullmatch(pattern, path) for pattern in no_query):
            return True
        if re.fullmatch(rf"{repo}/contents/(?:\.github/delivery\.toml|"
                        r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml)", path):
            return set(query) == {"ref"} and bool(re.fullmatch(r"[0-9a-f]{40}", query["ref"][0]))
        if re.fullmatch(rf"{repo}/pulls", path):
            return GitHubAppApi._list_query(query, {"state"}) and query["state"] == ["all"]
        if re.fullmatch(rf"{repo}/pulls/[1-9][0-9]*/reviews", path):
            return GitHubAppApi._list_query(query, set())
        if re.fullmatch(rf"{repo}/actions/workflows/[1-9][0-9]*/runs", path):
            return GitHubAppApi._list_query(query, {"event"}, extra={"head_sha"}) \
                and query["event"] == ["pull_request"] \
                and ("head_sha" not in query
                     or bool(re.fullmatch(r"[0-9a-f]{40}", query["head_sha"][0])))
        if re.fullmatch(rf"{repo}/actions/workflows", path):
            return GitHubAppApi._list_query(query, set())
        if re.fullmatch(rf"{repo}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*/jobs", path):
            return GitHubAppApi._list_query(query, set())
        if path == "/installation/repositories":
            return GitHubAppApi._list_query(query, set())
        return False

    @staticmethod
    def _list_query(query: dict[str, list[str]], required: set[str],
                    extra: set[str] | None = None) -> bool:
        optional = {"per_page", "page", "head"} | (extra or set())
        if not required <= set(query) or not set(query) <= required | optional:
            return False
        if query.get("per_page", ["100"])[0] != "100":
            return False
        return bool(re.fullmatch(r"[1-9][0-9]*", query.get("page", ["1"])[0]))

    def paginated(self, path: str, *, token: str) -> list[dict[str, Any]]:
        page = 1
        results: list[dict[str, Any]] = []
        while True:
            parsed = urlsplit(path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            delivery.require(all(len(values) == 1 for values in query.values()),
                             "GitHub pagination query contains repeated fields")
            delivery.require(query.get("per_page", ["100"]) == ["100"],
                             "GitHub pagination page size must be 100")
            query["per_page"] = ["100"]
            query["page"] = [str(page)]
            page_path = urlunsplit(("", "", parsed.path, urlencode(query, doseq=True), ""))
            value = self.request("GET", page_path, token=token)
            if isinstance(value, list):
                items, total = value, None
            else:
                delivery.require(isinstance(value, dict), "GitHub pagination response is invalid")
                keys = [key for key in ("repositories", "workflows", "workflow_runs", "jobs")
                        if isinstance(value.get(key), list)]
                delivery.require(len(keys) == 1, "GitHub pagination response has no supported items")
                items, total = value[keys[0]], value.get("total_count")
                delivery.require(isinstance(total, int) and total >= 0,
                                 "GitHub pagination total count is invalid")
            results.extend(items)
            if total is not None and len(results) >= total:
                delivery.require(len(results) == total,
                                 "GitHub pagination count is inconsistent")
                return results
            if total is None and len(items) < 100:
                return results
            delivery.require(items, "GitHub pagination stalled")
            page += 1

    def graphql(self, query: str, variables: dict[str, Any], *, token: str) -> Any:
        expected = ("mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id})"
                    "{pullRequest{id isDraft}}}")
        delivery.require("".join(query.split()) == "".join(expected.split())
                         and set(variables) == {"id"}
                         and isinstance(variables["id"], str) and variables["id"],
                         "GitHub App GraphQL operation is not allowlisted")
        return self._perform("POST", "/graphql", token=token,
                             payload={"query": query, "variables": variables})


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise delivery.DeliveryError("GitHub App API redirect refused")


@dataclass(frozen=True)
class AppSession:
    binding: AppBinding
    token: str = field(repr=False)
    expires_at: dt.datetime

    def auth_env(self) -> dict[str, str]:
        return {"GH_TOKEN": self.token, "GH_HOST": self.binding.host}

    def publisher_client(self, api: GitHubAppApi | None = None) -> "AppPublisherClient":
        return AppPublisherClient(self, api=api)

    def revoke(self, api: GitHubAppApi | None = None) -> None:
        (api or GitHubAppApi()).request(
            "DELETE", "/installation/token", token=self.token,
        )

    def identity_evidence(self) -> dict[str, Any]:
        return {
            "binding_digest": self.binding.digest,
            "host": self.binding.host,
            "app_id": self.binding.app_id,
            "app_slug": self.binding.app_slug,
            "bot_user_id": self.binding.bot_user_id,
            "installation_id": self.binding.installation_id,
            "account_id": self.binding.account_id,
            "repository_id": self.binding.repository_id,
            "repository": self.binding.repository,
            "permissions": self.binding.permissions,
            "expires_at": self.expires_at.isoformat(),
        }


class AppPublisherClient:
    """Publisher-compatible client bound to one installation token and repository."""

    def __init__(self, session: AppSession, *, api: GitHubAppApi | None = None):
        self.session = session
        self.transport = api or GitHubAppApi()

    def _path(self, repo: str, endpoint: str) -> str:
        expected = self.session.binding.repository.lower()
        supplied = repo.lower().removeprefix("github.com/")
        delivery.require(supplied == expected, "App publisher repository differs from binding")
        owner, name = self.session.binding.repository.split("/")
        path = endpoint.format(owner=owner, repo=name)
        if path.startswith("/repos/"):
            delivery.require(path.startswith(f"/repos/{owner}/{name}/")
                             or path == f"/repos/{owner}/{name}",
                             "App publisher endpoint escapes the bound repository")
        return path

    def api(self, method: str, repo: str, endpoint: str,
            payload: dict[str, Any] | None = None) -> Any:
        return self.transport.request(
            method, self._path(repo, endpoint), token=self.session.token, payload=payload,
        )

    def paginated(self, repo: str, endpoint: str) -> list[dict[str, Any]]:
        return self.transport.paginated(
            self._path(repo, endpoint), token=self.session.token,
        )

    def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        return self.transport.graphql(query, variables, token=self.session.token)

    def revoke(self) -> None:
        self.session.revoke(self.transport)


class AppAuthenticator:
    def __init__(self, binding: AppBinding, *, api: GitHubAppApi | Any | None = None,
                 jwt_factory: Callable[[AppBinding], str] | None = None,
                 now: Callable[[], dt.datetime] | None = None):
        self.binding = binding
        self.api = api or GitHubAppApi()
        self.jwt_factory = jwt_factory or self._create_jwt
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc))

    def mint(self) -> AppSession:
        jwt = self.jwt_factory(self.binding)
        app = self.api.request("GET", "/app", token=jwt)
        self._verify_app(app)
        repository_installation = self.api.request(
            "GET", f"/repos/{self.binding.repository}/installation", token=jwt,
        )
        self._verify_installation(repository_installation)
        installation = self.api.request(
            "GET", f"/app/installations/{self.binding.installation_id}", token=jwt,
        )
        self._verify_installation(installation)
        scoped = self.api.request(
            "POST", f"/app/installations/{self.binding.installation_id}/access_tokens",
            token=jwt,
            payload={
                "repository_ids": [self.binding.repository_id],
                "permissions": self.binding.permissions,
            },
        )
        token = scoped.get("token")
        delivery.require(isinstance(token, str) and token and "\n" not in token and "\r" not in token,
                         "GitHub returned an invalid installation token")
        try:
            self._verify_permissions(scoped.get("permissions"), "installation token")
            scoped_repositories = scoped.get("repositories")
            delivery.require(isinstance(scoped_repositories, list)
                             and len(scoped_repositories) == 1,
                             "installation token response is not scoped to one repository")
            self._verify_repository(scoped_repositories[0])
            expires_at = self._parse_expiry(scoped.get("expires_at"))
            repositories = self.api.paginated("/installation/repositories", token=token)
            delivery.require(len(repositories) == 1,
                             "installation token is not scoped to one repository")
            self._verify_repository(repositories[0])
            repository = self.api.request(
                "GET", f"/repos/{self.binding.repository}", token=token,
            )
            self._verify_repository(repository)
            bot = self.api.request(
                "GET", f"/users/{quote(self.binding.bot_login, safe='')}", token=token,
            )
            delivery.require(bot.get("id") == self.binding.bot_user_id,
                             "GitHub App bot user ID mismatch")
            delivery.require(bot.get("type") == "Bot" and
                             bot.get("login", "").lower() == self.binding.bot_login.lower(),
                             "GitHub App bot identity mismatch")
            return AppSession(self.binding, token, expires_at)
        except Exception:
            try:
                self.api.request("DELETE", "/installation/token", token=token)
            except Exception:
                pass
            raise

    def _verify_app(self, app: dict[str, Any]) -> None:
        delivery.require(app.get("id") == self.binding.app_id, "GitHub App ID mismatch")
        delivery.require(app.get("client_id") == self.binding.client_id,
                         "GitHub App client ID mismatch")
        delivery.require(app.get("slug") == self.binding.app_slug, "GitHub App slug mismatch")
        self._verify_permissions(app.get("permissions"), "profile")

    def _verify_installation(self, installation: dict[str, Any]) -> None:
        delivery.require(installation.get("id") == self.binding.installation_id,
                         "GitHub App installation ID mismatch")
        delivery.require(installation.get("account", {}).get("id") == self.binding.account_id,
                         "GitHub App installation account mismatch")
        delivery.require("suspended_at" in installation and installation["suspended_at"] is None,
                         "GitHub App installation is suspended")
        delivery.require(installation.get("app_id") == self.binding.app_id
                         and installation.get("app_slug") == self.binding.app_slug,
                         "GitHub App installation owner mismatch")
        delivery.require(installation.get("target_id") == self.binding.account_id,
                         "GitHub App installation target mismatch")
        delivery.require(installation.get("repository_selection") == "selected",
                         "GitHub App installation must use selected repositories")
        self._verify_permissions(installation.get("permissions"), "installation")

    def _verify_permissions(self, actual: Any, label: str) -> None:
        delivery.require(actual == self.binding.permissions,
                         f"GitHub App {label} permissions differ from the binding")

    def _verify_repository(self, repository: dict[str, Any]) -> None:
        delivery.require(repository.get("id") == self.binding.repository_id,
                         "GitHub App repository ID mismatch")
        delivery.require(repository.get("full_name", "").lower()
                         == self.binding.repository.lower(),
                         "GitHub App repository name mismatch")

    def _parse_expiry(self, value: Any) -> dt.datetime:
        delivery.require(isinstance(value, str), "installation token expiry is missing")
        try:
            expiry = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise delivery.DeliveryError("installation token expiry is invalid") from exc
        now = self.now()
        delivery.require(expiry.tzinfo is not None and expiry > now + dt.timedelta(seconds=60),
                         "installation token is expired or too close to expiry")
        delivery.require(expiry <= now + dt.timedelta(hours=1, minutes=5),
                         "installation token expiry exceeds the expected lifetime")
        return expiry

    def _create_jwt(self, binding: AppBinding) -> str:
        now = int(self.now().timestamp())
        header = _b64url(delivery.canonical_json({"alg": "RS256", "typ": "JWT"}))
        claims = _b64url(delivery.canonical_json({
            "iat": now - 30,
            "exp": now + 540,
            "iss": str(binding.app_id),
        }))
        signing_input = f"{header}.{claims}".encode("ascii")
        key_fd = os.open(binding.private_key_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            key = os.fstat(key_fd)
            delivery.require(stat.S_ISREG(key.st_mode) and key.st_uid == os.geteuid()
                             and key.st_mode & 0o077 == 0 and 0 < key.st_size <= 16 * 1024,
                             "GitHub App private key no longer meets its protected file binding")
            completed = subprocess.run(
                ["openssl", "dgst", "-sha256", "-sign", f"/dev/fd/{key_fd}"],
                input=signing_input, capture_output=True, check=False, pass_fds=(key_fd,),
                env={"PATH": os.environ.get("PATH", ""), "LC_ALL": "C"},
            )
        finally:
            os.close(key_fd)
        if completed.returncode:
            raise delivery.DeliveryError("failed to sign GitHub App JWT")
        delivery.require(bool(completed.stdout), "GitHub App JWT signature is empty")
        return f"{header}.{claims}.{_b64url(completed.stdout)}"
