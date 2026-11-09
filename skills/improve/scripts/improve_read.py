#!/usr/bin/env python3
"""Read-only GitHub evidence and pinned Git source validation for Improve."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


API_ORIGIN = "https://api.github.com"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
OWNER_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MAX_PAGES = 5
PER_PAGE = 50
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_SOURCES = 5
MAX_BLOB_BYTES = 256 * 1024
MAX_SOURCE_LINES = 200


class ImproveReadError(RuntimeError):
    """Raised when repository evidence cannot be read safely or completely."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ImproveReadError(message)


def _byte_length(value: str, label: str) -> int:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ImproveReadError(f"{label} is not valid Unicode") from exc


def _canonical_repo(value: Any) -> str:
    _require(isinstance(value, str), "repository must be owner/name on github.com")
    candidate = value.strip().removesuffix(".git")
    if candidate.startswith("https://github.com/"):
        candidate = candidate.removeprefix("https://github.com/")
    elif candidate.startswith("github.com/"):
        candidate = candidate.removeprefix("github.com/")
    _require(OWNER_REPO.fullmatch(candidate) is not None, "repository must be owner/name on github.com")
    _require(all(part not in {".", ".."} for part in candidate.split("/")),
             "repository must be owner/name on github.com")
    return candidate.lower()


def _valid_ref(value: Any) -> bool:
    return (isinstance(value, str) and bool(value)
            and _byte_length(value, "repository ref") <= 255
            and not value.startswith("-") and ".." not in value
            and not any(ord(character) < 32 or ord(character) == 127 for character in value))


def _fixture_origin(value: str | None) -> str:
    if value is None:
        return API_ORIGIN
    parsed = urlsplit(value)
    _require(parsed.scheme == "http", "fixture URL must use loopback HTTP")
    _require(parsed.hostname in {"127.0.0.1", "::1"}, "fixture URL must be loopback")
    _require(parsed.username is None and parsed.password is None, "fixture URL may not contain credentials")
    _require(not parsed.query and not parsed.fragment, "fixture URL may not contain query or fragment")
    _require(parsed.path in {"", "/"}, "fixture URL may not contain a path")
    _require(parsed.port is not None, "fixture URL must include an explicit port")
    return value.rstrip("/")


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ImproveReadError("GitHub returned duplicate JSON keys")
        result[key] = value
    return result


@dataclass(frozen=True)
class _Response:
    value: Any
    next_page: bool


class _Reader:
    def __init__(self, fixture_url: str | None = None):
        self.origin = _fixture_origin(fixture_url)
        self.fixture = fixture_url is not None
        self.opener = build_opener(ProxyHandler({}), _NoRedirect())

    def get(self, path: str, params: dict[str, Any] | None = None) -> _Response:
        _require(path.startswith("/") and not path.startswith("//"), "invalid GitHub API path")
        query = urlencode(params or {})
        url = f"{self.origin}{path}" + (f"?{query}" if query else "")
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "codex-toolkit-improve-read/1",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        token = os.environ.get("IMPROVE_READ_TOKEN")
        if token and not self.fixture:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(url, headers=headers, method="GET")
        try:
            with self.opener.open(request, timeout=20) as response:
                length = response.headers.get("Content-Length")
                if length is not None:
                    _require(0 <= int(length) <= MAX_RESPONSE_BYTES,
                             "GitHub response has an invalid size")
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                _require(len(raw) <= MAX_RESPONSE_BYTES, "GitHub response is too large")
                link = response.headers.get("Link", "")
        except HTTPError as exc:
            raise ImproveReadError(f"GitHub GET failed with HTTP {exc.code}") from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise ImproveReadError("GitHub GET was unavailable") from exc
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ImproveReadError("GitHub returned invalid JSON") from exc
        return _Response(value=value, next_page='rel="next"' in link)

    def pages(self, path: str, params: dict[str, Any]) -> tuple[list[Any], bool]:
        values: list[Any] = []
        for page in range(1, MAX_PAGES + 1):
            response = self.get(path, {**params, "per_page": PER_PAGE, "page": page})
            if not isinstance(response.value, list):
                raise ImproveReadError("paginated GitHub response must be an array")
            values.extend(response.value)
            if not response.next_page:
                return values, True
        return values, not response.next_page


def _resolve(reader: _Reader, repo: str, ref: str | None = None) -> dict[str, Any]:
    canonical = _canonical_repo(repo)
    encoded_repo = "/".join(quote(part, safe="") for part in canonical.split("/"))
    repository = reader.get(f"/repos/{encoded_repo}").value
    _require(isinstance(repository, dict), "repository response must be an object")
    full_name = repository.get("full_name")
    _require(isinstance(full_name, str) and _canonical_repo(full_name) == canonical,
             "repository identity mismatch")
    repo_id = repository.get("id")
    _require(isinstance(repo_id, int) and not isinstance(repo_id, bool) and repo_id > 0,
             "repository ID is invalid")
    visibility = repository.get("visibility")
    if visibility is None and isinstance(repository.get("private"), bool):
        visibility = "private" if repository["private"] else "public"
    _require(visibility in ("public", "private", "internal"), "repository visibility is invalid")
    selected_ref = ref or repository.get("default_branch")
    _require(_valid_ref(selected_ref), "repository ref is invalid")
    commit = reader.get(f"/repos/{encoded_repo}/commits/{quote(selected_ref, safe='')}").value
    _require(isinstance(commit, dict) and FULL_SHA.fullmatch(str(commit.get("sha", ""))) is not None,
             "repository revision is invalid")
    return {
        "repo": canonical,
        "id": repo_id,
        "visibility": visibility,
        "ref": selected_ref,
        "sha": commit["sha"],
    }


def resolve(repo: str, ref: str | None = None, fixture_url: str | None = None) -> dict[str, Any]:
    """Resolve a GitHub repository and ref to an immutable identity and commit."""
    return _resolve(_Reader(fixture_url), repo, ref)


def _same_binding(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(key) == right.get(key) for key in ("repo", "id", "visibility", "ref", "sha"))


def _validate_binding(binding: Any) -> dict[str, Any]:
    _require(isinstance(binding, dict) and set(binding) == {"repo", "id", "visibility", "ref", "sha"},
             "repository binding is invalid")
    canonical = _canonical_repo(binding["repo"])
    _require(isinstance(binding["id"], int) and not isinstance(binding["id"], bool)
             and binding["id"] > 0, "repository binding ID is invalid")
    _require(binding["visibility"] in ("public", "private", "internal"),
             "repository binding visibility is invalid")
    ref = binding["ref"]
    _require(_valid_ref(ref), "repository binding ref is invalid")
    _require(isinstance(binding["sha"], str) and FULL_SHA.fullmatch(binding["sha"]) is not None,
             "repository binding SHA is invalid")
    _require(binding["repo"] == canonical, "repository binding must use canonical lowercase owner/name")
    return binding


def _record_number(value: Any) -> int:
    _require(isinstance(value, dict), "GitHub work item must be an object")
    number = value.get("number")
    _require(isinstance(number, int) and not isinstance(number, bool) and number > 0,
             "GitHub work item number is invalid")
    return number


def _safe_string(value: Any, label: str, limit: int = 128 * 1024) -> str:
    _require(value is None or isinstance(value, str), f"GitHub {label} is invalid")
    result = value or ""
    _require(_byte_length(result, f"GitHub {label}") <= limit, f"GitHub {label} is too large")
    return result


def _safe_count(value: Any, label: str) -> int | None:
    _require(value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0),
             f"GitHub {label} is invalid")
    return value


def _safe_bool(value: Any, label: str) -> bool | None:
    _require(value is None or isinstance(value, bool), f"GitHub {label} is invalid")
    return value


def _normalize_issue(value: dict[str, Any]) -> dict[str, Any]:
    number = _record_number(value)
    labels = value.get("labels", [])
    _require(isinstance(labels, list), "GitHub issue labels are invalid")
    return {
        "kind": "issue",
        "type": "issue",
        "number": number,
        "title": _safe_string(value.get("title"), "issue title", 2048),
        "body": _safe_string(value.get("body"), "issue body"),
        "state": _safe_string(value.get("state"), "issue state", 32),
        "state_reason": _safe_string(value.get("state_reason"), "issue state reason", 64),
        "created_at": _safe_string(value.get("created_at"), "issue creation timestamp", 64),
        "updated_at": _safe_string(value.get("updated_at"), "issue update timestamp", 64),
        "closed_at": _safe_string(value.get("closed_at"), "issue closure timestamp", 64),
        "labels": [_safe_string(item.get("name"), "issue label", 256)
                   for item in labels if isinstance(item, dict) and isinstance(item.get("name"), str)],
    }


def _normalize_pr(value: dict[str, Any], files: list[dict[str, Any]]) -> dict[str, Any]:
    number = _record_number(value)
    normalized_files: list[dict[str, Any]] = []
    for item in files:
        _require(isinstance(item, dict), "GitHub pull request file is invalid")
        filename = _safe_string(item.get("filename"), "pull request filename", 4096)
        _require(filename and not filename.startswith("/") and ".." not in PurePosixPath(filename).parts,
                 "GitHub pull request filename is unsafe")
        normalized_files.append({
            "filename": filename,
            "status": _safe_string(item.get("status"), "pull request file status", 32),
            "previous_filename": _safe_string(item.get("previous_filename"),
                                              "pull request previous filename", 4096),
            "additions": _safe_count(item.get("additions"), "pull request additions"),
            "deletions": _safe_count(item.get("deletions"), "pull request deletions"),
            "changes": _safe_count(item.get("changes"), "pull request changes"),
            "patch": _safe_string(item.get("patch"), "pull request patch", 64 * 1024),
        })
    head = value.get("head") if isinstance(value.get("head"), dict) else {}
    base = value.get("base") if isinstance(value.get("base"), dict) else {}
    return {
        "kind": "pr",
        "type": "pull_request",
        "number": number,
        "title": _safe_string(value.get("title"), "pull request title", 2048),
        "body": _safe_string(value.get("body"), "pull request body"),
        "state": _safe_string(value.get("state"), "pull request state", 32),
        "draft": _safe_bool(value.get("draft"), "pull request draft state"),
        "merged": _safe_bool(value.get("merged"), "pull request merged state"),
        "merged_at": _safe_string(value.get("merged_at"), "pull request merge timestamp", 64),
        "closed_at": _safe_string(value.get("closed_at"), "pull request closure timestamp", 64),
        "created_at": _safe_string(value.get("created_at"), "pull request creation timestamp", 64),
        "updated_at": _safe_string(value.get("updated_at"), "pull request update timestamp", 64),
        "head": {"ref": _safe_string(head.get("ref"), "pull request head ref", 256),
                 "sha": _safe_string(head.get("sha"), "pull request head SHA", 64)},
        "base": {"ref": _safe_string(base.get("ref"), "pull request base ref", 256),
                 "sha": _safe_string(base.get("sha"), "pull request base SHA", 64)},
        "files": normalized_files,
    }


def _details(reader: _Reader, repo: str, items: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool, str | None]:
    encoded_repo = "/".join(quote(part, safe="") for part in repo.split("/"))
    records: list[dict[str, Any]] = []
    complete = True
    reason: str | None = None
    for item in items:
        try:
            number = _record_number(item)
            if "pull_request" in item:
                detail = reader.get(f"/repos/{encoded_repo}/pulls/{number}").value
                _require(isinstance(detail, dict), "pull request detail must be an object")
                _require(_record_number(detail) == number, "pull request detail identity mismatch")
                files, files_complete = reader.pages(
                    f"/repos/{encoded_repo}/pulls/{number}/files", {}
                )
                if not files_complete:
                    complete = False
                    reason = reason or "pull request file pagination exceeded the declared bound"
                records.append(_normalize_pr(detail, files))
            else:
                detail = reader.get(f"/repos/{encoded_repo}/issues/{number}").value
                _require(isinstance(detail, dict), "issue detail must be an object")
                _require(_record_number(detail) == number, "issue detail identity mismatch")
                # The list/search discriminator can lag. Trust the direct record.
                if "pull_request" in detail:
                    pr = reader.get(f"/repos/{encoded_repo}/pulls/{number}").value
                    _require(isinstance(pr, dict), "pull request detail must be an object")
                    _require(_record_number(pr) == number, "pull request detail identity mismatch")
                    files, files_complete = reader.pages(
                        f"/repos/{encoded_repo}/pulls/{number}/files", {}
                    )
                    if not files_complete:
                        complete = False
                        reason = reason or "pull request file pagination exceeded the declared bound"
                    records.append(_normalize_pr(pr, files))
                else:
                    records.append(_normalize_issue(detail))
        except ImproveReadError as exc:
            complete = False
            reason = reason or str(exc)
    return records, complete, reason


def search(binding: dict[str, Any], terms: list[str], fixture_url: str | None = None) -> dict[str, Any]:
    """Collect bounded issue and pull-request evidence using GET-only GitHub APIs."""
    binding = _validate_binding(binding)
    repo = binding["repo"]
    _require(isinstance(terms, list) and 1 <= len(terms) <= 3,
             "search requires one to three term sets")
    _require(all(isinstance(term, str) and term == term.strip()
                 and 0 < _byte_length(term, "search term set") <= 160
                 and not any(ord(character) < 32 or ord(character) == 127 for character in term)
                 for term in terms), "search term set is invalid")
    _require(len(set(terms)) == len(terms), "search term sets must be distinct")
    reader = _Reader(fixture_url)
    try:
        before = _resolve(reader, repo, binding["ref"])
    except ImproveReadError as exc:
        return {"binding": binding, "terms": terms, "records": [], "complete": False, "reason": str(exc)}
    if not _same_binding(binding, before):
        return {"binding": binding, "terms": terms, "records": [], "complete": False,
                "reason": "repository identity or revision changed before search"}

    candidates: dict[int, dict[str, Any]] = {}
    complete = True
    reason: str | None = None
    for term in terms:
        try:
            response = reader.get("/search/issues", {
                "q": f"{term} repo:{repo}", "per_page": PER_PAGE, "page": 1,
            })
            page = 1
            matched = set()
            while True:
                value = response.value
                _require(isinstance(value, dict) and isinstance(value.get("items"), list),
                         "GitHub search response is invalid")
                total = value.get("total_count")
                _require(isinstance(total, int) and not isinstance(total, bool) and total >= 0,
                         "GitHub search total count is invalid")
                _require(isinstance(value.get("incomplete_results"), bool),
                         "GitHub search completeness flag is invalid")
                if value.get("incomplete_results") is not False:
                    complete = False
                    reason = reason or "GitHub search results are incomplete"
                for item in value["items"]:
                    number = _record_number(item)
                    candidates[number] = item
                    matched.add(number)
                if total > MAX_PAGES * PER_PAGE:
                    complete = False
                    reason = reason or "GitHub search exceeded the declared pagination bound"
                if not response.next_page:
                    if len(matched) != total:
                        complete = False
                        reason = reason or "GitHub search result count changed or was truncated"
                    break
                page += 1
                if page > MAX_PAGES:
                    complete = False
                    reason = reason or "GitHub search pagination exceeded the declared bound"
                    break
                response = reader.get("/search/issues", {
                    "q": f"{term} repo:{repo}", "per_page": PER_PAGE, "page": page,
                })
        except ImproveReadError as exc:
            complete = False
            reason = reason or str(exc)

    encoded_repo = "/".join(quote(part, safe="") for part in repo.split("/"))
    since = (datetime.now(timezone.utc) - timedelta(days=7)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        issues, issues_complete = reader.pages(f"/repos/{encoded_repo}/issues", {
            "state": "all", "sort": "updated", "direction": "desc", "since": since,
        })
        complete = complete and issues_complete
        if not issues_complete:
            reason = reason or "recent issue pagination exceeded the declared bound"
        for item in issues:
            candidates[_record_number(item)] = item
    except ImproveReadError as exc:
        complete = False
        reason = reason or str(exc)
    records, detail_complete, detail_reason = _details(reader, repo, candidates.values())
    complete = complete and detail_complete
    reason = reason or detail_reason
    try:
        after = _resolve(reader, repo, before["ref"])
        if not _same_binding(before, after):
            complete = False
            reason = reason or "repository identity or revision changed during search"
    except ImproveReadError as exc:
        complete = False
        reason = reason or str(exc)
    result: dict[str, Any] = {
        "binding": binding,
        "terms": terms,
        "records": sorted(records, key=lambda item: (item["kind"], item["number"])),
        "complete": complete,
    }
    if not complete:
        result["reason"] = reason or "GitHub evidence collection is incomplete"
    return result


def _git(checkout: Path, *args: str, text: bool = True) -> subprocess.CompletedProcess:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }
    try:
        return subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *args],
            cwd=checkout, env=env, text=text, capture_output=True, check=False, timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ImproveReadError("trusted Git inspection failed") from exc


def _remote_repo(value: str) -> str:
    if value.startswith("git@github.com:"):
        return _canonical_repo(value.removeprefix("git@github.com:"))
    parsed = urlsplit(value)
    _require(parsed.hostname == "github.com" and parsed.username in {None, "git"},
             "checkout remote is not github.com")
    _require(parsed.scheme in {"https", "ssh"} and parsed.port is None,
             "checkout remote is unsupported")
    _require(not parsed.query and not parsed.fragment, "checkout remote is invalid")
    return _canonical_repo(parsed.path.removeprefix("/"))


def _source_path(value: Any) -> str:
    _require(isinstance(value, str) and 0 < _byte_length(value, "source path") <= 512,
             "source path is invalid")
    _require("\\" not in value and "\x00" not in value and not value.startswith("/")
             and not any(ord(character) < 32 or ord(character) == 127 for character in value),
             "source path is unsafe")
    path = PurePosixPath(value)
    _require(value == path.as_posix() and all(part not in {"", ".", ".."} for part in path.parts),
             "source path is unsafe")
    return value


def verify_sources(binding: dict[str, Any], checkout: str | Path,
                   sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Read bounded line evidence from the binding's committed Git objects only."""
    binding = _validate_binding(binding)
    repo = binding["repo"]
    sha = binding["sha"]
    _require(isinstance(sources, list) and len(sources) <= MAX_SOURCES,
             "sources must contain at most five entries")
    root = Path(checkout)
    _require(root.is_absolute() and root.is_dir() and not root.is_symlink(),
             "checkout must be an absolute non-symlink directory")
    top = _git(root, "rev-parse", "--show-toplevel")
    _require(top.returncode == 0 and Path(top.stdout.strip()).resolve() == root.resolve(),
             "checkout must be the Git worktree root")
    remotes = _git(root, "config", "--local", "--no-includes", "--get-all", "remote.origin.url")
    _require(remotes.returncode == 0, "checkout has no origin remote")
    remote_repos = {_remote_repo(line) for line in remotes.stdout.splitlines() if line}
    _require(remote_repos == {repo}, "checkout remote does not match repository binding")
    commit = _git(root, "rev-parse", "--verify", f"{sha}^{{commit}}")
    _require(commit.returncode == 0 and commit.stdout.strip() == sha,
             "binding commit is unavailable in checkout")

    verified: list[dict[str, Any]] = []
    for source in sources:
        _require(isinstance(source, dict) and set(source) == {"path", "start", "end"},
                 "source must contain exactly path, start, and end")
        path = _source_path(source["path"])
        start, end = source["start"], source["end"]
        _require(all(isinstance(value, int) and not isinstance(value, bool) for value in (start, end)),
                 "source line range is invalid")
        _require(1 <= start <= end and end - start + 1 <= MAX_SOURCE_LINES,
                 "source line range is invalid")
        entry = _git(root, "ls-tree", sha, "--", path)
        _require(entry.returncode == 0, f"source tree entry cannot be read: {path}")
        fields = entry.stdout.partition("\t")[0].split()
        _require(len(fields) == 3 and fields[0] in {"100644", "100755"} and fields[1] == "blob",
                 f"source must be a regular committed file: {path}")
        size = _git(root, "cat-file", "-s", f"{sha}:{path}")
        _require(size.returncode == 0 and size.stdout.strip().isdigit(), f"source is missing: {path}")
        _require(int(size.stdout.strip()) <= MAX_BLOB_BYTES, f"source is too large: {path}")
        blob = _git(root, "cat-file", "blob", f"{sha}:{path}", text=False)
        _require(blob.returncode == 0, f"source cannot be read: {path}")
        try:
            content = blob.stdout.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ImproveReadError(f"source is not UTF-8 text: {path}") from exc
        lines = content.splitlines()
        _require(end <= len(lines), f"source line range exceeds file: {path}")
        verified.append({
            "path": path,
            "start": start,
            "end": end,
            "content": "\n".join(lines[start - 1:end]),
        })
    return verified
