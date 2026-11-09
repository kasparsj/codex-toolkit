from __future__ import annotations

import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py


ROOT = Path(__file__).parent
DELIVERY_SOURCE = ROOT / "workflows" / "github-delivery"
SKILLS_SOURCE = ROOT / "skills"
PINNED_SKILLS = ("next-issue", "plan-pr", "implement-plan", "pr-closeout")


class BuildPyWithRuntime(build_py):
    """Stage canonical delivery resources in the private installed package."""

    def run(self) -> None:
        super().run()
        package_root = Path(self.build_lib) / "codex_toolkit"
        runtime_root = package_root / "_delivery_runtime"
        skills_root = package_root / "_resources" / "skills"

        shutil.rmtree(runtime_root, ignore_errors=True)
        runtime_root.mkdir(parents=True)
        for source in sorted(DELIVERY_SOURCE.glob("*.py")):
            shutil.copy2(source, runtime_root / source.name)
        shutil.copy2(DELIVERY_SOURCE / "workflow.yaml", runtime_root / "workflow.yaml")
        fixture_root = runtime_root / "fixtures"
        fixture_root.mkdir()
        shutil.copy2(
            DELIVERY_SOURCE / "fixtures" / "delivery-fixture.yml",
            fixture_root / "delivery-fixture.yml",
        )

        shutil.rmtree(skills_root, ignore_errors=True)
        skills_root.mkdir(parents=True)
        for skill_name in PINNED_SKILLS:
            source = SKILLS_SOURCE / skill_name
            if source.is_symlink() or any(path.is_symlink() for path in source.rglob("*")):
                raise ValueError(f"symlink in pinned skill package: {source}")
            shutil.copytree(source, skills_root / skill_name)


setup(cmdclass={"build_py": BuildPyWithRuntime})
