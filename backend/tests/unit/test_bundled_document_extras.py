"""The packaged application ships the document libraries (F-28).

The bundle build reads `[project.optional-dependencies]` from pyproject.toml
and installs the extras named in BUNDLED_EXTRAS beside the backend's own
dependencies. These tests keep the three pieces in step: the extras must keep
declaring the libraries the document features import, and the build script must
keep installing those extras, so removing either side cannot quietly ship an
application whose DOCX/XLSX/PDF features fail with "not installed".
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PYPROJECT = REPO / "backend" / "pyproject.toml"
BUILD = REPO / "scripts" / "build-service-bundle.mjs"
VERIFY = REPO / "scripts" / "packaging-verify.mjs"


def _names(requirements):
    return {re.split(r"[<>=!~\[ ;]", r, maxsplit=1)[0].lower().replace("_", "-") for r in requirements}


def _extras():
    return tomllib.loads(PYPROJECT.read_text())["project"]["optional-dependencies"]


def test_the_extras_declare_every_library_the_document_features_import():
    extras = _extras()
    assert {"pypdf", "python-docx", "pillow"} <= _names(extras["multimodal"])
    assert {"python-docx", "openpyxl", "reportlab"} <= _names(extras["artifacts"])


def test_the_heavy_docling_stack_is_not_one_of_the_bundled_extras():
    script = BUILD.read_text()
    declared = re.search(r"const BUNDLED_EXTRAS = \[([^\]]*)\]", script)
    assert declared, "the build script must declare BUNDLED_EXTRAS"
    bundled = set(re.findall(r"'([^']+)'", declared.group(1)))
    assert bundled == {"multimodal", "artifacts"}
    assert "docling" in _extras() and "docling" not in bundled


def test_the_build_installs_the_bundled_extras_in_the_same_pip_run_as_the_backend():
    script = BUILD.read_text()
    assert "BUNDLED_EXTRAS.flatMap(extraRequirements)" in script
    install = re.search(r"pip\(\['install'[^;]*?\.\.\.backendRequirements\(\), \.\.\.documentRequirements\]\)", script, re.S)
    assert install, "documentRequirements must be passed to the same pip install as backendRequirements()"


def test_the_extras_are_read_from_pyproject_not_retyped_in_the_build():
    script = BUILD.read_text()
    assert "backend/pyproject.toml" in script
    assert not re.search(r"'(python-docx|openpyxl|reportlab|pypdf)[<>=]", script), \
        "the versions must come from pyproject.toml, not a second copy in the build script"


def test_the_packaging_verifier_checks_the_libraries_are_present_and_work():
    verify = VERIFY.read_text()
    assert "1m. the document libraries" in verify and "1n. the packaged interpreter alone writes and reads DOCX, XLSX and PDF" in verify
    for library in ("docx", "openpyxl", "reportlab", "pypdf", "PIL", "lxml"):
        assert f"'{library}'" in verify
