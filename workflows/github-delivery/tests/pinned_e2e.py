#!/usr/bin/env python3
"""Reproducible no-network-write end-to-end pinned runner smoke."""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = Path(os.environ.get(
    "CODEX_TOOLKIT_DELIVERY_RUNTIME", Path(__file__).resolve().parents[1]
)).resolve()
SKILLS = Path(os.environ.get("CODEX_TOOLKIT_SKILLS_ROOT", ROOT / "skills")).resolve()


def main() -> int:
    with tempfile.TemporaryDirectory() as name:
        root = Path(name); policy = root / "delivery.toml"
        policy.write_text("""version = 1
[delivery]
final_target = "main"
publisher_id = 900
policy_max_age_seconds = 3600
[eligibility]
required_labels = []
excluded_labels = []
[branches]
default_parent = "main"
allowed_parent_prefixes = ["main"]
plan_template = "codex/plan-{issue}"
implementation_template = "codex/issue-{issue}"
[tracking]
review_label = "status: review"
[approvals.plan]
minimum = 1
reviewer_ids = [101]
[approvals.implementation]
minimum = 1
reviewer_ids = [101]
""")
        agent = root / "agent.py"
        agent.write_text(f"#!{sys.executable}\n" + """
import json,sys
p=json.load(sys.stdin); k=p['kind']; repo=p['repo']; did=p['delivery_id']; issue=p['issue']
if k=='plan': r={'artifact_paths':['docs/plan.md'],'artifact_hashes':{'docs/plan.md':'a'*64},'plan_revision':'b'*40,'issue':issue,'baseline':{'repo':repo,'ref':'main','sha':'c'*40}}
elif k=='implement': r={'candidate_sha':'d'*40,'artifact_paths':['src/change.py'],'verification':['tests ok'],'issue':issue,'base':{'repo':repo,'ref':'main','sha':'c'*40}}
else: r={'status':'WAITING','delivery_status':'READY','head_sha':'d'*40,'base_sha':'c'*40,'checks':['success']}
print(json.dumps({'schema_version':1,'kind':k,'delivery_id':did,'repo':repo,'result':r}))
"""); agent.chmod(0o700)
        publisher = root / "publisher.py"
        publisher.write_text(f"#!{sys.executable}\n" + """
import json,sys
from pathlib import Path
p=json.load(sys.stdin); a=p['action']
with Path(__file__).with_suffix('.log').open('a') as log: log.write(json.dumps(p,sort_keys=True)+'\\n')
marker=Path(__file__).with_suffix('.once')
if a=='publish_plan' and not marker.exists(): marker.write_text('accepted-unknown'); raise SystemExit(3)
if a.startswith('publish_'):
 e=p['expected']; out={'schema_version':1,'action':a,'pr':{'number':1 if a=='publish_plan' else 2,'repo':e['repo'],'head':e['head'],'head_sha':e['head_sha'],'base':e['base'],'base_sha':e['base_sha'],'draft':True,'state':'OPEN'}}
elif a=='list_reviews':
 pr=p['pr']; body=f"delivery-review {p['stage']} {p['generation']} {p['context_digest']} approve"
 out={'schema_version':1,'action':a,'paginated':True,'pr':pr,'reviews':[{'id':1,'user':{'id':101},'state':'COMMENTED','dismissed':False,'commit_id':pr['head_sha'],'body':body,'submitted_at':'2026-01-01T00:00:00Z'}]}
else:
 pr=dict(p['pr']); pr['draft']=False
 out={'schema_version':1,'action':a,'pr':pr,'issue':{'number':p['issue'],'labels':[p['existing_review_label']]}}
print(json.dumps(out))
"""); publisher.chmod(0o700)
        digest = hashlib.sha256(policy.read_bytes()).hexdigest()
        argv = [sys.executable, str(WORKFLOW / "delivery.py"), "start", "--state-dir", str(root / "state"),
            "--repo", "github.test/acme/widget", "--issue", "42", "--delivery-id", "pinned-e2e",
            "--policy", str(policy), "--policy-ref", "refs/remotes/origin/main", "--policy-sha", "a" * 40,
            "--policy-digest", digest, "--policy-fetched-at", dt.datetime.now(dt.timezone.utc).isoformat(),
            "--skills-root", str(SKILLS), "--agent-launcher", str(agent),
            "--publisher-launcher", str(publisher), "--worktree", str(root),
            "--agent-scratch", str(root / "agent-scratch")]
        completed = subprocess.run(argv, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout)
        assert result["runner"]["status"] == "failed", result
        assert result["runner"]["current_step_id"] == "publish-plan", result
        assert result["runner"]["run_id"], result
        resume = [sys.executable, str(WORKFLOW / "delivery.py"), "resume", "--state-dir", str(root / "state"),
            "--repo", "github.test/acme/widget", "--delivery-id", "pinned-e2e", "--skills-root", str(SKILLS)]
        completed = subprocess.run(resume, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout); assert result["runner"]["status"] == "paused", result
        assert result["runner"]["current_step_id"] == "plan-review", result
        first_plan_run_id = result["runner_run_id"]
        first_plan_pr = result["publication"]["plan"]["pr"]
        correction = root / "plan-correction.json"
        correction.write_text(json.dumps({"schema_version": 1, "kind": "plan",
            "delivery_id": "pinned-e2e", "repo": "github.test/acme/widget",
            "result": {"artifact_paths": ["docs/plan.md"],
                "artifact_hashes": {"docs/plan.md": "f" * 64}, "plan_revision": "e" * 40,
                "issue": 42, "baseline": {"repo": "github.test/acme/widget",
                    "ref": "main", "sha": "c" * 40}}}))
        completed = subprocess.run(resume + ["--result", str(correction)], text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout); assert result["runner"]["status"] == "paused", result
        assert result["runner"]["current_step_id"] == "plan-review", result
        assert result["runner_run_id"] != first_plan_run_id, result
        assert result["manifests"]["plan"]["generation"] == 2, result
        assert result["publication"]["plan"]["pr"]["number"] == first_plan_pr["number"], result
        assert result["publication"]["plan"]["pr"]["head_sha"] == "e" * 40, result
        packets = [json.loads(line) for line in publisher.with_suffix('.log').read_text().splitlines()]
        correction_packet = [packet for packet in packets if packet["action"] == "publish_plan"][-1]
        assert correction_packet["supersedes_pr"]["number"] == first_plan_pr["number"], correction_packet
        assert correction_packet["expected"]["generation"] == 2, correction_packet
        assert correction_packet["expected"]["head_sha"] == "e" * 40, correction_packet
        completed = subprocess.run(resume, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout); assert result["runner"]["status"] == "paused", result
        assert result["runner"]["current_step_id"] == "implementation-review", result
        stranded_run_id = result["runner_run_id"]
        state_path, = (root / "state" / "repos").glob("*/deliveries/pinned-e2e/state.json")
        state = json.loads(state_path.read_text())
        state["runner_status"] = "running"
        state["runner_pid"] = None
        state_path.write_text(json.dumps(state))
        recover = resume.copy()
        recover[2] = "recover"
        completed = subprocess.run(recover, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout)
        assert result["runner_run_id"] != stranded_run_id, result
        assert result["runner"]["status"] == "paused", result
        assert result["runner"]["current_step_id"] == "implementation-review", result
        completed = subprocess.run(resume, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout); assert result["runner"]["status"] == "completed", result
        assert result["status"] == "review_ready", result
        assert result["merge_readiness"] == "WAITING", result
        assert result["manifests"]["closeout"]["value"]["result"]["delivery_status"] == "READY", result
        assert result["publication"]["final"]["pr"]["draft"] is False
        active_path, = (root / "state" / "repos").glob("*/active.json")
        assert json.loads(active_path.read_text())["status"] == "released"
        claim = json.loads(active_path.read_text())
        claim["status"] = "active"
        active_path.write_text(json.dumps(claim))
        terminal_state = {**result, "runner_status": "running", "runner_pid": None}
        state_path.write_text(json.dumps(terminal_state))
        publication_log = publisher.with_suffix(".log").read_bytes()
        completed = subprocess.run(recover, text=True, capture_output=True, check=True)
        assert json.loads(completed.stdout)["status"] == "review_ready"
        assert json.loads(active_path.read_text())["status"] == "released"
        assert publisher.with_suffix(".log").read_bytes() == publication_log

        rank_log = root / "rank.log"
        ranker = root / "ranker.py"
        ranker.write_text(f"#!{sys.executable}\n" + """
import json,sys
from pathlib import Path
p=json.load(sys.stdin)
with Path(sys.argv[0]).with_name('rank.log').open('a') as log: log.write(p['kind']+'\\n')
r={'no_candidate':True,'shortlist':[]}
print(json.dumps({'schema_version':1,'kind':p['kind'],'delivery_id':p['delivery_id'],'repo':p['repo'],'result':r}))
"""); ranker.chmod(0o700)
        no_candidate = [sys.executable, str(WORKFLOW / "delivery.py"), "start",
            "--state-dir", str(root / "empty-state"), "--repo", "github.test/acme/empty",
            "--delivery-id", "pinned-empty", "--policy", str(policy),
            "--policy-ref", "refs/remotes/origin/main", "--policy-sha", "a" * 40,
            "--policy-digest", digest, "--policy-fetched-at", dt.datetime.now(dt.timezone.utc).isoformat(),
            "--skills-root", str(SKILLS), "--agent-launcher", str(ranker),
            "--publisher-launcher", "/usr/bin/false", "--worktree", str(root),
            "--agent-scratch", str(root / "empty-agent-scratch"), "--no-dispatch"]
        invalid_ref = no_candidate.copy()
        invalid_ref[invalid_ref.index("--policy-ref") + 1] = "main"
        rejected = subprocess.run(invalid_ref, text=True, capture_output=True)
        assert rejected.returncode == 2 and "policy ref must be" in rejected.stdout
        assert not list((root / "empty-state").glob("repos/*/active.json"))
        completed = subprocess.run(no_candidate, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        empty = json.loads(completed.stdout)
        assert empty["runner_status"] == "idle", empty
        assert not rank_log.exists()
        resume_empty = [sys.executable, str(WORKFLOW / "delivery.py"), "resume",
            "--state-dir", str(root / "empty-state"), "--repo", "github.test/acme/empty",
            "--delivery-id", "pinned-empty", "--skills-root", str(SKILLS)]
        empty_active, = (root / "empty-state" / "repos").glob("*/active.json")
        own_claim = json.loads(empty_active.read_text())
        replacement = {**own_claim, "delivery_id": "replacement"}
        empty_active.write_text(json.dumps(replacement))
        rejected = subprocess.run(resume_empty, text=True, capture_output=True)
        assert rejected.returncode == 2 and "current active delivery claim" in rejected.stdout
        assert json.loads(empty_active.read_text()) == replacement
        assert not rank_log.exists()
        empty_active.write_text(json.dumps(own_claim))
        completed = subprocess.run(resume_empty, text=True, capture_output=True, check=True)
        empty = json.loads(completed.stdout)
        assert empty["runner"]["status"] == "completed", empty
        assert empty["status"] == "completed", empty
        assert rank_log.read_text().splitlines() == ["rank"]
        assert json.loads(empty_active.read_text())["status"] == "released"
        empty_state, = (root / "empty-state" / "repos").glob("*/deliveries/pinned-empty/state.json")
        interrupted = json.loads(empty_state.read_text())
        interrupted_run_id = interrupted["runner_run_id"]
        interrupted["runner_status"] = "running"
        interrupted["runner_pid"] = None
        empty_state.write_text(json.dumps(interrupted))
        claim = json.loads(empty_active.read_text())
        claim["status"] = "active"  # Interrupt after saving terminal state, before releasing the claim.
        empty_active.write_text(json.dumps(claim))
        recover_empty = resume_empty.copy()
        recover_empty[2] = "recover"
        completed = subprocess.run(recover_empty, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        empty = json.loads(completed.stdout)
        assert empty["runner"]["status"] == "completed", empty
        assert empty["runner_run_id"] != interrupted_run_id, empty
        assert rank_log.read_text().splitlines() == ["rank"]
        assert json.loads(empty_active.read_text())["status"] == "released"
        newer_claim = {**claim, "delivery_id": "new-delivery"}
        empty_active.write_text(json.dumps(newer_claim))
        interrupted["runner_run_id"] = empty["runner_run_id"]
        empty_state.write_text(json.dumps(interrupted))
        completed = subprocess.run(recover_empty, text=True, capture_output=True, check=True)
        assert json.loads(completed.stdout)["runner"]["status"] == "completed"
        assert json.loads(empty_active.read_text()) == newer_claim
        print(json.dumps({"runner": result["runner"]["status"], "delivery": result["status"]}, sort_keys=True))
        return 0


if __name__ == "__main__": raise SystemExit(main())
