"""Continuously publish one expiring dashboard projection over operator SSH."""

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time

from dashboard.projection import ProjectionError, build_projection
import delivery

# Publish only after the full SSH payload is received. A byte count guards
# against committing a partial file if the connection closes during transfer.
REMOTE_PUBLISH = """set -eu
umask 077
tmp=$(mktemp "$1/.projection.XXXXXX")
trap 'unlink "$tmp" 2>/dev/null || true' EXIT
cat > "$tmp"
test "$(wc -c < "$tmp")" -eq "$2"
mv -f "$tmp" "$1/projection.json"
"""


def publish(args: argparse.Namespace) -> None:
    snapshot = build_projection(args.state_dir, args.repo, args.delivery_id)
    payload = (json.dumps(snapshot, separators=(",", ":")) + "\n").encode()
    command = shlex.join(["sh", "-c", REMOTE_PUBLISH, "publish", str(args.inbox), str(len(payload))])
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", args.host, command],
        input=payload, check=True, timeout=10, stdout=subprocess.DEVNULL,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--delivery-id", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--inbox", type=Path, required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if not args.inbox.is_absolute():
        parser.error("--inbox must be an absolute path to an existing private directory")
    delivery.validate_repo(args.repo)
    delivery.validate_delivery_id(args.delivery_id)

    failed = False
    while True:
        try:
            publish(args)
        except (ProjectionError, delivery.DeliveryError, OSError, ValueError, KeyError, TypeError,
                subprocess.SubprocessError):
            if not failed:
                print("Dashboard snapshot unavailable. Retrying in 10 seconds.", file=sys.stderr, flush=True)
            if args.once:
                return 1
            failed = True
        else:
            if failed:
                print("Dashboard snapshot publishing recovered.", file=sys.stderr, flush=True)
            if args.once:
                return 0
            failed = False
        time.sleep(10)


if __name__ == "__main__":
    raise SystemExit(main())
