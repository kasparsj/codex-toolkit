#!/usr/bin/env python3
"""Verify that built artifacts preserve the canonical delivery resources."""

from __future__ import annotations

import argparse
from pathlib import Path
import tarfile
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
PINNED_SKILLS = ("next-issue", "plan-pr", "implement-plan", "pr-closeout")


def canonical_resources() -> tuple[dict[str, bytes], dict[str, bytes]]:
    wheel_files: dict[str, bytes] = {}
    sdist_files: dict[str, bytes] = {}
    workflow_root = ROOT / "workflows" / "github-delivery"

    sources = sorted(workflow_root.glob("*.py"))
    sources.extend(
        (workflow_root / "workflow.yaml", workflow_root / "fixtures" / "delivery-fixture.yml")
    )
    for source in sources:
        relative = source.relative_to(workflow_root).as_posix()
        wheel_files[f"codex_toolkit/_delivery_runtime/{relative}"] = source.read_bytes()
        sdist_files[source.relative_to(ROOT).as_posix()] = source.read_bytes()

    for skill_name in PINNED_SKILLS:
        skill_root = ROOT / "skills" / skill_name
        for source in sorted(path for path in skill_root.rglob("*") if path.is_file()):
            relative = source.relative_to(ROOT / "skills").as_posix()
            wheel_files[f"codex_toolkit/_resources/skills/{relative}"] = source.read_bytes()
            sdist_files[source.relative_to(ROOT).as_posix()] = source.read_bytes()
    return wheel_files, sdist_files


def verify_wheel(path: Path, expected: dict[str, bytes]) -> None:
    with ZipFile(path) as archive:
        names = set(archive.namelist())
        bundled = {
            name
            for name in names
            if name.startswith("codex_toolkit/_delivery_runtime/")
            or name.startswith("codex_toolkit/_resources/skills/")
        }
        if bundled != set(expected):
            missing = sorted(set(expected) - bundled)
            extra = sorted(bundled - set(expected))
            raise SystemExit(f"{path}: resource inventory mismatch; missing={missing}, extra={extra}")
        changed = sorted(name for name, content in expected.items() if archive.read(name) != content)
        if changed:
            raise SystemExit(f"{path}: resource bytes changed: {changed}")


def verify_sdist(path: Path, expected: dict[str, bytes]) -> None:
    with tarfile.open(path) as archive:
        names = set(archive.getnames())
        roots = {
            name.split("/", 1)[0]
            for name in names
            if name.endswith("/pyproject.toml") and name.count("/") == 1
        }
        if len(roots) != 1:
            raise SystemExit(f"{path}: cannot identify one source distribution root")
        prefix = roots.pop() + "/"
        missing = sorted(name for name in expected if prefix + name not in names)
        if missing:
            raise SystemExit(f"{path}: canonical inputs missing: {missing}")
        changed = []
        for name, content in expected.items():
            member = archive.extractfile(prefix + name)
            if member is None or member.read() != content:
                changed.append(name)
        if changed:
            raise SystemExit(f"{path}: canonical input bytes changed: {changed}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel", type=Path, action="append", required=True)
    parser.add_argument("--sdist", type=Path)
    args = parser.parse_args()

    wheel_files, sdist_files = canonical_resources()
    for wheel in args.wheel:
        verify_wheel(wheel, wheel_files)
    if args.sdist is not None:
        verify_sdist(args.sdist, sdist_files)
    print(
        f"verified {len(wheel_files)} resources in {len(args.wheel)} wheel(s)"
        + (" and the source distribution" if args.sdist is not None else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
