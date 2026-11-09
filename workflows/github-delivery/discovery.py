#!/usr/bin/env python3
"""Trusted-host discovery for repositories selected in a GitHub App installation."""

from __future__ import annotations

from dataclasses import dataclass, field
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable
from urllib.parse import quote

import app_auth
import delivery


TOKEN_PERMISSIONS = {
    "actions": {"read"},
    "checks": {"read"},
    "contents": {"read", "write"},
    "issues": {"read", "write"},
    "metadata": {"read"},
    "pull_requests": {"read", "write"},
    "statuses": {"read"},
}


def _protected_file(path: Path, label: str) -> tuple[Path, bytes]:
    delivery.require(path.is_absolute(), f"{label} path must be absolute")
    source = path.resolve()
    delivery.require(source.is_file() and not path.is_symlink(),
                     f"{label} must be a regular, non-symlink file")
    file_stat = source.stat()
    delivery.require(file_stat.st_uid == os.geteuid() and file_stat.st_mode & 0o077 == 0,
                     f"{label} must be readable only by its owner")
    app_auth._require_protected_ancestry(source, label)
    return source, source.read_bytes()


@dataclass(frozen=True)
class OperatorAppProfile:
    source: Path
    digest: str
    host: str
    app_id: int
    client_id: str
    app_slug: str
    bot_user_id: int
    allowed_account_ids: tuple[int, ...]
    permissions: dict[str, str]
    private_key_path: Path
    publication: dict[str, Any] | None

    @classmethod
    def load(cls, path: Path, *, expected_digest: str | None = None) -> "OperatorAppProfile":
        source, raw = _protected_file(path, "operator App profile")
        digest = hashlib.sha256(raw).hexdigest()
        if expected_digest is not None:
            delivery.require(digest == expected_digest, "operator App profile digest mismatch")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise delivery.DeliveryError("operator App profile is not valid JSON") from exc
        required = {
            "schema_version", "host", "app", "allowed_account_ids", "permissions",
            "private_key_path",
        }
        delivery.require(isinstance(value, dict)
                         and set(value) in (required, required | {"publication"})
                         and value.get("schema_version") == 1,
                         "operator App profile schema is invalid")
        app = value.get("app")
        delivery.require(isinstance(app, dict) and set(app) == {
            "id", "client_id", "slug", "bot_user_id",
        }, "operator App identity is invalid")
        delivery.require(value.get("host") == "github.com",
                         "operator App profile host must be github.com")
        delivery.require(isinstance(app.get("client_id"), str)
                         and app_auth.CLIENT_ID.fullmatch(app["client_id"]),
                         "operator App client ID is invalid")
        delivery.require(isinstance(app.get("slug"), str)
                         and app_auth.APP_SLUG.fullmatch(app["slug"]),
                         "operator App slug is invalid")
        account_ids = value.get("allowed_account_ids")
        delivery.require(isinstance(account_ids, list) and account_ids
                         and all(isinstance(item, int) and not isinstance(item, bool) and item > 0
                                 for item in account_ids)
                         and len(account_ids) == len(set(account_ids)),
                         "operator App allowed accounts are invalid")
        permissions = value.get("permissions")
        delivery.require(isinstance(permissions, dict) and permissions
                         and all(name in app_auth.ALLOWED_PERMISSIONS
                                 and level in app_auth.ALLOWED_PERMISSIONS[name]
                                 for name, level in permissions.items())
                         and all(permissions.get(name) == level
                                 for name, level in app_auth.REQUIRED_PERMISSIONS.items()),
                         "operator App permissions are invalid")
        key_value = value.get("private_key_path")
        delivery.require(isinstance(key_value, str), "operator App private key path is invalid")
        key_path, key = _protected_file(Path(key_value), "operator App private key")
        delivery.require(0 < len(key) <= 16 * 1024, "operator App private key size is invalid")
        publication = value.get("publication")
        if publication is not None:
            delivery.require(isinstance(publication, dict) and set(publication) == {
                "state_dir", "allowed_path_prefixes", "ci", "local_verifier",
            }, "operator App publication profile is invalid")
        return cls(
            source=source, digest=digest, host="github.com",
            app_id=app_auth._positive_int(app.get("id"), "ID"),
            client_id=app["client_id"], app_slug=app["slug"],
            bot_user_id=app_auth._positive_int(app.get("bot_user_id"), "bot user ID"),
            allowed_account_ids=tuple(sorted(account_ids)),
            permissions=dict(sorted(permissions.items())), private_key_path=key_path,
            publication=publication,
        )

    @property
    def bot_login(self) -> str:
        return f"{self.app_slug}[bot]"

    def binding_value(self, repository: "DiscoveredRepository") -> dict[str, Any]:
        delivery.require(self.publication is not None,
                         "operator App profile is not configured for publication")
        return {
            "schema_version": 1,
            "host": self.host,
            "app": {"id": self.app_id, "client_id": self.client_id,
                    "slug": self.app_slug, "bot_user_id": self.bot_user_id},
            "installation": {"id": repository.installation_id,
                             "account_id": repository.account_id},
            "repository": {"id": repository.repository_id,
                           "full_name": repository.full_name},
            "permissions": self.permissions,
            "private_key_path": str(self.private_key_path),
            "state_dir": self.publication["state_dir"],
            "allowed_path_prefixes": self.publication["allowed_path_prefixes"],
            "ci": self.publication["ci"],
            "local_verifier": self.publication["local_verifier"],
        }

    def write_binding(self, repository: "DiscoveredRepository", path: Path) -> app_auth.AppBinding:
        delivery.require(path.is_absolute() and path.parent.is_dir() and not path.is_symlink(),
                         "generated App binding path is invalid")
        parent_stat = path.parent.resolve().stat()
        delivery.require(parent_stat.st_uid == os.geteuid() and parent_stat.st_mode & 0o077 == 0,
                         "generated App binding directory must be accessible only by its owner")
        app_auth._require_protected_ancestry(path.parent.resolve(),
                                             "generated App binding directory")
        raw = delivery.canonical_json(self.binding_value(repository))
        with tempfile.NamedTemporaryFile(
                mode="wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if temporary.exists():
                temporary.unlink()
        digest = hashlib.sha256(raw).hexdigest()
        return app_auth.AppBinding.load(path, expected_digest=digest)


@dataclass(frozen=True)
class DiscoveredRepository:
    installation_id: int
    account_id: int
    repository_id: int
    full_name: str
    default_branch: str


@dataclass(frozen=True)
class DiscoveryInventory:
    profile_digest: str
    app_id: int
    app_slug: str
    bot_user_id: int
    repositories: tuple[DiscoveredRepository, ...]

    def repository(self, full_name: str) -> DiscoveredRepository:
        matches = [item for item in self.repositories
                   if item.full_name.lower() == full_name.lower()]
        delivery.require(len(matches) == 1,
                         "repository is not uniquely selected in the App installation")
        return matches[0]

    def evidence(self) -> dict[str, Any]:
        return {
            "profile_digest": self.profile_digest,
            "app_id": self.app_id,
            "app_slug": self.app_slug,
            "bot_user_id": self.bot_user_id,
            "repositories": [
                {"installation_id": item.installation_id, "account_id": item.account_id,
                 "repository_id": item.repository_id, "full_name": item.full_name,
                 "default_branch": item.default_branch}
                for item in self.repositories
            ],
        }


@dataclass(frozen=True)
class RepositoryToken:
    repository: DiscoveredRepository
    permissions: dict[str, str]
    token: str = field(repr=False)
    expires_at: dt.datetime

    def auth_env(self) -> dict[str, str]:
        return {"GH_TOKEN": self.token, "GH_HOST": "github.com"}

    def revoke(self, api: app_auth.GitHubAppApi | Any | None = None) -> None:
        (api or app_auth.GitHubAppApi()).request(
            "DELETE", "/installation/token", token=self.token,
        )


class AppDiscovery:
    def __init__(self, profile: OperatorAppProfile, *,
                 api: app_auth.GitHubAppApi | Any | None = None,
                 jwt_factory: Callable[[OperatorAppProfile], str] | None = None,
                 now: Callable[[], dt.datetime] | None = None):
        self.profile = profile
        self.api = api or app_auth.GitHubAppApi()
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc))
        self.jwt_factory = jwt_factory or self._create_jwt

    def discover(self, repository: str | None = None) -> DiscoveryInventory:
        if repository is not None:
            delivery.require(isinstance(repository, str)
                             and app_auth.FULL_NAME.fullmatch(repository),
                             "discovery repository name is invalid")
        jwt = self.jwt_factory(self.profile)
        self._verify_app(self.api.request("GET", "/app", token=jwt))
        installations = self.api.paginated("/app/installations?per_page=100", token=jwt)
        found: list[DiscoveredRepository] = []
        for installation in installations:
            self._verify_installation(installation)
            found.extend(self._inventory_installation(jwt, installation))
        inventory = DiscoveryInventory(
            profile_digest=self.profile.digest, app_id=self.profile.app_id,
            app_slug=self.profile.app_slug, bot_user_id=self.profile.bot_user_id,
            repositories=tuple(sorted(found, key=lambda item: item.full_name.lower())),
        )
        delivery.require(len({item.repository_id for item in found}) == len(found)
                         and len({item.full_name.lower() for item in found}) == len(found),
                         "App discovery returned conflicting repository bindings")
        if repository is not None:
            selected = inventory.repository(repository)
            installation = self.api.request(
                "GET", f"/repos/{selected.full_name}/installation", token=jwt,
            )
            self._verify_installation(installation, expected_id=selected.installation_id)
        return inventory

    def mint_repository(self, repository: str,
                        permissions: dict[str, str]) -> RepositoryToken:
        selected = self.discover(repository).repository(repository)
        self._verify_requested_permissions(permissions)
        jwt = self.jwt_factory(self.profile)
        scoped = self.api.request(
            "POST", f"/app/installations/{selected.installation_id}/access_tokens", token=jwt,
            payload={"repository_ids": [selected.repository_id],
                     "permissions": dict(sorted(permissions.items()))},
        )
        token = self._token(scoped)
        try:
            delivery.require(scoped.get("permissions") == permissions,
                             "repository token permissions differ from the request")
            repositories = scoped.get("repositories")
            delivery.require(isinstance(repositories, list) and len(repositories) == 1,
                             "repository token response is not scoped to one repository")
            self._verify_repository(repositories[0], selected.installation_id,
                                    selected.account_id, expected=selected)
            expiry = self._parse_expiry(scoped.get("expires_at"))
            token_repositories = self.api.paginated(
                "/installation/repositories", token=token,
            )
            delivery.require(len(token_repositories) == 1,
                             "repository token is not scoped to one repository")
            self._verify_repository(token_repositories[0], selected.installation_id,
                                    selected.account_id, expected=selected)
            current = self.api.request("GET", f"/repos/{selected.full_name}", token=token)
            self._verify_repository(current, selected.installation_id,
                                    selected.account_id, expected=selected)
            return RepositoryToken(selected, dict(sorted(permissions.items())), token, expiry)
        except Exception:
            self._revoke(token)
            raise

    def _inventory_installation(self, jwt: str,
                                installation: dict[str, Any]) -> list[DiscoveredRepository]:
        installation_id = installation["id"]
        scoped = self.api.request(
            "POST", f"/app/installations/{installation_id}/access_tokens", token=jwt,
            payload={"permissions": {"metadata": "read"}},
        )
        token = self._token(scoped)
        try:
            delivery.require(scoped.get("permissions") == {"metadata": "read"},
                             "discovery token is not metadata-only")
            self._parse_expiry(scoped.get("expires_at"))
            repositories = self.api.paginated("/installation/repositories", token=token)
            account_id = installation["account"]["id"]
            result = [self._verify_repository(item, installation_id, account_id)
                      for item in repositories]
            bot = self.api.request(
                "GET", f"/users/{quote(self.profile.bot_login, safe='')}", token=token,
            )
            delivery.require(bot.get("id") == self.profile.bot_user_id
                             and bot.get("type") == "Bot"
                             and bot.get("login", "").lower() == self.profile.bot_login.lower(),
                             "GitHub App bot identity mismatch")
            return result
        finally:
            self.api.request("DELETE", "/installation/token", token=token)

    def _verify_app(self, value: dict[str, Any]) -> None:
        delivery.require(value.get("id") == self.profile.app_id
                         and value.get("client_id") == self.profile.client_id
                         and value.get("slug") == self.profile.app_slug,
                         "GitHub App identity differs from the operator profile")
        delivery.require(value.get("permissions") == self.profile.permissions,
                         "GitHub App permissions differ from the operator profile")

    def _verify_installation(self, value: dict[str, Any], expected_id: int | None = None) -> None:
        delivery.require(isinstance(value, dict)
                         and isinstance(value.get("id"), int) and value["id"] > 0
                         and (expected_id is None or value["id"] == expected_id),
                         "GitHub App installation ID mismatch")
        account_id = value.get("account", {}).get("id")
        delivery.require(account_id in self.profile.allowed_account_ids,
                         "GitHub App installation account is not allowed")
        delivery.require(value.get("app_id") == self.profile.app_id
                         and value.get("app_slug") == self.profile.app_slug
                         and value.get("target_id") == account_id,
                         "GitHub App installation identity mismatch")
        delivery.require("suspended_at" in value and value["suspended_at"] is None,
                         "GitHub App installation is suspended")
        delivery.require(value.get("repository_selection") == "selected",
                         "GitHub App installation must use selected repositories")
        delivery.require(value.get("permissions") == self.profile.permissions,
                         "GitHub App installation permissions differ from the operator profile")

    def _verify_repository(self, value: dict[str, Any], installation_id: int, account_id: int,
                           expected: DiscoveredRepository | None = None) -> DiscoveredRepository:
        repository_id = value.get("id")
        full_name = value.get("full_name")
        default_branch = value.get("default_branch")
        delivery.require(isinstance(repository_id, int) and repository_id > 0
                         and value.get("owner", {}).get("id") == account_id
                         and isinstance(full_name, str) and app_auth.FULL_NAME.fullmatch(full_name)
                         and isinstance(default_branch, str)
                         and bool(re.fullmatch(r"[A-Za-z0-9._/-]+", default_branch))
                         and ".." not in default_branch.split("/")
                         and not default_branch.startswith("/")
                         and not default_branch.endswith("/"),
                         "GitHub App repository identity is invalid")
        result = DiscoveredRepository(installation_id, account_id, repository_id,
                                      full_name, default_branch)
        if expected is not None:
            delivery.require(result == expected, "GitHub App repository binding drifted")
        return result

    def _verify_requested_permissions(self, permissions: dict[str, str]) -> None:
        delivery.require(isinstance(permissions, dict) and permissions
                         and all(name in TOKEN_PERMISSIONS and level in TOKEN_PERMISSIONS[name]
                                 for name, level in permissions.items())
                         and all(name in self.profile.permissions
                                 and (self.profile.permissions[name] == level
                                      or self.profile.permissions[name] == "write" and level == "read")
                                 for name, level in permissions.items()),
                         "repository token permissions exceed the operator profile")

    def _token(self, value: Any) -> str:
        delivery.require(isinstance(value, dict), "GitHub token response is invalid")
        token = value.get("token")
        delivery.require(isinstance(token, str) and token
                         and "\n" not in token and "\r" not in token,
                         "GitHub returned an invalid installation token")
        return token

    def _parse_expiry(self, value: Any) -> dt.datetime:
        delivery.require(isinstance(value, str), "installation token expiry is missing")
        try:
            expiry = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise delivery.DeliveryError("installation token expiry is invalid") from exc
        now = self.now()
        delivery.require(expiry.tzinfo is not None and expiry > now + dt.timedelta(seconds=60)
                         and expiry <= now + dt.timedelta(hours=1, minutes=5),
                         "installation token expiry is invalid")
        return expiry

    def _revoke(self, token: str) -> None:
        try:
            self.api.request("DELETE", "/installation/token", token=token)
        except Exception:
            pass

    def _create_jwt(self, profile: OperatorAppProfile) -> str:
        return app_auth.AppAuthenticator._create_jwt(self, profile)  # type: ignore[arg-type]
