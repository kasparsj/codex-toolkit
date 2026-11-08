#!/usr/bin/env python3
"""Reproducible no-network-write end-to-end pinned runner smoke."""

import datetime as dt
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = Path(__file__).resolve().parents[1]


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
        agent.write_text("""#!/usr/bin/env python3
import json,sys
p=json.load(sys.stdin); k=p['kind']; repo=p['repo']; did=p['delivery_id']; issue=p['issue']
if k=='plan': r={'artifact_paths':['docs/plan.md'],'artifact_hashes':{'docs/plan.md':'a'*64},'plan_revision':'b'*40,'issue':issue,'baseline':{'repo':repo,'ref':'main','sha':'c'*40}}
elif k=='implement': r={'candidate_sha':'d'*40,'artifact_paths':['src/change.py'],'verification':['tests ok'],'issue':issue,'base':{'repo':repo,'ref':'main','sha':'c'*40}}
else: r={'status':'READY','head_sha':'d'*40,'base_sha':'c'*40,'checks':['success']}
print(json.dumps({'schema_version':1,'kind':k,'delivery_id':did,'repo':repo,'result':r}))
"""); agent.chmod(0o700)
        publisher = root / "publisher.py"
        publisher.write_text("""#!/usr/bin/env python3
import json,sys
from pathlib import Path
p=json.load(sys.stdin); a=p['action']
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
            "--skills-root", str(ROOT / "skills"), "--agent-launcher", str(agent),
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
            "--repo", "github.test/acme/widget", "--delivery-id", "pinned-e2e", "--skills-root", str(ROOT / "skills")]
        completed = subprocess.run(resume, text=True, capture_output=True)
        if completed.returncode:
            sys.stderr.write(completed.stderr + completed.stdout); return completed.returncode
        result = json.loads(completed.stdout); assert result["runner"]["status"] == "paused", result
        assert result["runner"]["current_step_id"] == "plan-review", result
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
        assert result["publication"]["final"]["pr"]["draft"] is False
        print(json.dumps({"runner": result["runner"]["status"], "delivery": result["status"]}, sort_keys=True))
        return 0


if __name__ == "__main__": raise SystemExit(main())
