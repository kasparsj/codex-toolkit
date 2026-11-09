"""Read-only issue ranking for GitHub delivery."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tomllib
from urllib.parse import quote, unquote, urlencode


REPO = re.compile(r"(?:github\.com/)?([\w.-]+/[\w.-]+)", re.ASCII | re.IGNORECASE)
SHA = re.compile(r"[0-9a-f]{40}")
PATH = re.compile(r"(?<![\w./@-])(?:[\w.-]+/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{1,8}(?![\w/-])")
DOCS_INTENT = re.compile(
    r"^(?:docs:\s*|document\b|(?:add|correct|fix|update|clarify|expand|rewrite|remove)\s+"
    r"(?:the\s+)?(?:docs?\b|documentation\b|readme\b|handbook\b|runbook\b))", re.I,
)
PRODUCT_INTENT = re.compile(
    r"\b(?:add|change|fix|implement|remove|rename|render|update)\s+(?:(?:a|an|the)\s+)?"
    r"(?!(?:docs?|documentation|readme|handbook|runbook)\b)(?:[\w-]+\s+){0,2}"
    r"(?:UI|screen|form|button|navigation|code|API|endpoint|schema|tests?|handler|component)\b", re.I,
)
DOCS_SUFFIX = {".md", ".mdx", ".rst", ".adoc", ".txt"}


class PreviewError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise PreviewError(message)


def read(endpoint, *, paginated=False, missing=False):
    argv = ["gh", "api", "--hostname", "github.com", "--method", "GET", endpoint]
    if paginated:
        argv += ["--paginate", "--slurp"]
    try:
        response = subprocess.run(argv, capture_output=True, text=True, check=False, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PreviewError(f"GitHub GET unavailable for {endpoint}") from exc
    if missing and response.returncode and re.search(r"\bHTTP 404\b", response.stderr):
        return None
    require(response.returncode == 0, f"GitHub GET failed for {endpoint}")
    try:
        value = json.loads(response.stdout)
    except ValueError as exc:
        raise PreviewError(f"invalid GitHub JSON for {endpoint}") from exc
    if paginated:
        require(isinstance(value, list) and value and all(isinstance(page, list) for page in value),
                f"invalid GitHub pagination for {endpoint}")
        value = [item for page in value for item in page]
        require(all(isinstance(item, dict) for item in value), f"invalid GitHub rows for {endpoint}")
    return value


def listing(endpoint, *, reader=read, **params):
    return reader(f"{endpoint}?{urlencode({**params, 'per_page': 100})}", paginated=True)


def numbered(rows):
    items = {}
    for row in rows:
        number = row.get("number")
        require(type(number) is int and number > 0 and number not in items,
                "invalid or duplicate GitHub issue or PR number")
        items[number] = row
    return items


def labels(issue):
    names = issue.get("labels")
    require(isinstance(names, list) and all(isinstance(label, dict)
            and isinstance(label.get("name"), str) and label["name"] for label in names),
            f"unreadable labels on issue #{issue['number']}")
    return {label["name"] for label in names}


def branch_tip(api, branch, reader=read):
    sha = reader(f"{api}/git/ref/heads/{quote(branch, safe='/')}")["object"]["sha"]
    require(isinstance(sha, str) and SHA.fullmatch(sha), "invalid default branch SHA")
    return sha


def policy_at(api, branch, sha, provisional):
    source = read(f"{api}/contents/.github/delivery.toml?ref={sha}", missing=True)
    if source is None:
        root = read(f"{api}/contents?ref={sha}")
        require(isinstance(root, list), "cannot establish access to pinned repository contents")
        require(provisional is not None, "no merged policy at the pinned base and no provisional policy supplied")
        raw = provisional.read_bytes()
        source_type = "provisional"
    else:
        require(source.get("type") == "file" and source.get("encoding") == "base64",
                "unreadable merged delivery policy")
        raw = base64.b64decode("".join(source["content"].split()), validate=True)
        source_type = "merged"
    policy = tomllib.loads(raw.decode())
    require(type(policy.get("version")) is int and policy["version"] == 1, "unsupported preview policy version")
    require(policy["branches"]["default_parent"] == branch, "preview policy must target the default branch")
    filters = {}
    for key in ("required_labels", "excluded_labels"):
        values = policy["eligibility"].get(key, [])
        require(isinstance(values, list) and all(isinstance(value, str) and value for value in values),
                f"invalid policy {key}")
        filters[key] = sorted(set(values))
    return {"source": source_type, "sha256": hashlib.sha256(raw).hexdigest(), **filters}


def text(item):
    title, body = item.get("title"), item.get("body")
    require(isinstance(title, str) and (body is None or isinstance(body, str)),
            f"unreadable title or body for #{item['number']}")
    return f"{title}\n{body or ''}"


def issue_paths(issue, repo):
    content = text(issue)
    links = re.findall(
        rf"https://github\.com/{re.escape(repo)}/blob/[0-9a-f]{{40}}/([^\s)#?]+)",
        content, flags=re.I,
    )
    content = re.sub(r"https?://\S+", "", content)
    return set(PATH.findall(content)) | {unquote(path) for path in links}


def documentation_scope(issue, paths):
    if PRODUCT_INTENT.search(text(issue)):
        return "non_documentation_intent"
    if not DOCS_INTENT.match(issue["title"]) and not re.search(
            r"\b(?:documentation|docs)[ -]only\b", issue.get("body") or "", re.I):
        return "documentation_scope_unconfirmed"
    if any(Path(path).suffix.lower() not in DOCS_SUFFIX for path in paths):
        return "non_documentation_paths"
    if not paths:
        return "documentation_paths_missing"
    return None


def explicit_links(pr, repo):
    content = text(pr)
    # Remove qualified references before matching repository-relative #N mentions.
    qualified = re.compile(r"(?:https?://github\.com/)?([\w.-]+/[\w.-]+)(?:/issues/|#)(\d+)", re.I)
    links = {int(number) for name, number in qualified.findall(content) if name.lower() == repo.lower()}
    relative = qualified.sub("", content)
    # Standalone issue references and closing/relationship lines establish a link.
    links.update(int(number) for number in re.findall(
        r"(?im)^\s*(?:[-*]\s*)?(?:closes?|fix(?:es)?|resolves?|refs?|issue)\s*:?\s*#(\d+)\b",
        relative,
    ))
    branch = pr["head"]["ref"]
    match = re.fullmatch(r"codex/(?:issue|plan)-(\d+)", branch)
    if match and (pr["head"].get("repo") or {}).get("full_name", "").lower() == repo.lower():
        links.add(int(match[1]))
    return links


def pr_revision(pr):
    head, base = pr["head"], pr["base"]
    require(SHA.fullmatch(head["sha"]) and SHA.fullmatch(base["sha"])
            and isinstance(base["ref"], str) and type(base["repo"]["id"]) is int,
            f"unreadable revision for PR #{pr['number']}")
    return head["sha"], base["sha"], base["ref"], base["repo"]["id"]


def pr_paths(api, pr, reader=read):
    endpoint = f"{api}/pulls/{pr['number']}"
    before = reader(endpoint)
    revision = pr_revision(pr)
    require(pr_revision(before) == revision and before["state"] == "open",
            f"open PR #{pr['number']} changed during preview")
    count = before["changed_files"]
    require(type(count) is int and 0 <= count <= 3000,
            f"cannot read complete file list for PR #{pr['number']}")
    files = listing(f"{endpoint}/files", reader=reader)
    require(len(files) == count and all(isinstance(row.get("filename"), str) for row in files),
            f"incomplete file list for PR #{pr['number']}")
    after = reader(endpoint)
    require(pr_revision(after) == revision and after["state"] == "open" and after["changed_files"] == count,
            f"open PR #{pr['number']} changed during file reads")
    return {row[key] for row in files for key in ("filename", "previous_filename")
            if isinstance(row.get(key), str)}


def linked_from_timeline(events, repo, pulls):
    linked = set()
    prefix = f"https://github.com/{repo.lower()}/pull/"
    for event in events:
        if event.get("event") != "cross-referenced":
            continue
        origin = (event.get("source") or {}).get("issue") or {}
        url = origin.get("html_url", "").lower()
        if origin.get("number") in pulls and url == prefix + str(origin["number"]):
            linked.add(origin["number"])
    return linked


def rank(api, repo, issues, pulls, policy, documentation_only=False, *, reader=read):
    eligible, excluded, unresolved = [], [], []
    links = {number: explicit_links(pr, repo) for number, pr in pulls.items()}
    changed_paths = {}
    for number, issue in issues.items():
        names = {name.casefold() for name in labels(issue)}
        covered = sorted(pr for pr, targets in links.items() if number in targets)
        item = {"number": number, "title": issue["title"]}
        if covered:
            item["pull_requests"] = covered
        if names.intersection(name.casefold() for name in policy["excluded_labels"]):
            excluded.append({**item, "reason": "excluded_label"})
        elif not {name.casefold() for name in policy["required_labels"]}.issubset(names):
            excluded.append({**item, "reason": "missing_required_label"})
        elif covered:
            excluded.append({**item, "reason": "linked_open_pull_request"})
        else:
            paths = issue_paths(issue, repo)
            scope = documentation_scope(issue, paths) if documentation_only else None
            if scope in {"non_documentation_paths", "non_documentation_intent"}:
                excluded.append({**item, "reason": scope})
                continue
            if scope or (pulls and not paths):
                unresolved.append({**item, "reason": scope or "scope_paths_missing"})
                continue
            issue_api = f"{api}/issues/{number}"
            dependencies = listing(f"{issue_api}/dependencies/blocked_by", reader=reader)
            require(all(dep.get("state") in {"open", "closed"} for dep in dependencies),
                    f"unreadable dependencies for issue #{number}")
            if any(dep["state"] == "open" for dep in dependencies):
                excluded.append({**item, "reason": "open_dependency"})
                continue
            timeline = listing(f"{issue_api}/timeline", reader=reader)
            referenced = linked_from_timeline(timeline, repo, pulls)
            if referenced:
                unresolved.append({**item, "reason": "open_pull_request_cross_reference",
                                   "pull_requests": sorted(referenced)})
                continue
            if pulls and any(event.get("event") == "connected" for event in timeline):
                # A manual link event can omit the identity of the linked work.
                unresolved.append({**item, "reason": "manual_link_requires_review"})
                continue
            if documentation_only and any(
                event.get("event") == "commented" and PRODUCT_INTENT.search(event.get("body") or "")
                for event in timeline
            ):
                unresolved.append({**item, "reason": "issue_comment_changes_scope"})
                continue
            for pr_number, pr in pulls.items():
                if pr_number not in changed_paths:
                    changed_paths[pr_number] = pr_paths(api, pr, reader)
            overlaps = sorted(pr for pr, files in changed_paths.items()
                              if paths.intersection(files)
                              or {path for path in paths if "/" not in path}
                              .intersection(Path(file).name for file in files))
            if overlaps:
                unresolved.append({**item, "reason": "open_pull_request_path_overlap", "pull_requests": overlaps})
                continue
            eligible.append({**item, "paths": sorted(paths), "created_at": issue["created_at"],
                             "reason": "policy and open PR coverage checks passed"})
    # Oldest eligible issue first, with issue number as the stable tie-break.
    eligible.sort(key=lambda item: (item["created_at"], item["number"]))
    return eligible, excluded, unresolved


def scan(repo, policy, documentation_only=False, *, reader=read, own_pr=None):
    api = f"repos/{repo}"
    issues = numbered([row for row in listing(f"{api}/issues", state="open", reader=reader) if "pull_request" not in row])
    pulls = numbered(listing(f"{api}/pulls", state="open", reader=reader))
    require(all(issue.get("state") == "open" and isinstance(issue.get("created_at"), str)
                and isinstance(issue.get("title"), str)
                for issue in issues.values()), "unreadable open issue inventory")
    require(all(pr.get("state") == "open" and type(pr.get("draft")) is bool
                and isinstance(pr["head"]["ref"], str) and SHA.fullmatch(pr["head"]["sha"])
                for pr in pulls.values()), "unreadable open PR inventory")
    if own_pr is not None:
        own = pulls.get(own_pr["number"])
        require(own is not None and own.get("node_id") == own_pr["node_id"],
                "bound draft disappeared during competing PR scan")
        del pulls[own_pr["number"]]
    inventory = {"open_issues": len(issues),
                 "unlabeled_issues": sum(not labels(i) for i in issues.values()),
                 "open_pull_requests": len(pulls),
                 "draft_pull_requests": sum(pr["draft"] for pr in pulls.values())}
    return inventory, *rank(api, repo, issues, pulls, policy, documentation_only, reader=reader)


def effective_filters(policy):
    eligibility = policy["eligibility"]
    label = policy["tracking"]["review_label"]
    return {"required_labels": eligibility["required_labels"],
            "excluded_labels": sorted(set(eligibility["excluded_labels"]) | {label})}


def verify_candidate(repo, issue, policy, *, reader, own_pr=None):
    _, ranked, excluded, unresolved = scan(repo, effective_filters(policy), reader=reader, own_pr=own_pr)
    if issue is None:
        require(ranked and not unresolved, "cannot select a winner: no candidate or incomplete coverage")
        return ranked[0]["number"]
    for item in ranked:
        if item["number"] == issue:
            return issue
    reason = next((item["reason"] for item in excluded + unresolved if item["number"] == issue),
                  "issue_not_open_or_unreadable")
    raise PreviewError(f"issue #{issue} is not eligible: {reason}")


def run(repository, provisional=None, *, documentation_only=False, reader=read,
        resolve=None, readiness=None):
    result = {"schema_version": 1, "repo": repository, "mode": "preview", "winner": None}
    try:
        match = REPO.fullmatch(repository)
        require(match is not None and all(part not in {".", ".."} for part in match[1].split("/")),
                "preview repository must be owner/name on github.com")
        requested = match[1]
        identity = reader(f"repos/{requested}")
        repo, branch = identity["full_name"], identity["default_branch"]
        require(repo.lower() == requested.lower() and type(identity["id"]) is int and identity["id"] > 0,
                "repository identity mismatch")
        require(isinstance(branch, str) and branch and not branch.startswith("-"),
                "invalid default branch")
        api = f"repos/{repo}"
        sha = branch_tip(api, branch, reader)
        result.update(repo=repo, repository_id=identity["id"], base={"ref": branch, "sha": sha},
                      scope="documentation_only" if documentation_only else "all")
        if resolve is None:
            policy = policy_at(api, branch, sha, provisional)
            result["policy"] = policy
        else:
            effective = resolve(repo, branch, sha)
            policy = effective_filters(effective)
            result["policy"] = {**effective["_source"], **policy,
                                "review_label": effective["tracking"]["review_label"],
                                "approvals": effective["approvals"],
                                "branches": effective["branches"],
                                "verification": ("actions" if effective["delivery"].get(
                                    "require_github_actions", True) else "local")}
            if readiness is not None:
                result["publication_readiness"] = readiness(repo, branch, sha, effective)
        inventory, ranked, excluded, unresolved = scan(repo, policy, documentation_only, reader=reader)
        result["inventory"] = inventory
        current = reader(api)
        require(current["id"] == identity["id"] and current["full_name"] == repo
                and current["default_branch"] == branch and branch_tip(api, branch, reader) == sha,
                "repository or default branch changed during preview")
        result.update(shortlist=ranked, exclusions=excluded, unresolved=unresolved)
        result["status"] = "coverage_incomplete" if unresolved else "ranked" if ranked else "no_candidate"
        if result["status"] == "ranked":
            result["winner"] = ranked[0]["number"]
    except (RuntimeError, OSError, KeyError, TypeError, ValueError, AttributeError) as exc:
        # Invalid upstream shapes and local policy errors also fail closed.
        result.update(status="coverage_incomplete", error=str(exc), winner=None)
    return result
