"""Connect the trusted App and policy readers to discovery, preview and start."""

from contextlib import contextmanager
import json
import os
import subprocess
from urllib.parse import quote

import delivery
import effective_policy
import preview
from discovery import AppDiscovery, OperatorAppProfile


PREVIEW_PERMISSIONS = {
    "contents": "read", "issues": "read", "metadata": "read", "pull_requests": "read",
}


def rest_reader(request, paginate):
    def read(endpoint, *, paginated=False, missing=False):
        try:
            return paginate("/" + endpoint) if paginated else request("/" + endpoint)
        except delivery.DeliveryError as exc:
            if missing and getattr(exc.__cause__, "code", None) == 404:
                return None
            raise
    return read


def app_reader(client, repo):
    return rest_reader(lambda path: client.api("GET", repo, path),
                       lambda path: client.paginated(repo, path))


@contextmanager
def installed_reader(profile, name):
    discovery = AppDiscovery(profile)
    session = discovery.mint_repository(name, PREVIEW_PERMISSIONS)
    try:
        yield session.repository, rest_reader(
            lambda path: discovery.api.request("GET", path, token=session.token),
            lambda path: discovery.api.paginated(path, token=session.token),
        )
    finally:
        session.revoke(discovery.api)


def resolve(profile, repo, branch, sha, reader):
    return effective_policy.resolve_at(
        profile, default_branch=branch, base_sha=sha,
        read=lambda endpoint, **kw: reader(f"repos/{repo}{endpoint}", **kw),
    )["values"]


def branch_rules(repo, branch, owned, reader):
    api = f"repos/{repo}"
    base = reader(f"{api}/branches/{quote(branch, safe='')}")
    delivery.require(type(base.get("protected")) is bool, "default branch protection is unreadable")
    restrictions = {}
    unavailable = set()
    for ref in (branch, owned):
        try:
            rules = preview.listing(f"{api}/rules/branches/{quote(ref, safe='')}", reader=reader)
        except delivery.DeliveryError as exc:
            # GitHub explicitly reports that rulesets do not exist as a feature
            # on private personal Free repositories. Any other 403 blocks.
            error = exc.__cause__
            detail = {}
            if getattr(error, "code", None) == 403:
                try:
                    detail = json.loads(error.read(8192))
                except (ValueError, OSError):
                    pass
            if (not isinstance(detail, dict) or detail.get("message") !=
                    "Upgrade to GitHub Pro or make this repository public to enable this feature."
                    or base["protected"] is not False):
                raise delivery.DeliveryError(f"effective branch rules unavailable for {ref}: {exc}") from exc
            repository = reader(api)
            delivery.require(repository.get("private") is True and repository.get("owner", {}).get("type") == "User",
                             "unavailable branch rules are only supported for unprotected private personal repositories")
            unavailable.add(ref)
            rules = []
        delivery.require(all(isinstance(row.get("type"), str) for row in rules),
                         f"branch rules are unreadable for {ref}")
        restrictions[ref] = sorted({row["type"] for row in rules})
    # This publisher only supports an ordinary direct push of unsigned commits
    # to the owned branch. It never tries to use bypass privileges.
    incompatible = {"creation", "update", "pull_request", "required_signatures",
                    "required_status_checks", "workflows", "required_deployments",
                    "merge_queue", "code_scanning", "file_path_restriction",
                    "max_file_path_length", "file_extension_restriction", "max_file_size",
                    "commit_message_pattern", "commit_author_email_pattern",
                    "committer_email_pattern", "branch_name_pattern", "copilot_code_review",
                    "required_code_quality"}
    delivery.require(not incompatible.intersection(restrictions[owned]),
                     f"owned branch has rules requiring an unsupported publication path: {restrictions[owned]}")
    return {"base_protected": base["protected"], "effective_rules": restrictions,
            "rulesets_unavailable_on_private_personal_plan": sorted(unavailable)}


def reviewer_check(policy, reader, *, publisher_id=None):
    ids = set()
    for stage in ("plan", "implementation"):
        gate = policy["approvals"][stage]
        delivery.require(1 <= gate["minimum"] <= len(gate["reviewer_ids"]),
                         f"missing {stage} human reviewers")
        ids.update(gate["reviewer_ids"])
    delivery.require(publisher_id not in ids, "publisher cannot review a delivery")
    reviewers = [reader(f"user/{reviewer}") for reviewer in sorted(ids)]
    delivery.require(all(user.get("id") == reviewer and user.get("type") == "User"
                         for reviewer, user in zip(sorted(ids), reviewers)),
                     "configured reviewer is not a human account")
    return [{"id": user["id"], "login": user.get("login"), "type": "User"} for user in reviewers]


def installed_preview(repository, profile, defaults):
    with installed_reader(profile, repository) as (selected, reader):
        def policy_at(repo, branch, sha):
            delivery.require(branch == selected.default_branch, "discovered default branch changed")
            return resolve(defaults, repo, branch, sha, reader)

        def readiness(repo, branch, sha, policy):
            blockers = []
            def check(operation):
                try:
                    return operation()
                except (delivery.DeliveryError, OSError, KeyError, ValueError,
                        TypeError, subprocess.TimeoutExpired) as exc:
                    blockers.append(str(exc))
                    return None

            blockers.extend(effective_policy.summary(policy)["publication_blockers"])
            if not blockers:
                check(lambda: reviewer_check(policy, reader, publisher_id=profile.bot_user_id))
            if policy["delivery"].get("publisher_id") not in (None, profile.bot_user_id):
                blockers.append("operator policy publisher differs from the verified App bot")
            label = policy["tracking"]["review_label"]
            check(lambda: delivery.require(
                reader(f"repos/{repo}/labels/{quote(label, safe='')}").get("name") == label,
                "configured tracking label is missing"))
            publication = profile.publication
            if publication is None:
                blockers.append("operator App publication settings are missing")
            elif not publication.get("allowed_path_prefixes"):
                blockers.append("operator candidate path allowlist is missing")
            if publication and not policy["delivery"].get("require_github_actions", True):
                local = publication.get("local_verifier")
                if local is None:
                    blockers.append("operator local verifier is missing")
                else:
                    check(lambda: verify_local_readiness(repo, sha, local, reader))
            elif publication and not publication.get("ci"):
                blockers.append("operator trusted Actions verifier is missing")
            elif publication:
                blockers.append("trusted Actions verification must be checked with the publication binding")
            return {"status": "blocked" if blockers else "start_checks_required",
                    "blockers": blockers,
                    "remaining_start_checks": ["candidate branch rules", "agent isolation",
                                               "candidate paths and exact-revision verification"]}

        result = preview.run(selected.full_name, reader=reader, resolve=policy_at,
                             readiness=readiness)
        delivery.require(result.get("repository_id", selected.repository_id) == selected.repository_id,
                         "preview repository ID differs from the discovered binding")
        result["app"] = {"app_id": profile.app_id, "bot_user_id": profile.bot_user_id,
                         "installation_id": selected.installation_id,
                         "account_id": selected.account_id, "permissions": PREVIEW_PERMISSIONS}
        return result


def verify_local_readiness(repo, sha, local, reader):
    import local_verifier
    from publisher import verify_audited_workflows

    delivery.require(isinstance(local, dict), "protected App binding is missing a local verifier")
    image, _ = local_verifier._profile({"image": local["image"], "argv": local["argv"]})
    verify_audited_workflows(repo, sha, local["audited_workflows"], reader)
    env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    runtime = local_verifier._runtime(env)
    inspect = subprocess.run([str(runtime), "image", "inspect", image, "--format",
                              "{{json .RepoDigests}}"], env=env, capture_output=True, text=True,
                             check=False, timeout=30)
    delivery.require(inspect.returncode == 0, "trusted local verifier image is unavailable")
    digests = json.loads(inspect.stdout)
    delivery.require(isinstance(digests, list) and image in digests,
                     "local verifier image digest is unverified")
