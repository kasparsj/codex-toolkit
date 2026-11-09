"""Pinned GitHub REST responses at the HTTP boundary of the installed fixture."""

import datetime as dt
import json
from pathlib import Path
import subprocess


REPOSITORY_ID = 123
PR_NUMBER = 7
AUTHOR = {"id": 42, "type": "User", "login": "fixture-developer"}
REVIEW_LABEL = "status: review"
SECRET = "github_pat_fixture_secret"

HTTP_SHIM = """
import io
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import OpenerDirector


def fixture_open(self, request, *args, **kwargs):
    target = urlsplit(request.full_url)
    method = request.get_method()
    with Path(LOG).open("a") as stream:
        stream.write(json.dumps([method, target.path]) + "\\n")
    assert method == "GET" and target.netloc == "api.github.com", (method, target.netloc)
    assert request.get_header("Authorization") == "Bearer " + SECRET, "fixture token missing"
    path = unquote(target.path)
    state = json.loads(Path(STATE).read_text())
    repository = {"id": REPOSITORY_ID, "full_name": REPO, "default_branch": "main", "private": False}
    issue = {"id": 224, "number": ISSUE, "state": "open", "title": "Update fixture README",
             "body": "Update `README.md` with the expected fixture text.",
             "created_at": "2026-01-01T00:00:00Z",
             "labels": [{"name": name} for name in state["issue_labels"]]}
    pr = state["pr"]
    api = f"/repos/{REPO}"

    def missing():
        raise HTTPError(request.full_url, 404, "fixture not found", {}, None)

    if path == api:
        value = repository
    elif path in (f"/user/{AUTHOR['id']}", f"/users/{AUTHOR['login']}"):
        value = AUTHOR
    elif path == api + "/git/ref/heads/main":
        value = {"ref": "refs/heads/main", "object": {"sha": BASE}}
    elif path.startswith(api + "/git/ref/heads/"):
        if pr is None or path != api + "/git/ref/heads/" + pr["head"]["ref"]:
            return missing()
        value = {"ref": "refs/heads/" + pr["head"]["ref"], "object": {"sha": pr["head"]["sha"]}}
    elif path in (api + "/contents/.github/delivery.toml", api + "/contents/.github/workflows"):
        return missing()
    elif path == api + "/contents":
        value = [{"type": "file", "path": "README.md"}]
    elif path == api + "/issues":
        value = [issue]
    elif path == api + f"/issues/{ISSUE}":
        value = issue
    elif path in (api + f"/issues/{ISSUE}/timeline", api + f"/issues/{ISSUE}/dependencies/blocked_by"):
        value = []
    elif path == api + "/pulls":
        heads = parse_qs(target.query).get("head")
        owner = REPO.split("/")[0]
        value = [pr] if pr and (not heads or heads == [f"{owner}:{pr['head']['ref']}"]) else []
    elif path == api + f"/pulls/{PR_NUMBER}":
        if pr is None:
            return missing()
        value = pr
    elif path == api + f"/pulls/{PR_NUMBER}/reviews":
        value = state["reviews"]
    elif path == api + f"/pulls/{PR_NUMBER}/files":
        value = [{"filename": name} for name in ("README.md", "docs/plan.md")[:pr["changed_files"]]]
    elif path == api + "/branches/main":
        value = {"protected": True}
    elif path.startswith(api + "/rules/branches/"):
        value = []
    elif path == api + f"/labels/{REVIEW_LABEL}":
        value = {"name": REVIEW_LABEL}
    else:
        raise AssertionError(f"unexpected GitHub fixture GET {path}")
    return io.BytesIO(json.dumps(value).encode())


OpenerDirector.open = fixture_open
"""


def fixture_http(root, python, repo, base, issue):
    """Install a transport double in the isolated fixture venv only."""
    state = root / "github-fixture.json"
    log = root / "github.log"
    token = root / "read-token"
    token.write_text(SECRET)
    token.chmod(0o600)
    state.write_text(json.dumps({"pr": None, "reviews": [], "issue_labels": ["ready"]}))
    site = Path(subprocess.check_output(
        [str(python), "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
        cwd=root, text=True).strip())
    constants = {"REPO": repo, "BASE": base, "ISSUE": issue, "STATE": str(state), "LOG": str(log),
                 "SECRET": SECRET, "REPOSITORY_ID": REPOSITORY_ID, "AUTHOR": AUTHOR,
                 "PR_NUMBER": PR_NUMBER, "REVIEW_LABEL": REVIEW_LABEL}
    (site / "codex_toolkit_fixture_transport.py").write_text(
        "\n".join(f"{key} = {value!r}" for key, value in constants.items()) + "\n" + HTTP_SHIM
    )
    # A .pth import is processed with the venv's normal site initialization and
    # therefore survives the coordinator's deliberate PYTHONPATH stripping.
    (site / "codex_toolkit_fixture_transport.pth").write_text(
        "import codex_toolkit_fixture_transport\n"
    )
    return {"state": state, "log": log, "secret": SECRET, "token": token}


def fixture_pr(repo, handoff):
    identity = {"id": REPOSITORY_ID, "full_name": repo}
    return {"number": PR_NUMBER, "node_id": "PR_fixture_7", "state": "open", "draft": True,
            "head": {"repo": identity, "ref": handoff["head"], "sha": handoff["head_sha"]},
            "base": {"repo": identity, "ref": handoff["base"], "sha": handoff["base_sha"]},
            "user": AUTHOR, "body": handoff["body"], "title": handoff["title"],
            "changed_files": 1 if handoff["stage"] == "plan" else 2}


def fixture_review(review, number, *, sha=None):
    return {"id": number, "user": AUTHOR, "state": "COMMENTED",
            "submitted_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "commit_id": sha or review["head_sha"], "body": review["approve"]}
