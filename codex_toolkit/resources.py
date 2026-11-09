"""Stable paths to the delivery resources bundled in the installed wheel."""

from __future__ import annotations

from pathlib import Path


_PACKAGE_ROOT = Path(__file__).resolve().parent


def delivery_runtime() -> Path:
    return _PACKAGE_ROOT / "_delivery_runtime"


def skills_root() -> Path:
    return _PACKAGE_ROOT / "_resources" / "skills"
