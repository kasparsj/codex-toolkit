"""Developer-mediated publication for the shared delivery coordinator."""

from functools import partial
import os
from pathlib import Path
import secrets
import stat
import subprocess
import tempfile
from urllib.parse import quote

import agent_isolation
from app_auth import GitHubAppApi
import delivery
import effective_policy
import onboarding
import preview
from publisher import Publisher
import publisher_adapter
from trusted_git import TrustedGit


class ReadClient:
    """Pinned GitHub REST reads. No write, redirect, or ambient auth path."""

    def __init__(self, repo, token):
        self.repo = repo
        self.token = token
        self.transport = GitHubAppApi()

    def path(self, endpoint):
        owner, name = self.repo.split("/")
        path = endpoint.format(owner=owner, repo=name)
        target = f"/repos/{self.repo}"
        delivery.require(path == target or path.startswith(target + "/")
                         or path.startswith(("/user/", "/users/")),
                         "developer read escapes the bound repository")
        return path

    def api(self, method, repo, endpoint):
        delivery.require(method == "GET" and delivery.repo_identity(repo) ==
                         delivery.repo_identity(self.repo), "developer transport only allows bound GETs")
        return self.read(self.transport.request, "GET", self.path(endpoint))

    def paginated(self, repo, endpoint):
        delivery.require(delivery.repo_identity(repo) == delivery.repo_identity(self.repo),
                         "developer pagination repository mismatch")
        return self.read(self.transport.paginated, self.path(endpoint))

    def read(self, operation, *args):
        try:
            return operation(*args, token=self.token)
        except delivery.DeliveryError as exc:
            code = getattr(exc.__cause__, "code", None)
            detail = f" (HTTP {code})" if code else ""
            raise delivery.DeliveryError(f"developer GitHub GET failed for {args[-1]}{detail}") from exc.__cause__


def gh_read_token():
    env = {key: os.environ[key] for key in ("PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME")
           if key in os.environ}
    result = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"], env=env,
                            capture_output=True, text=True, check=False, timeout=15)
    token = result.stdout.strip()
    delivery.require(result.returncode == 0 and token and not any(c.isspace() for c in token),
                     "configured GitHub CLI read session is unavailable")
    return token


def read_token(path):
    if path is None:
        return ""
    source = Path(path)
    delivery.require(source.is_absolute() and not source.is_symlink(), "invalid read token path")
    info = source.stat()
    delivery.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                     and not info.st_mode & 0o077, "read token must be owner-only")
    effective_policy._protected_ancestry(source)
    token = source.read_text().strip()
    delivery.require(token.startswith("github_pat_") and token.isascii()
                     and all(c.isalnum() or c == "_" for c in token),
                     "use an explicitly provisioned read-only fine-grained GitHub token")
    return token


class Session:
    def __init__(self, config, repo):
        self.config = Path(config).absolute()
        self.profile = effective_policy.load(self.config)
        self.digest = delivery.digest_bytes(delivery.canonical_json(self.profile))
        self.repo = self.profile["repository"]
        delivery.require(delivery.repo_identity(repo) == delivery.repo_identity(self.repo)
                         and self.repo.count("/") == 1, "developer configuration repository mismatch")
        self.repository_id = self.profile["repository_id"]
        delivery.require(type(self.repository_id) is int and self.repository_id > 0,
                         "developer configuration requires a numeric repository ID")
        self.defaults = self.profile["policy"]
        self.verifier = self.profile.get("local_verifier")
        self.author_id = self.defaults["delivery"]["publisher_id"]
        self.token_file = self.profile.get("read_token_file")
        token = read_token(self.token_file)
        auth = self.profile.get("read_auth", "anonymous")
        delivery.require(auth in ("anonymous", "gh") and not (self.token_file and auth == "gh"),
                         "configure either a read-only token file or GitHub CLI REST reads")
        self.client = ReadClient(self.repo, gh_read_token() if auth == "gh" else token)
        self.reader = onboarding.app_reader(self.client, self.repo)
        self.git_factory = partial(TrustedGit, auth_env={"GH_TOKEN": token}, allow_ambient_auth=False)

    @classmethod
    def from_state(cls, state):
        bound = state["manual"]
        session = cls(bound["config"], state["repo"])
        delivery.require(session.digest == bound["digest"], "protected developer configuration changed")
        return session

    def resolve(self, repo, branch, sha):
        delivery.require(repo == self.repo, "developer repository name changed")
        policy = onboarding.resolve(self.defaults, repo, branch, sha, self.reader,
                                    allow_publisher_review=True)
        delivery.require(not policy["delivery"].get("require_github_actions", True),
                         "developer-mediated mode requires the trusted local verifier")
        return policy

    def repository(self):
        value = self.reader(f"repos/{self.repo}")
        delivery.require(value.get("id") == self.repository_id and value.get("full_name") == self.repo,
                         "developer repository identity changed")
        return value

    def preview(self):
        self.repository()
        return preview.run(self.repo, reader=self.reader, resolve=self.resolve)

    def publisher(self, state):
        return Publisher(repo=state["repo"], root=Path(state["manual"]["publisher_root"]),
                         client=self.client, git_factory=self.git_factory)

    def issue(self, number):
        value = self.reader(f"repos/{self.repo}/issues/{number}")
        delivery.require(value.get("number") == number and value.get("state") == "open"
                         and "pull_request" not in value and type(value.get("id")) is int,
                         "bound issue is missing or closed")
        scope = {key: value.get(key) for key in ("id", "title", "body")}
        return value, delivery.digest_bytes(delivery.canonical_json(scope))

    def check_context(self, state):
        policy = state["policy"]
        branch = self.repository()["default_branch"]
        sha = preview.branch_tip(f"repos/{self.repo}", branch, self.reader)
        delivery.require(branch == delivery.policy_branch(policy["ref"]) and sha == policy["sha"],
                         "pinned default branch or base revision changed")
        delivery.require(self.resolve(self.repo, branch, sha) == state["policy_values"],
                         "protected defaults, repository override or effective policy changed")
        issue, digest = self.issue(state["issue"])
        delivery.require(digest == state["manual"]["issue_digest"], "bound issue scope changed")
        labels = preview.labels(issue)
        eligibility = state["policy_values"]["eligibility"]
        names = {name.casefold() for name in labels}
        delivery.require({name.casefold() for name in eligibility["required_labels"]} <= names
                         and not names.intersection(name.casefold() for name in eligibility["excluded_labels"]),
                         "bound issue no longer meets eligibility policy")
        return sorted(labels)

    def paths(self, paths):
        allowed = self.profile["allowed_path_prefixes"]
        delivery.require(isinstance(allowed, list) and allowed
                         and all(isinstance(value, str) and value for value in allowed),
                         "developer profile needs a candidate path allowlist")
        for path in paths:
            delivery.require(not path.startswith(".github/") and path != ".github"
                             and any(path.startswith(value) if value.endswith("/") else path == value
                                     for value in allowed),
                             f"candidate path is privileged or outside the allowlist: {path}")

    def ref(self, branch):
        value = self.reader(f"repos/{self.repo}/git/ref/heads/{quote(branch, safe='/')}", missing=True)
        if value is None:
            return None
        sha = value.get("object", {}).get("sha")
        delivery.require(value.get("ref") == f"refs/heads/{branch}"
                         and isinstance(sha, str) and delivery.FULL_SHA.fullmatch(sha),
                         "developer branch readback is malformed")
        return sha

    def identity(self, pr):
        delivery.require(pr["head_repo_id"] == pr["base_repo_id"] == self.repository_id
                         and pr["author_id"] == self.author_id and pr["author_type"] == "User"
                         and pr["performed_via_github_app"] is None
                         and isinstance(pr["node_id"], str) and pr["node_id"],
                         "PR repository or human author does not match the developer binding")

    def exact_pr(self, publisher, expected, *, draft):
        pr = publisher._get_pr(expected["number"])
        self.identity(pr)
        publisher_adapter.validate_pr(pr, expected, draft=draft)
        delivery.require(pr["node_id"] == expected["node_id"] and pr["body"] == expected["body"],
                         "bound PR identity or delivery description changed")
        delivery.require(self.ref(pr["head"]) == pr["head_sha"], "published branch head changed")
        return pr


def start(coordinator, args):
    delivery.require(type(args.issue) is int and args.issue > 0, "developer mode requires an explicit issue")
    delivery.require(not any((args.no_dispatch, args.publisher_launcher, args.app_config, args.operator_app,
                             args.operator_policy, args.policy, args.policy_ref, args.policy_sha,
                             args.policy_digest, args.policy_fetched_at)),
                     "developer start uses the pinned workflow and developer configuration")
    session = Session(args.developer_config, args.repo)
    root = coordinator.root
    delivery.validate_protected_state_dir(
        root, expected=Path(session.profile["state_dir"]), label="developer mode state",
    )
    repo_dir = coordinator._repo_dir(args.repo)
    with delivery.mutex(repo_dir / "execution.lock") as execution_fd:
        active = repo_dir / "active.json"
        if active.exists():
            delivery.require(delivery.read_json(active)["status"] == "released",
                             "active delivery already claimed")
        repository = session.repository()
        branch = repository["default_branch"]
        sha = preview.branch_tip(f"repos/{session.repo}", branch, session.reader)
        policy = session.resolve(session.repo, branch, sha)
        preview.verify_candidate(session.repo, args.issue, policy, reader=session.reader)
        issue, issue_digest = session.issue(args.issue)
        reviewers = onboarding.reviewer_check(policy, session.reader)
        author = session.reader(f"user/{session.author_id}")
        delivery.require(author.get("id") == session.author_id and author.get("type") == "User",
                         "developer publisher must be a human GitHub account")
        owned = policy["branches"]["plan_template"].format(issue=args.issue)
        delivery.validate_ref(owned)
        delivery.require(owned != branch and session.ref(owned) is None, "developer branch already exists or is the base")
        rules = onboarding.branch_rules(session.repo, branch, owned, session.reader)
        label = policy["tracking"]["review_label"]
        delivery.require(session.reader(f"repos/{session.repo}/labels/{quote(label, safe='')}").get("name") == label,
                         "configured tracking label is missing")
        session.paths([])
        onboarding.verify_local_readiness(session.repo, sha, session.verifier, session.reader)
        stable = args.delivery_id or secrets.token_hex(12)
        state_path = coordinator._delivery_path(args.repo, stable)
        delivery.require(not state_path.exists(), "delivery ID already exists")
        launcher = Path(__file__).resolve().with_name("publisher.py")
        publisher_root = repo_dir / "publisher"
        publisher_root.mkdir(mode=0o700, exist_ok=True)
        identity = {"repository_id": session.repository_id, "publisher_id": session.author_id,
                    "publisher_login": author["login"], "branch_rules": rules}
        binding = {"config": str(session.config), "digest": session.digest,
                   "repository_id": session.repository_id, "repository_full_name": session.repo,
                   "publisher_root": str(publisher_root), "issue_digest": issue_digest,
                   "read_token_file": session.token_file, "identity": identity}
        snapshot = state_path.with_name("github-read-snapshot.json")
        agent = {"launcher": str(args.agent_launcher.resolve()), "worktree": str(args.worktree.resolve()),
                 "scratch": str(args.agent_scratch.resolve()), "skills_root": str(args.skills_root.resolve()),
                 "isolation_profile": "container", "container_image": args.container_image,
                 "read_snapshot": str(snapshot)}
        pending = {"credential_mode": "manual", "manual": binding, "repo": args.repo, "issue": args.issue,
                   "delivery_id": stable, "policy": policy["_source"], "policy_values": policy, "agent": agent}
        publisher = session.publisher(pending)
        delivery.require(not publisher._all_head_prs(owned), "developer branch already has a pull request")
        session.check_context(pending)
        delivery.atomic_json(snapshot, {"schema_version": 1, "repo": args.repo,
            "repository": {key: repository[key] for key in ("id", "full_name", "private", "default_branch")},
            "source": {"ref": policy["_source"]["ref"], "sha": sha}, "issues": [issue],
            "pull_requests": [], "reviewers": reviewers, "fetched_at": delivery.utc_now()})
        agent_isolation.preflight(state=pending, launcher=Path(agent["launcher"]),
                                  worktree=Path(agent["worktree"]), scratch=Path(agent["scratch"]),
                                  skills_root=args.skills_root)
        state = coordinator.start(repo=args.repo, issue=args.issue, policy=policy, skills_root=args.skills_root,
                                  delivery_id=stable, agent=agent, publisher_launcher=str(launcher), manual=binding)
        return delivery.run_app(coordinator, state, execution_fd)


def prepare(state, packet, stage, save):
    session = Session.from_state(state)
    session.check_context(state)
    publisher = session.publisher(state)
    expected = packet["expected"]
    handoff = state.get("manual_handoff", {})
    if handoff.get("stage") == stage and all(handoff.get(key) == value for key, value in expected.items()):
        delivery.require(Path(handoff["bundle"]).is_file(), "protected handoff bundle is missing")
        return state
    prior = packet["supersedes_pr"] or (packet["prior_pr"] if stage == "implementation" else None)
    if prior:
        session.exact_pr(publisher, prior, draft=True)
    else:
        delivery.require(session.ref(expected["head"]) is None
                         and not publisher._all_head_prs(expected["head"]), "developer branch is already in use")
    preview.verify_candidate(session.repo, state["issue"], state["policy_values"],
                             reader=session.reader, own_pr=prior)
    if stage == "implementation":
        publisher._approval(packet, "plan_approval")
    candidate = packet["candidate"]
    previous = prior["head_sha"] if prior else expected["base_sha"]
    session.paths(candidate["paths"])
    folder = publisher.root / "handoffs" / state["delivery_id"]
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    bundle = folder / f"{stage}-{expected['generation']}.bundle"
    with session.git_factory(publisher.root, publisher.canonical_url) as trusted:
        trusted.fetch_base(expected["base"], expected["base_sha"])
        trusted.import_candidate(Path(candidate["bundle_path"]), expected["head_sha"],
                                 expected["base_sha"], candidate["paths"],
                                 candidate["hashes"] if stage == "plan" else None)
        trusted.verify_introduced_paths(previous, allow_paths=session.paths)
        trusted.require_material_change(previous)
        with tempfile.TemporaryDirectory(dir=folder) as staging:
            validated = Path(staging) / "candidate.bundle"
            trusted.export_candidate(validated)
            validated.chmod(0o600)
            os.replace(validated, bundle)
    session.check_context(state)
    publisher.issue_digest = state["manual"]["issue_digest"]
    state["manual_handoff"] = {"stage": stage, **expected, "bundle": str(bundle),
                               "candidate_ref": "refs/heads/delivery-candidate", "prior_pr": prior,
                               "draft": True, "number": prior["number"] if prior else None,
                               "title": f"docs: plan issue #{state['issue']}" if stage == "plan"
                                        else f"fix: deliver issue #{state['issue']}",
                               "body": publisher._pr_body(packet),
                               "remote": publisher.canonical_url}
    save(state)
    return state


def reconcile(state, stage, number, save):
    publication = state.get("publication", {})
    if stage in publication:
        delivery.require(number is None or number == publication[stage]["pr"]["number"],
                         "supplied PR differs from the bound draft")
        return
    handoff = state.get("manual_handoff", {})
    delivery.require(handoff.get("stage") == stage, "local publication handoff missing")
    prior = handoff["prior_pr"]
    if prior:
        delivery.require(number is None or number == prior["number"], "must update the same bound draft")
        number = prior["number"]
    if number is None:
        return
    delivery.require(number > 0, "invalid draft PR number")
    session = Session.from_state(state)
    session.check_context(state)
    publisher = session.publisher(state)
    pr = publisher._get_pr(number)
    session.identity(pr)
    if prior:
        delivery.require(pr["node_id"] == prior["node_id"], "updated PR identity changed")
        if pr["head_sha"] == prior["head_sha"]:
            session.exact_pr(publisher, prior, draft=True)
            return
    publisher_adapter.validate_pr(pr, {**handoff, "number": number}, draft=True)
    delivery.require(session.ref(pr["head"]) == handoff["head_sha"], "published branch head differs from handoff")
    matches = publisher._all_head_prs(pr["head"])
    delivery.require([item["node_id"] for item in matches] == [pr["node_id"]],
                     "published branch has conflicting pull requests")
    if prior and pr["body"] == prior["body"]:
        return  # Branch update landed before the draft description edit.
    delivery.require(pr["body"].strip() == handoff["body"].strip(), "draft description differs from handoff")
    preview.verify_candidate(session.repo, state["issue"], state["policy_values"],
                             reader=session.reader, own_pr=pr)
    if stage == "implementation":
        publisher._approval({**publisher_adapter.packet_for(state, "publish_implementation"),
                             "expected": handoff, "supersedes_pr": state.get("corrections", {}).get(
                                 "implement", {}).get("pr"),
                             "plan_approval": publisher_adapter.approval_request(state, "plan")},
                            "plan_approval")
    state.setdefault("publication", {})[stage] = {"pr": pr, "published_at": delivery.utc_now(),
        "generation": handoff["generation"], "manifest_digest": handoff["manifest_digest"]}
    state.get("corrections", {}).pop("plan" if stage == "plan" else "implement", None)
    save(state)


def reviews(state, pr):
    session = Session.from_state(state)
    session.check_context(state)
    publisher = session.publisher(state)
    current = session.exact_pr(publisher, pr, draft=True)
    return {"paginated": True, "pr": current, "reviews": publisher._reviews(pr["number"])}


def finalize(state, packet, save):
    session = Session.from_state(state)
    labels = session.check_context(state)
    publisher = session.publisher(state)
    expected = packet["pr"]
    label = publisher._existing_review_label(packet)
    current = publisher._get_pr(expected["number"])
    if state["status"] == "tracking_pending":
        delivery.require(current["draft"] is False, "PR returned to draft after the ready readback")
    if not current["draft"]:
        delivery.require(state["status"] in {"manual_ready_pending", "tracking_pending"},
                         "PR was marked ready before trusted verification authorized it")
    if label in labels:
        delivery.require(state["status"] == "tracking_pending" and not current["draft"],
                         "tracking label was applied before the tracking handoff")

    def approved_readback():
        session.check_context(state)
        pr = session.exact_pr(publisher, expected, draft=current["draft"])
        publisher._approval(packet, "plan_approval")
        publisher._approval(packet)
        return session.exact_pr(publisher, pr, draft=pr["draft"])

    pr = approved_readback()
    ci = publisher.verify_local_revision(packet, pr, session.verifier, session.digest)
    if ci["status"] != "success":
        status = "pre_ready_ci_blocked" if ci["status"] == "blocked" else "pre_ready_ci_waiting"
    else:
        pr = approved_readback()
        labels = session.check_context(state)
        if pr["draft"]:
            delivery.require(label not in labels, "tracking label was applied before the PR was ready")
            status = "manual_ready_pending"
        elif label in labels and state["status"] == "tracking_pending":
            status = "review_ready"
        else:
            delivery.require(label not in labels, "tracking label was applied before the tracking handoff")
            status = "tracking_pending"
    result = {"status": status, "pr": pr, "ci": ci, "issue": {"number": state["issue"], "labels": labels}}
    state["status"] = status
    state["publication"]["progress"] = result
    if status == "review_ready":
        state["publication"]["final"] = result
    save(state)
    return state
