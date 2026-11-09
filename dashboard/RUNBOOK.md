# Needs attention M1 runbook

This slice is a read-only dashboard for one configured private repository and one App-mode Delivery run. The Delivery runner remains the verdict oracle. The dashboard does not resume Delivery, submit GitHub reviews, rerun CI, or hold the publisher App private key.

## Boundaries

- Run the dashboard on the existing `kaspars-ubuntu` loopback Compose network and publish it only through the existing Cloudflare Tunnel at `https://ct.kaspars.cc`.
- Configure the GitHub OAuth App callback exactly as `https://ct.kaspars.cc/auth/github/callback`.
- Give the OAuth App access only to the configured private repository. The server passes the configured numeric `repository_id` during exchange and proves the signed-in human and repository access on every data/action read.
- Put the OAuth client secret in an owner-only regular file (`0600`) and pass its path with `--client-secret-file`. Do not put it in Compose YAML, environment variables, logs, or the projection.
- Keep the projection and invalidation directory owner controlled (`0700` directory, `0600` files). Mount only that directory into the dashboard container. Do not mount the Delivery state directory, App key, publisher root, or host worktree.

## Continuously project and transport during the trial

Start the exporter on the runner host from the Toolkit checkout. Create the remote inbox as an owner-only directory before starting the exporter.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m dashboard.export_snapshot \
  --state-dir "$DELIVERY_STATE_DIR" \
  --repo "$DELIVERY_REPO" \
  --delivery-id "$DELIVERY_ID" \
  --host kaspars-ubuntu \
  --inbox "$DASHBOARD_INBOX"
```

Run the exporter under the operator's supervisor during the trial. It sends a fresh snapshot over SSH every 10 seconds. Each SSH attempt times out after 10 seconds. A failed projection or transfer leaves the last complete snapshot in place and retries after 10 seconds. The snapshot expires after 30 seconds, at which point the dashboard suspends review controls. The browser rechecks every 15 seconds while visible, and review actions always trigger a fresh server-side GitHub read.

## Start the loopback service

From the deployed source directory inside the existing Compose service/container, bind on the private Compose bridge and do not publish the dashboard container port:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m dashboard.server \
  --bind 0.0.0.0 \
  --port 8787 \
  --origin https://ct.kaspars.cc \
  --client-id "$GITHUB_OAUTH_CLIENT_ID" \
  --client-secret-file /run/secrets/codex-toolkit-github-oauth \
  --snapshot /var/lib/codex-toolkit-dashboard/projection.json \
  --invalidations /var/lib/codex-toolkit-dashboard/invalidations.json \
  --repo "$DELIVERY_REPO" \
  --delivery-id "$DELIVERY_ID"
```

Configure the existing Caddy container on that private bridge with `reverse_proxy dashboard:8787`. Only the Caddy origin publishes `127.0.0.1:18672` for the existing Cloudflare Tunnel. Use `--bind 127.0.0.1` only for direct host networking or a shared network namespace.

The service has a fixed GitHub API origin, GET-only allowlist, opaque secure `HttpOnly` `SameSite=Lax` sessions, one-time session-bound OAuth state and PKCE, private/no-store responses, and restrictive browser headers. Access tokens stay in server memory and are never returned to JavaScript. A signed-in viewer without repository access receives `403` with no private item data. A viewer who needs to sign in receives `401`. Pending sign-ins expire after five minutes and new sign-ins receive `429` when the session store reaches capacity.

## Review and resume

The maintainer opens the exact plan commit and verified pinned Markdown, then uses **Copy approval text** and submits that exact line in a GitHub **Comment** review. Toolkit stays paused until the operator uses the existing host command unchanged:

```sh
python3 workflows/github-delivery/delivery.py resume \
  --state-dir "$DELIVERY_STATE_DIR" \
  --repo "$DELIVERY_REPO" \
  --delivery-id "$DELIVERY_ID" \
  --skills-root "$DELIVERY_SKILLS_ROOT"
```

The continuously running transport publishes the next saved runner snapshot. Refreshing the dashboard then shows the saved receipt and confirmed next stage. The dashboard never implies that a GitHub review alone resumed the runner.

## Synthetic fixture and checks

Fixture inputs and authentication are separate from production and bind only to loopback:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m dashboard.fixture_server --mode actionable --port 8877
```

Modes are `actionable`, `stale`, `unavailable`, and `advanced`. Open `http://127.0.0.1:8877/items/fixture-run` in a real browser. These modes prove rendering and fallback behavior only; they are not live GitHub or deployment evidence.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s dashboard/tests
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s workflows/github-delivery/tests
node --check dashboard/static/app.js
git diff --check
```

VAL-07–09 remain deployment gates: they require the deployed service, disposable private runs, eligible/ineligible/no-access accounts, real GitHub reads, and the operator's actual resume command. Never substitute fixture credentials or fixture screenshots for those checks.
