"""Validate, look up, and render draft-only Improve findings."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import unicodedata
from urllib.parse import quote

from improve_read import resolve, search, verify_sources

MAX_BATCH = 128 * 1024
SAFE_ID = re.compile(r"F[1-9][0-9]?")
SENSITIVE = re.compile(
    r"https?\s*:|\bwww\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|"
    r"\b(?:gh[pousr]_|github_pat_|sk_live_|xox[baprs]-|AKIA[A-Z0-9]{16})|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S",
    re.IGNORECASE,
)


class Invalid(ValueError):
    pass


def require(condition):
    if not condition:
        raise Invalid("invalid_or_unsafe_input")


def fields(value, *names):
    require(type(value) is dict and value.keys() == set(names))
    return value


def unique_pairs(pairs):
    result = dict(pairs)
    require(len(result) == len(pairs))
    return result


def parse(data):
    require(len(data) <= MAX_BATCH)
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_pairs)


def digest(value):
    data = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode("ascii")).hexdigest()


def text(value, max_bytes=2048):
    require(type(value) is str and value and value == value.strip())
    require(all(c == "\n" or unicodedata.category(c)[0] != "C" for c in value))
    require(len(value.encode("utf-8")) <= max_bytes and not SENSITIVE.search(value))
    return value


def integer(value, minimum, maximum):
    require(type(value) is int and minimum <= value <= maximum)


def items(value, minimum, maximum):
    require(type(value) is list and minimum <= len(value) <= maximum)
    return value


def plain(value):
    return re.sub(r"([\\`*_{}\[\]()<>#+.!|~@&:-])", r"\\\1", value).replace("\n", " ")


def binding_fields(binding):
    fields(binding, "repo", "id", "visibility", "ref", "sha")
    require(type(binding["repo"]) is str and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", binding["repo"]
    ) and binding["repo"].split("/")[1] not in {".", ".."})
    integer(binding["id"], 1, 2**63 - 1)
    require(binding["visibility"] in ("public", "private", "internal"))
    require(type(binding["ref"]) is str and 0 < len(binding["ref"]) <= 255)
    require(type(binding["sha"]) is str and re.fullmatch(r"[0-9a-f]{40}", binding["sha"]))


def candidate_fields(candidate):
    c = fields(candidate, "id", "title", "behavior", "observed", "scope", "non_goals",
               "proof", "impact", "effort", "sources", "acceptance", "terms")
    require(type(c["id"]) is str and SAFE_ID.fullmatch(c["id"]))
    title = text(c["title"])
    require(len(title) <= 120 and "\n" not in title and not re.search(r"[@<>]|#\d", title))
    for name in ("observed", "scope", "non_goals"):
        text(c[name])
    for value in fields(c["behavior"], "actor", "trigger", "boundary", "expected").values():
        text(value)
    proof = fields(c["proof"], "kind", "detail")
    require(proof["kind"] in ("trace", "reproduced"))
    text(proof["detail"])
    integer(c["impact"], 2, 3)
    integer(c["effort"], 1, 2)
    for source in items(c["sources"], 1, 5):
        fields(source, "path", "start", "end")
        path = text(source["path"], 512)
        require(re.fullmatch(r"[\w./ @+-]+", path) and
                all(part not in ("", ".", "..", ".git") for part in path.split("/")))
        integer(source["start"], 1, 1_000_000)
        integer(source["end"], source["start"], 1_000_000)
    for criterion in items(c["acceptance"], 1, 5):
        for value in fields(criterion, "action", "expected").values():
            text(value)
    for term in items(c["terms"], 1, 3):
        require(re.fullmatch(r"[\w .-]+", text(term, 160)) and re.search(r"\w", term))
    require(len(set(c["terms"])) == len(c["terms"]))
    return c


def normalize(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def finding_key(binding, candidate):
    return digest([1, binding["id"], {k: normalize(v) for k, v in candidate["behavior"].items()}])


def review(executable, phase, binding, key, candidate, evidence):
    if not executable:
        raise Invalid("reviewer_unavailable")
    packet = {
        "phase": phase,
        "nonce": secrets.token_hex(16),
        "binding": binding,
        "key": key,
        "terms_digest": digest(candidate["terms"]),
        "evidence": evidence,
    }
    packet["digest"] = digest(packet)
    encoded = json.dumps(packet).encode("utf-8")
    if phase == "overlap" and len(encoded) > 96 * 1024:
        raise Invalid("overlap_packet_exceeds_review_bound")
    # The executable is trusted operator configuration. No repository cwd or token is inherited.
    with tempfile.TemporaryDirectory(prefix="improve-review-") as scratch, tempfile.TemporaryFile() as output:
        try:
            subprocess.run(
                executable, input=encoded, stdout=output,
                stderr=subprocess.DEVNULL, cwd=scratch, env={"PATH": os.defpath, "HOME": scratch},
                timeout=60, check=True,
            )
            output.seek(0)
            response = parse(output.read(8193))
            require(output.tell() <= 8192)
            names = ["digest", "disposition", "related", "reason"]
            if type(response) is dict:
                names.extend(name for name in ("related_candidate", "continuation") if name in response)
            fields(response, *names)
            require(response["digest"] == packet["digest"])
            allowed = ("clear", "defer", "covered", "duplicate", "fixed") if phase == "overlap" else ("clear", "defer")
            require(response["disposition"] in allowed)
            for number in items(response["related"], 0, 5):
                integer(number, 1, 2**31 - 1)
            require(len(set(response["related"])) == len(response["related"]))
            require(phase == "overlap" or not response["related"])
            if "related_candidate" in response:
                require(phase == "overlap" and response["disposition"] == "duplicate"
                        and not response["related"] and type(response["related_candidate"]) is str
                        and SAFE_ID.fullmatch(response["related_candidate"]))
            if "continuation" in response:
                require(phase == "overlap" and response["disposition"] == "clear")
                text(response["continuation"], 1024)
            text(response["reason"], 512)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise Invalid("review_unavailable_or_invalid") from error
    return response


def record_url(binding, record):
    route = "pull" if record["kind"] == "pr" else "issues"
    return f"https://github.com/{binding['repo']}/{route}/{record['number']}"


def render(binding, candidate, related):
    c = candidate
    b = c["behavior"]
    root = f"https://github.com/{binding['repo']}"
    lines = [
        "## Current behavior", "",
        f"- Affected actor: {plain(b['actor'])}",
        f"- Trigger: {plain(b['trigger'])}",
        f"- Affected surface: {plain(b['boundary'])}",
        f"- Observed: {plain(c['observed'])}", "",
        "## Expected outcome", "", plain(b["expected"]), "",
        "## Scope", "", plain(c["scope"]), "",
        f"Out of scope: {plain(c['non_goals'])}", "",
        "## Evidence", "", f"Inspected commit: `{binding['sha']}`", "",
    ]
    for source in c["sources"]:
        path = quote(source["path"], safe="/")
        link = f"{root}/blob/{binding['sha']}/{path}#L{source['start']}-L{source['end']}"
        lines.append(f"- [Pinned source lines]({link})")
    lines.extend(["", plain(c["proof"]["detail"]), "", "## Existing work and remaining gap", ""])
    if related:
        for record in related:
            number = record["number"]
            lines.append(f"- [Related {record['kind']} {number}]({record_url(binding, record)})")
        lines.append(f"- Remaining scope: {plain(c['scope'])}")
    else:
        lines.append("The bounded issue and pull request search found no equivalent work.")
    lines.extend(["", "## Acceptance criteria", ""])
    for check in c["acceptance"]:
        lines.append(f"- [ ] {plain(check['action'])} → {plain(check['expected'])}")
    body = "\n".join(lines) + "\n"
    require(len(body.encode("utf-8")) <= 12 * 1024)
    return {"title": c["title"], "body": body}


# Leave room for the digest, binding, and sequence metadata in the review envelope.
OVERLAP_BYTES = 88 * 1024
MAX_OVERLAP_PACKETS = 24
TEXT_FRAGMENT = 4096


def redact(value):
    if isinstance(value, str):
        return "\n".join("[restricted line]" if SENSITIVE.search(line) else line
                         for line in value.split("\n"))
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def json_size(value):
    return len(json.dumps(value))


def text_fragments(value):
    # A scalar can take up to 12 characters in ensure_ascii JSON.
    for offset in range(0, len(value), TEXT_FRAGMENT):
        yield {"offset": offset, "text": value[offset:offset + TEXT_FRAGMENT]}


def record_parts(record, budget):
    if json_size(record) <= budget:
        yield record
        return

    metadata = {key: value for key, value in record.items() if key not in ("body", "files")}
    body = record.get("body") or ""
    files = record.get("files", [])
    # Repeat identity and revision metadata so each partial record is reviewable.
    for part in text_fragments(body):
        yield {**metadata, "body": part["text"], "body_offset": part["offset"], "partial": True}
    for file in files:
        part = {**metadata, "files": [file], "partial": True}
        if json_size(part) <= budget:
            yield part
            continue
        patch = file.get("patch") or ""
        if not patch:
            raise Invalid("overlap_record_exceeds_review_bound")
        for fragment in text_fragments(patch):
            yield {**metadata, "files": [{**file, "patch": fragment["text"],
                                         "patch_offset": fragment["offset"]}], "partial": True}
    if not body and not files:
        raise Invalid("overlap_record_exceeds_review_bound")


def overlap_packets(evidence):
    screened = redact(evidence)
    records = screened.pop("records")
    base = {**screened, "records": []}
    budget = OVERLAP_BYTES - json_size(base)
    if budget <= 0:
        raise Invalid("overlap_context_exceeds_review_bound")

    packets, current, used = [], [], 0
    for record in records:
        for part in record_parts(record, budget):
            cost = json_size(part) + 2  # Reserve the JSON list separator.
            if cost > budget:
                raise Invalid("overlap_record_exceeds_review_bound")
            if used + cost > budget:
                packets.append(current)
                if len(packets) >= MAX_OVERLAP_PACKETS:
                    raise Invalid("overlap_packet_limit_exceeded")
                current, used = [], 0
            current.append(part)
            used += cost
    packets.append(current)
    snapshot = digest({**base, "records": records})
    for index, parts in enumerate(packets, 1):
        yield {**base, "records": parts, "packet": {
            "index": index, "total": len(packets), "snapshot": snapshot,
        }}


def assess_overlap(executable, binding, key, candidate, evidence):
    related, seen = set(), set()
    continuation = None
    for packet in overlap_packets(evidence):
        if continuation is not None:
            packet["packet"]["previous_summary"] = continuation
        assessment = review(executable, "overlap", binding, key, candidate, packet)
        seen.update(record["number"] for record in packet["records"])
        require(all(number in seen for number in assessment["related"]))
        if assessment["disposition"] != "clear":
            # A deferred or covered candidate will never reach drafting.
            return assessment
        related.update(assessment["related"])
        continuation = assessment.get("continuation")
        if packet["packet"]["index"] < packet["packet"]["total"] and continuation is None:
            raise Invalid("overlap_continuation_missing")
    if len(related) > 5:
        raise Invalid("overlap_references_exceed_review_bound")
    return {"disposition": "clear", "related": sorted(related)}


def batch(args):
    if args.reviewer:
        reviewer = Path(args.reviewer).resolve()
        require(not reviewer.is_relative_to(args.checkout.resolve()))
        args.reviewer = [str(reviewer)]
    if args.operator_review:
        args.reviewer = [sys.executable, "-I", str(Path(__file__).with_name("operator_review.py"))]
    with open(args.input, "rb") as stream:
        envelope = parse(stream.read(MAX_BATCH + 1))
    fields(envelope, "version", "binding", "scope", "audit_complete", "candidates")
    integer(envelope["version"], 1, 1)
    binding = envelope["binding"]
    binding_fields(binding)
    scope = text(envelope["scope"])
    require(type(envelope["audit_complete"]) is bool)
    require(resolve(binding["repo"], binding["ref"], args.fixture_url) == binding)
    verify_sources(binding, args.checkout, [])
    candidates, outcomes, drafts, accepted = [], {}, [], []
    ids = set()
    for raw in items(envelope["candidates"], 0, 10):
        require(type(raw) is dict and type(raw.get("id")) is str and SAFE_ID.fullmatch(raw["id"]))
        identity = raw["id"]
        require(identity not in ids)
        ids.add(identity)
        try:
            c = candidate_fields(raw)
            candidates.append((finding_key(binding, c), c))
        except Invalid:
            outcomes[identity] = {"id": identity, "status": "deferred", "reason": "invalid_or_unsafe_input"}
    candidates.sort(key=lambda pair: (
        -pair[1]["impact"] / pair[1]["effort"], pair[1]["proof"]["kind"] != "reproduced",
        pair[0], pair[1]["id"],
    ))
    keys = {}
    for key, c in candidates:
        identity = c["id"]
        outcome = outcomes[identity] = {"id": identity, "key": key, "status": "deferred"}
        try:
            if key in keys:
                outcome.update(status="duplicate", reason="same_outcome_in_batch", related_candidate=keys[key])
                continue
            sources = verify_sources(binding, args.checkout, c["sources"])
            audience = review(args.reviewer, "search", binding, key, c, c["terms"])
            if audience["disposition"] != "clear":
                outcome["review_note"] = audience["reason"]
                raise Invalid("search_audience_deferred")
            lookup = search(binding, c["terms"], args.fixture_url)
            if lookup["binding"] != binding or not lookup["complete"]:
                outcome["coverage_note"] = text(
                    lookup.get("reason", "Repository binding or search coverage could not be verified."), 512
                )
                raise Invalid("search_incomplete")
            records = lookup["records"]
            base_payload = render(binding, c, [])
            by_number = {record["number"]: record for record in records}
            exact = next((r for r in records if r["kind"] == "issue" and r["state"] == "open"
                          and r["title"] == base_payload["title"]
                          and r["body"] == base_payload["body"]), None)
            if exact:
                outcome.update(status="duplicate", related=[exact["number"]],
                               references=[record_url(binding, exact)], reason="exact_open_issue_payload")
                keys[key] = identity
                continue
            evidence = {
                "candidate": {k: c[k] for k in ("behavior", "observed", "scope", "proof")},
                "records": records,
                "pinned_sources": sources,
                "accepted": accepted,
            }
            assessment = assess_overlap(args.reviewer, binding, key, c, evidence)
            disposition = assessment["disposition"]
            numbers = assessment["related"]
            require(all(n in by_number for n in numbers))
            if disposition == "defer":
                outcome["review_note"] = assessment["reason"]
                raise Invalid("overlap_uncertain")
            if disposition != "clear":
                related_candidate = assessment.get("related_candidate")
                require(numbers or (related_candidate and any(
                    item["id"] == related_candidate for item in accepted
                )))
                if related_candidate:
                    outcome["related_candidate"] = related_candidate
                outcome.update(status=disposition, related=numbers, reason="reviewed_overlap",
                               references=[record_url(binding, by_number[n]) for n in numbers],
                               review_note=assessment["reason"])
                keys[key] = identity
                continue
            payload = render(binding, c, [by_number[n] for n in numbers])
            audience = review(args.reviewer, "draft", binding, key, c, payload)
            if audience["disposition"] != "clear":
                outcome["review_note"] = audience["reason"]
                raise Invalid("draft_audience_deferred")
            keys[key] = identity
            accepted.append({"id": identity, "key": key, "behavior": c["behavior"], "scope": c["scope"]})
            if len(drafts) == args.limit:
                outcome.update(status="over_cap", reason="higher_ranked_drafts_selected")
                continue
            drafts.append({"id": identity, "key": key, **payload})
            outcome.update(status="drafted", impact=c["impact"], effort=c["effort"], related=numbers)
        except Invalid as error:
            outcome["reason"] = str(error)
        except (ValueError, OSError, RuntimeError):
            outcome["reason"] = "evidence_unavailable"
    incomplete = not envelope["audit_complete"] or any(
        item["status"] == "deferred" for item in outcomes.values()
    )
    status = "drafts_ready" if drafts else "incomplete" if incomplete else "no_qualifying_findings"
    return {
        "status": status, "binding": binding, "scope": scope, "audit_complete": not incomplete,
        "draft_limit": args.limit, "candidate_limit": 10, "drafts": drafts,
        "dispositions": [outcomes[identity] for identity in sorted(outcomes)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-url", help="Loopback-only fake GitHub REST server")
    reviewer_options = parser.add_mutually_exclusive_group()
    reviewer_options.add_argument(
        "--reviewer",
        help="Trusted, absolute path to an independent reviewer executable (or IMPROVE_REVIEWER)",
    )
    reviewer_options.add_argument("--operator-review", action="store_true", help="Review each decision in a local terminal")
    commands = parser.add_subparsers(dest="command", required=True)
    bind = commands.add_parser("resolve")
    bind.add_argument("--repo", required=True)
    bind.add_argument("--ref")
    run = commands.add_parser("batch")
    run.add_argument("--checkout", required=True, type=Path)
    run.add_argument("--input", required=True, type=Path)
    run.add_argument("--limit", type=int, choices=range(1, 6), default=3)
    args = parser.parse_args()
    try:
        if args.command == "batch" and not args.operator_review and not args.reviewer:
            args.reviewer = os.environ.get("IMPROVE_REVIEWER")
        if args.reviewer:
            require(Path(args.reviewer).is_absolute())
        result = resolve(args.repo, args.ref, args.fixture_url) if args.command == "resolve" else batch(args)
    except (ValueError, OSError, RuntimeError) as error:
        reason = str(error) if isinstance(error, Invalid) else "repository_or_input_unavailable"
        print(json.dumps({"status": "incomplete", "reason": reason, "drafts": []}))
        return 1
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
