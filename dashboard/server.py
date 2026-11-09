#!/usr/bin/env python3
"""Read-only OAuth dashboard for one configured Delivery projection."""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FULL_SHA = re.compile(r"[0-9a-f]{40}")
REVISION = re.compile(r"[0-9a-f]{64}")
MAX_ARTIFACT = 256 * 1024
SESSION_TTL = 8 * 60 * 60


class DashboardError(RuntimeError):
    pass


class NotAuthorized(DashboardError):
    pass


class SignInRequired(NotAuthorized):
    pass


class GitHubUnavailable(DashboardError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise DashboardError("snapshot time invalid")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise DashboardError("snapshot time invalid")
    return parsed.astimezone(timezone.utc)


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def revision_key(snapshot: dict[str, Any]) -> str:
    plan = snapshot["plan"]
    review = plan.get("review") or {}
    pr = plan["pr"]
    material = {
        "binding": snapshot["binding"], "stage": "plan", "generation": plan["generation"],
        "context_digest": review.get("context_digest"), "number": pr["number"],
        "head_sha": pr["head_sha"], "base_sha": pr["base_sha"],
    }
    return hashlib.sha256(canonical(material)).hexdigest()


def safe_snapshot(path: Path, repo: str, delivery_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    try:
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise DashboardError("snapshot permissions invalid")
        raw = path.read_bytes()
        if len(raw) > 1024 * 1024:
            raise DashboardError("snapshot too large")
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise DashboardError("snapshot unavailable") from exc
    if not isinstance(value, dict) or value.get("projection_version") != 1:
        raise DashboardError("snapshot invalid")
    binding = value.get("binding", {})
    if binding.get("repo") != repo or binding.get("delivery_id") != delivery_id:
        raise DashboardError("snapshot binding mismatch")
    if not isinstance(binding.get("repository_id"), int):
        raise DashboardError("snapshot repository invalid")
    if parse_time(value.get("expires_at")) <= (now or utcnow()):
        raise DashboardError("snapshot expired")
    return value


class InvalidationStore:
    """Persistent one-way invalidations, independent of Delivery state."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def _read(self) -> dict[str, str]:
        try:
            value = json.loads(self.path.read_text())
            if not isinstance(value, dict) or not all(REVISION.fullmatch(key) for key in value):
                raise DashboardError("invalidation store invalid")
            return value
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError) as exc:
            raise DashboardError("invalidation store unavailable") from exc

    def contains(self, key: str) -> bool:
        with self.lock:
            return key in self._read()

    def add(self, key: str, reason: str = "revision_drift") -> None:
        if not REVISION.fullmatch(key):
            raise DashboardError("revision key invalid")
        with self.lock:
            values = self._read()
            values[key] = reason
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary = self.path.with_name(f".{self.path.name}.{secrets.token_hex(6)}")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(canonical(values) + b"\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass


class GitHubClient:
    """Restricted user-token GitHub GET client with no redirects."""

    def __init__(self, token: str, opener=None):
        self.token = token
        self.opener = opener or build_opener(ProxyHandler({}), NoRedirect())

    def get(self, path: str) -> Any:
        if not self.allowed(path):
            raise DashboardError("GitHub read path denied")
        request = Request(f"https://api.github.com{path}", method="GET", headers={
            "Accept": "application/vnd.github+json", "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "codex-toolkit-dashboard/1",
        })
        try:
            with self.opener.open(request, timeout=10) as response:
                return json.loads(response.read())
        except HTTPError as exc:
            if exc.code in (401, 403, 404):
                raise NotAuthorized("GitHub access unavailable") from exc
            raise GitHubUnavailable("GitHub read unavailable") from exc
        except (URLError, OSError, json.JSONDecodeError) as exc:
            raise GitHubUnavailable("GitHub read unavailable") from exc

    @staticmethod
    def allowed(path: str) -> bool:
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            return False
        plain = parsed.path
        if any(part in ("", ".", "..") for part in unquote(plain).split("/")[1:]):
            return False
        repo = r"/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
        return bool(
            plain == "/user" and not parsed.query
            or re.fullmatch(repo, plain) and not parsed.query
            or re.fullmatch(rf"{repo}/issues/[1-9][0-9]*", plain) and not parsed.query
            or re.fullmatch(rf"{repo}/pulls/[1-9][0-9]*", plain) and not parsed.query
            or re.fullmatch(rf"{repo}/pulls/[1-9][0-9]*/reviews/[1-9][0-9]*", plain) and not parsed.query
            or re.fullmatch(rf"{repo}/contents/(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9_.%/-]+", plain)
               and bool(re.fullmatch(r"ref=[0-9a-f]{40}", parsed.query))
        )


@dataclass
class Session:
    token: str | None = None
    oauth_state: str | None = None
    verifier: str | None = None
    created: float = 0.0
    fixture_user: dict[str, Any] | None = None


class SessionStore:
    def __init__(self):
        self.values: dict[str, Session] = {}
        self.lock = threading.Lock()

    def create(self) -> tuple[str, Session]:
        key = secrets.token_urlsafe(32)
        session = Session(created=time.time())
        with self.lock:
            self.values[key] = session
        return key, session

    def get(self, key: str | None) -> Session | None:
        if not key:
            return None
        with self.lock:
            session = self.values.get(key)
            if session and time.time() - session.created <= SESSION_TTL:
                return session
            self.values.pop(key, None)
        return None

    def rotate(self, old_key: str, session: Session) -> str:
        new_key = secrets.token_urlsafe(32)
        with self.lock:
            self.values.pop(old_key, None)
            session.created = time.time()
            self.values[new_key] = session
        return new_key


class DashboardService:
    def __init__(self, *, snapshot: Path, invalidations: Path, repo: str, delivery_id: str,
                 github_factory=GitHubClient):
        self.snapshot_path = snapshot
        self.repo = repo
        self.delivery_id = delivery_id
        self.invalidations = InvalidationStore(invalidations)
        self.github_factory = github_factory

    def load(self) -> dict[str, Any]:
        return safe_snapshot(self.snapshot_path, self.repo, self.delivery_id)

    def present(self, token: str, *, force: bool = False, requested_revision: str | None = None) -> dict[str, Any]:
        snapshot = self.load()
        opened_revision = revision_key(snapshot)
        client = self.github_factory(token)
        prefix = f"/repos/{self.repo}"
        repository = client.get(prefix)
        if not isinstance(repository, dict) or repository.get("id") != snapshot["binding"]["repository_id"]:
            raise NotAuthorized("repository access unavailable")
        if requested_revision is not None and requested_revision != opened_revision:
            return {"status": "stale", "message": "Review request changed", "revision": opened_revision}
        try:
            viewer = client.get("/user")
        except (NotAuthorized, GitHubUnavailable):
            viewer = {"id": None, "login": None, "type": None}
        if not isinstance(viewer, dict):
            viewer = {"id": None, "login": None, "type": None}
        eligibility_known = isinstance(viewer.get("id"), int) and viewer.get("type") == "User"

        plan = snapshot["plan"]
        saved_pr = plan["pr"]
        review = plan.get("review")
        gate = snapshot["delivery"]
        active_gate = bool(review and gate.get("status") == "plan_review"
                           and gate.get("runner_status") == "paused"
                           and gate.get("current_step_id") == "plan-review"
                           and gate.get("claim_status") == "active")
        try:
            live_pr = client.get(f"{prefix}/pulls/{saved_pr['number']}")
            live = self._live_pr(live_pr)
        except (NotAuthorized, GitHubUnavailable):
            return self._unavailable(snapshot, viewer, opened_revision)
        mismatch = active_gate and self._mismatch(saved_pr, live)
        invalid = self.invalidations.contains(opened_revision) if active_gate else False
        if mismatch:
            self.invalidations.add(opened_revision)
            invalid = True

        issue_title = None
        issue = snapshot["delivery"].get("issue")
        if isinstance(issue, int):
            try:
                issue_value = client.get(f"{prefix}/issues/{issue}")
                issue_title = issue_value.get("title") if isinstance(issue_value, dict) else None
            except (NotAuthorized, GitHubUnavailable):
                pass

        artifacts, evidence_ok = self._artifacts(client, snapshot)
        eligible = bool(eligibility_known and review and viewer["id"] in review.get("reviewer_ids", [])
                        and viewer["id"] != snapshot.get("policy", {}).get("publisher_id"))
        receipt = self._receipt(client, snapshot, review)
        terminal_receipt = bool(receipt and (receipt.get("approved") or receipt.get("rejectors")))
        actionable = eligible and active_gate and evidence_ok and not invalid and not mismatch and not terminal_receipt

        # A concurrent transport update or correction cannot be revived by this response.
        current = self.load()
        current_gate = current["delivery"]
        current_active = bool(current["plan"].get("review") and current_gate.get("status") == "plan_review"
                              and current_gate.get("runner_status") == "paused"
                              and current_gate.get("current_step_id") == "plan-review"
                              and current_gate.get("claim_status") == "active")
        if (revision_key(current) != opened_revision or not current_active
                or current["plan"].get("receipt") != snapshot["plan"].get("receipt")
                or self.invalidations.contains(opened_revision)):
            actionable = False
            invalid = True

        repo_url = f"https://github.com/{self.repo}"
        response: dict[str, Any] = {
            "status": "ok", "revision": opened_revision,
            "fresh_for_ms": 15000, "generated_at": snapshot["generated_at"],
            "item": {
                "id": f"{self.repo}:{self.delivery_id}:plan", "repo": self.repo,
                "delivery_id": self.delivery_id, "issue": issue, "issue_title": issue_title,
                "delivery": gate, "generation": plan["generation"], "published_at": plan.get("published_at"),
                "pr": {"number": saved_pr["number"], "head_sha": saved_pr["head_sha"],
                       "base_sha": saved_pr["base_sha"], "live_head_sha": live.get("head_sha"),
                       "commit_url": f"{repo_url}/commit/{saved_pr['head_sha']}",
                       "current_commit_url": f"{repo_url}/commit/{live['head_sha']}" if mismatch else None,
                       "inspect_url": f"{repo_url}/pull/{saved_pr['number']}/files"},
                "artifacts": artifacts, "receipt": receipt,
                "implementation": self._implementation(snapshot, repo_url),
                "viewer": {"id": viewer["id"], "login": viewer.get("login"), "eligible": eligible,
                           "eligibility_known": eligibility_known},
                "state": (self._display_state(snapshot, actionable, invalid, mismatch, evidence_ok)
                          if eligibility_known else "eligibility_unavailable"),
            },
        }
        if actionable:
            response["item"]["review"] = {
                "submit_as": "COMMENT", "url": f"{repo_url}/pull/{saved_pr['number']}/files",
                "approve": review["approve"], "reject": review["reject"],
            }
        return response

    def _unavailable(self, snapshot: dict[str, Any], viewer: dict[str, Any], revision: str) -> dict[str, Any]:
        plan = snapshot["plan"]
        pr = plan["pr"]
        repo_url = f"https://github.com/{self.repo}"
        return {"status": "ok", "revision": revision, "fresh_for_ms": 0,
                "generated_at": snapshot["generated_at"], "item": {
                    "id": f"{self.repo}:{self.delivery_id}:plan", "repo": self.repo,
                    "delivery_id": self.delivery_id, "issue": snapshot["delivery"].get("issue"),
                    "delivery": snapshot["delivery"], "generation": plan["generation"],
                    "pr": {"number": pr["number"], "head_sha": pr["head_sha"], "base_sha": pr["base_sha"],
                           "commit_url": f"{repo_url}/commit/{pr['head_sha']}",
                           "inspect_url": f"{repo_url}/pull/{pr['number']}/files"},
                    "artifacts": [{"path": item["path"], "sha256": item["sha256"], "verified": False,
                                   "url": f"{repo_url}/blob/{pr['head_sha']}/{quote(item['path'], safe='/')}"}
                                  for item in plan["artifacts"]],
                    "receipt": plan.get("receipt"), "implementation": self._implementation(snapshot, repo_url),
                    "viewer": {"id": viewer["id"], "login": viewer.get("login"), "eligible": False},
                    "state": "github_unavailable",
                }}

    @staticmethod
    def _live_pr(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise GitHubUnavailable("pull request response invalid")
        try:
            return {"number": value["number"], "node_id": value["node_id"], "head": value["head"]["ref"],
                    "head_sha": value["head"]["sha"], "base": value["base"]["ref"],
                    "base_sha": value["base"]["sha"], "draft": value["draft"],
                    "state": value["state"].upper(), "author_id": value["user"]["id"],
                    "author_type": value["user"].get("type"), "author_login": value["user"].get("login"),
                    "head_repo_id": value["head"].get("repo", {}).get("id"),
                    "base_repo_id": value["base"].get("repo", {}).get("id"),
                    "performed_via_github_app": value.get("performed_via_github_app"),
                    "body_digest": hashlib.sha256((value.get("body") or "").encode()).hexdigest()}
        except (KeyError, TypeError, AttributeError) as exc:
            raise GitHubUnavailable("pull request response invalid") from exc

    @staticmethod
    def _mismatch(saved: dict[str, Any], live: dict[str, Any]) -> bool:
        required = ("number", "node_id", "head", "head_sha", "base", "base_sha", "draft", "state", "author_id",
                    "author_type", "author_login", "body_digest")
        if not saved.get("body_digest") or any(saved.get(key) != live.get(key) for key in required):
            return True
        for key in ("head_repo_id", "base_repo_id", "performed_via_github_app"):
            if saved.get(key) is not None and saved.get(key) != live.get(key):
                return True
        return False

    def _artifacts(self, client: GitHubClient, snapshot: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
        result = []
        okay = True
        sha = snapshot["plan"]["pr"]["head_sha"]
        repo_url = f"https://github.com/{self.repo}"
        for artifact in snapshot["plan"]["artifacts"]:
            path = artifact["path"]
            entry = {"path": path, "sha256": artifact["sha256"],
                     "url": f"{repo_url}/blob/{sha}/{quote(path, safe='/')}"}
            try:
                value = client.get(f"/repos/{self.repo}/contents/{quote(path, safe='/')}?ref={sha}")
                if not isinstance(value, dict) or value.get("type") != "file" or value.get("encoding") != "base64":
                    raise GitHubUnavailable("artifact response invalid")
                if value.get("path") != path or value.get("name") != path.rsplit("/", 1)[-1]:
                    raise GitHubUnavailable("artifact response invalid")
                encoded = "".join(str(value.get("content", "")).split())
                raw = base64.b64decode(encoded, validate=True)
                if len(raw) > MAX_ARTIFACT or hashlib.sha256(raw).hexdigest() != artifact["sha256"]:
                    raise GitHubUnavailable("artifact verification failed")
                entry["content"] = raw.decode("utf-8")
                entry["verified"] = True
            except (NotAuthorized, GitHubUnavailable, ValueError, UnicodeDecodeError):
                entry["verified"] = False
                okay = False
            result.append(entry)
        return result, okay

    def _receipt(self, client: GitHubClient, snapshot: dict[str, Any], review: Any) -> dict[str, Any] | None:
        saved = snapshot["plan"].get("receipt")
        if not isinstance(saved, dict):
            return None
        result = dict(saved)
        result["enrichment"] = "unavailable"
        review_ids = saved.get("review_ids")
        if not isinstance(review_ids, dict) or not review:
            return result
        for author, review_id in review_ids.items():
            if not str(author).isdigit() or not isinstance(review_id, int):
                continue
            try:
                value = client.get(f"/repos/{self.repo}/pulls/{snapshot['plan']['pr']['number']}/reviews/{review_id}")
            except (NotAuthorized, GitHubUnavailable):
                continue
            author_id = int(author)
            decision_body = (review.get("approve") if author_id in saved.get("approvers", []) else
                             review.get("reject") if author_id in saved.get("rejectors", []) else None)
            if (decision_body and isinstance(value, dict) and value.get("id") == review_id
                    and value.get("user", {}).get("id") == author_id
                    and value.get("commit_id") == saved.get("commit_id")
                    and value.get("state") == "COMMENTED" and value.get("body") == decision_body
                    and saved.get("context_digest") == review.get("context_digest")):
                result.update(enrichment="verified", url=value.get("html_url"),
                              reviewer=value.get("user", {}).get("login"), submitted_at=value.get("submitted_at"))
                break
        return result

    @staticmethod
    def _implementation(snapshot: dict[str, Any], repo_url: str) -> dict[str, Any] | None:
        value = snapshot.get("implementation")
        if not isinstance(value, dict) or not isinstance(value.get("number"), int):
            return None
        return {"number": value["number"], "head_sha": value.get("head_sha"),
                "url": f"{repo_url}/pull/{value['number']}/files",
                "commit_url": f"{repo_url}/commit/{value.get('head_sha')}"}

    @staticmethod
    def _display_state(snapshot: dict[str, Any], actionable: bool, invalid: bool,
                       mismatch: bool, evidence_ok: bool) -> str:
        delivery = snapshot["delivery"]
        receipt = snapshot["plan"].get("receipt")
        if delivery.get("status") == "implementation_review":
            return "implementation_review"
        if delivery.get("status") == "implementation_required":
            return "implementation_next"
        if delivery.get("status") in ("publication_pending", "pre_ready_ci_waiting", "pre_ready_ci_blocked"):
            return "post_plan"
        if delivery.get("status") == "review_ready":
            return "delivery_ready"
        if delivery.get("runner_status") == "failed":
            return "runner_failed"
        if delivery.get("status") == "plan_review" and isinstance(receipt, dict) and receipt.get("approved"):
            return "verified_waiting"
        if isinstance(receipt, dict) and receipt.get("rejectors"):
            return "rejected"
        if invalid or mismatch:
            return "revision_changed"
        if not evidence_ok:
            return "evidence_unavailable"
        if actionable:
            return "actionable"
        return "waiting"


@dataclass
class Config:
    bind: str
    port: int
    origin: str
    client_id: str
    client_secret_file: Path | None
    snapshot: Path
    invalidations: Path
    repo: str
    delivery_id: str
    fixture: bool = False


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "CodexToolkitDashboard/1"

    def log_message(self, format, *args):  # noqa: A002, ANN001
        # Deliberately omit paths, cookies, OAuth codes and upstream details.
        return

    @property
    def app(self):
        return self.server.app  # type: ignore[attr-defined]

    def _headers(self, status: int, content_type: str = "application/json; charset=utf-8",
                 length: int | None = None) -> None:
        self.send_response(status)
        for key, value in {
            "Content-Type": content_type, "Cache-Control": "private, no-store, max-age=0",
            "Pragma": "no-cache", "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        }.items():
            self.send_header(key, value)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, status: int, value: Any) -> None:
        raw = canonical(value)
        self._headers(status, length=len(raw))
        self.wfile.write(raw)

    def _session(self, create: bool = False) -> tuple[str | None, Session | None]:
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        key = jar.get("ct_session").value if jar.get("ct_session") else None
        session = self.app.sessions.get(key)
        if session or not create:
            return key, session
        key, session = self.app.sessions.create()
        self._pending_cookie = f"ct_session={key}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"
        return key, session

    def _redirect(self, url: str, *, cookie: str | None = None) -> None:
        self.send_response(303)
        self.send_header("Location", url)
        self.send_header("Cache-Control", "private, no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _token(self) -> str:
        _, session = self._session()
        if not session or not session.token:
            raise SignInRequired("sign in required")
        return session.token

    def do_GET(self):  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if parsed.path == "/auth/github":
                return self._oauth_start()
            if parsed.path == "/auth/github/callback":
                return self._oauth_callback(parse_qs(parsed.query))
            if parsed.path in ("/", "/index.html") or parsed.path.startswith("/items/"):
                return self._static("index.html")
            if parsed.path == "/favicon.ico":
                return self._headers(204, "image/x-icon", 0)
            if parsed.path in ("/app.js", "/style.css"):
                return self._static(parsed.path[1:])
            if parsed.path == "/api/item":
                return self._api_item(parse_qs(parsed.query), force=False)
            if parsed.path == "/api/action-check":
                return self._api_item(parse_qs(parsed.query), force=True)
            self._json(404, {"status": "not_found"})
        except SignInRequired:
            self._json(401, {"status": "sign_in_required"})
        except NotAuthorized:
            self._json(403, {"status": "access_denied"})
        except (DashboardError, GitHubUnavailable):
            self._json(503, {"status": "unavailable", "message": "Needs attention is temporarily unavailable"})

    def _static(self, name: str) -> None:
        path = Path(__file__).with_name("static") / name
        raw = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self._headers(200, f"{content_type}; charset=utf-8", len(raw))
        self.wfile.write(raw)

    def _oauth_start(self) -> None:
        key, session = self._session(create=True)
        assert key and session
        session.oauth_state = secrets.token_urlsafe(32)
        session.verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(session.verifier.encode()).digest()).decode().rstrip("=")
        query = urlencode({"client_id": self.app.config.client_id,
                           "redirect_uri": f"{self.app.config.origin}/auth/github/callback",
                           "state": session.oauth_state,
                           "code_challenge": challenge, "code_challenge_method": "S256"})
        self._redirect(f"https://github.com/login/oauth/authorize?{query}",
                       cookie=getattr(self, "_pending_cookie", None))

    def _oauth_callback(self, query: dict[str, list[str]]) -> None:
        key, session = self._session()
        state = query.get("state", [None])[0]
        code = query.get("code", [None])[0]
        if not session or not code or not state or not session.oauth_state or not session.verifier \
                or not hmac.compare_digest(state, session.oauth_state):
            raise NotAuthorized("OAuth state invalid")
        verifier = session.verifier
        session.oauth_state = session.verifier = None
        secret = self.app.read_client_secret()
        payload = urlencode({"client_id": self.app.config.client_id, "client_secret": secret,
                             "code": code, "redirect_uri": f"{self.app.config.origin}/auth/github/callback",
                             "code_verifier": verifier,
                             "repository_id": str(self.app.service.load()["binding"]["repository_id"])}).encode()
        request = Request("https://github.com/login/oauth/access_token", data=payload, method="POST",
                          headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
                                   "User-Agent": "codex-toolkit-dashboard/1"})
        try:
            with self.app.oauth_opener.open(request, timeout=10) as response:
                value = json.loads(response.read())
        except (HTTPError, URLError, OSError, json.JSONDecodeError) as exc:
            raise NotAuthorized("OAuth exchange failed") from exc
        token = value.get("access_token") if isinstance(value, dict) else None
        if not isinstance(token, str) or not token:
            raise NotAuthorized("OAuth exchange failed")
        session.token = token
        assert key
        rotated = self.app.sessions.rotate(key, session)
        cookie = f"ct_session={rotated}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"
        self._redirect(f"/items/{quote(self.app.config.delivery_id)}", cookie=cookie)

    def _api_item(self, query: dict[str, list[str]], *, force: bool) -> None:
        requested = query.get("revision", [None])[0]
        token = self._token()
        value = self.app.service.present(token, force=force, requested_revision=requested)
        self._json(200, value)


class Application:
    def __init__(self, config: Config, *, github_factory=GitHubClient):
        self.config = config
        self.sessions = SessionStore()
        self.service = DashboardService(snapshot=config.snapshot, invalidations=config.invalidations,
                                        repo=config.repo, delivery_id=config.delivery_id,
                                        github_factory=github_factory)
        self.oauth_opener = build_opener(ProxyHandler({}), NoRedirect())

    def read_client_secret(self) -> str:
        path = self.config.client_secret_file
        if path is None:
            raise DashboardError("OAuth secret unavailable")
        info = path.stat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise DashboardError("OAuth secret permissions invalid")
        value = path.read_text().strip()
        if not value or len(value) > 4096:
            raise DashboardError("OAuth secret invalid")
        return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--origin", default="https://ct.kaspars.cc")
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--client-secret-file", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--invalidations", type=Path, required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--delivery-id", required=True)
    args = parser.parse_args()
    config = Config(**vars(args))
    app = Application(config)
    server = ThreadingHTTPServer((config.bind, config.port), DashboardHandler)
    server.app = app  # type: ignore[attr-defined]
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
