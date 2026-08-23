"""Mutation testing of the Context Fabric differential harness.

A harness that agrees with the reference proves nothing until it is shown
to DISAGREE when the implementation is wrong. Each mutation below is a
plausible porting mistake — an inverted precedence, a dropped guard, a
different slice, a number formatted the Python way. Every one must make
`parity.context_parity` fail.

A mutation that survives is a hole in the harness, and is reported as
one.

The source file is restored after each mutation, including on failure.

Usage (from backend/):  uv run python -m verify.context_mutations
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "aura_backend"

# Which verifier is expected to catch a given mutation. The
# fixture-driven differential composes with NO fabric attached, so a
# mutation in the capability projection can only be seen by the runtime
# differential, where two real fabrics answer.
PARITY = "parity.context_parity"
RUNTIME = "verify.context_runtime"

# (name, file, find, replace, what a survivor would mean, verifier)
MUTATIONS: list[tuple[str, str, str, str, str, str]] = [
    (
        "freshness precedence: fresh wins over stale",
        "context/compose.py",
        '    if "stale" in grades:\n        return "stale"\n    if "fresh" in grades:\n        return "fresh"',
        '    if "fresh" in grades:\n        return "fresh"\n    if "stale" in grades:\n        return "stale"',
        "a view with a stale artifact could report itself fresh",
        PARITY,
    ),
    (
        "staleness ignores the filesystem, only the clock",
        "intelligence/staleness.py",
        "        if mtime_ms(project_root) > generated:\n            return True",
        "        if False:\n            return True",
        "an artifact would stay 'fresh' after the repository changed",
        PARITY,
    ),
    (
        "identity graded by timestamp instead of fingerprint",
        "context/compose.py",
        "    identity_stale = identity_needs_regeneration(home, project_id, root) if identity else False",
        "    identity_stale = False",
        "a changed project fingerprint would not be reported",
        PARITY,
    ),
    (
        "newest artifact timestamp taken as the oldest",
        "context/compose.py",
        "    newest = timestamps[-1] if timestamps else None",
        "    newest = timestamps[0] if timestamps else None",
        "the section's provenance would name the wrong artifact",
        PARITY,
    ),
    (
        "empty sections rendered instead of omitted",
        "context/contract.py",
        "    if not lines:\n        return None",
        "    if not lines:\n        lines = []",
        "'computed and empty' would be indistinguishable from 'has content'",
        PARITY,
    ),
    (
        "unknown sections omitted instead of rendered",
        "context/contract.py",
        '    if s.freshness == "unknown" or s.value is None:',
        "    if False:",
        "'nobody looked' would read as 'there is nothing'",
        PARITY,
    ),
    (
        "stale label dropped from the section header",
        "context/contract.py",
        '    return f"<{tag}>{_stale_note(reason)}" if freshness == "stale" else f"<{tag}>"',
        '    return f"<{tag}>"',
        "an agent could read past a stale section without seeing it",
        PARITY,
    ),
    (
        "truncation no longer says how much was dropped",
        "context/contract.py",
        '    return head + (f", +{len(items) - maximum} more" if len(items) > maximum else "")',
        "    return head",
        "a truncated list would look complete",
        PARITY,
    ),
    (
        "every surface shows non-drivable capabilities",
        "context/contract.py",
        "        if budget.all_capabilities and blocked:",
        "        if blocked:",
        "the per-surface capability budget would not be enforced",
        RUNTIME,
    ),
    (
        "change attribution by bare prefix, without the separator",
        "context/compose.py",
        '        if e["file"] == root or e["file"].startswith(root + os.sep)',
        '        if e["file"].startswith(root)',
        "a sibling directory's history would be claimed by this project",
        PARITY,
    ),
    (
        "unattributable changes reported as empty rather than unknown",
        "context/compose.py",
        "    if entries and not attributable:",
        "    if False:",
        "another project's silence would read as this project's calm",
        PARITY,
    ),
    (
        "provided capabilities forwarded in the caller's order",
        "context/compose.py",
        '            "providedCapabilities": sorted(snapshot.provided_capabilities),',
        '            "providedCapabilities": list(snapshot.provided_capabilities),',
        "the environment section would not be deterministic",
        PARITY,
    ),
    (
        "AURA's own subsystems listed as installed programs",
        "context/contract.py",
        '        installed = [t for t in e["tools"] if not t["internal"]]',
        '        installed = [t for t in e["tools"] if True]',
        "an agent could read 'Mission Control' as a binary to run",
        PARITY,
    ),
    (
        "module list not reduced to the orientation slice",
        "context/compose.py",
        "        for m in ((summary or {}).get(\"modules\") or [])[:24]",
        "        for m in ((summary or {}).get(\"modules\") or [])",
        "the view would carry hundreds of modules instead of a shape",
        PARITY,
    ),
    (
        "completed tasks counted from proposals too",
        "context/compose.py",
        '    return len([t for t in tasks if t.get("status") in ("accepted", "done")])',
        '    return len(tasks)',
        "a mission that has done nothing would report full progress",
        PARITY,
    ),
    (
        "numbers formatted the Python way",
        "core/js_number.py",
        "        if value.is_integer() and abs(value) < 1e21:\n            return str(int(value))",
        "        if False:\n            return str(int(value))",
        "contracts and fingerprints would differ by a '.0'",
        PARITY,
    ),
    (
        "mtime taken as ns/1e6 rather than Node's arithmetic",
        "core/node_time.py",
        "    return (nanoseconds // _NS_PER_S) * 1000 + (nanoseconds % _NS_PER_S) / 1e6",
        "    return nanoseconds / 1e6",
        "identity fingerprints would differ by one unit in the last place",
        PARITY,
    ),
    (
        "constraints omit the uncommitted-work warning",
        "context/compose.py",
        '    if git and git.get("dirty"):',
        "    if False:",
        "an agent would not be told there is unpushed work to protect",
        PARITY,
    ),
    (
        "explicit null generatedAt dropped from the wire",
        "context/types.py",
        '        payload = {\n            "value": self.value,\n            "freshness": self.freshness,\n            "generatedAt": self.generated_at,\n        }',
        '        payload = {\n            "value": self.value,\n            "freshness": self.freshness,\n        }\n        if self.generated_at is not None:\n            payload["generatedAt"] = self.generated_at',
        "the response shape would differ from the reference's",
        PARITY,
    ),
]


def _run(module: str = PARITY) -> bool:
    """True when the named verifier passes."""
    proc = subprocess.run(
        [sys.executable, "-m", module],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True, text=True, timeout=1800, check=False,
    )
    return proc.returncode == 0


def main() -> int:
    survivors: list[tuple[str, str]] = []

    for module in sorted({m[5] for m in MUTATIONS}):
        print(f"baseline {module}: ", end="", flush=True)
        if not _run(module):
            print("FAILED — it does not pass unmutated; stopping")
            return 1
        print("passes")

    for name, rel, find, replace, meaning, module in MUTATIONS:
        file = SRC / rel
        original = file.read_text()
        if find not in original:
            print(f"SKIP  {name} — the mutation target moved; update this suite")
            survivors.append((name, "target not found"))
            continue
        file.write_text(original.replace(find, replace, 1))
        try:
            caught = not _run(module)
        finally:
            file.write_text(original)
        print(f"{'CAUGHT' if caught else 'SURVIVED'}  {name}"
              f"{'' if module == PARITY else '  [runtime]'}")
        if not caught:
            survivors.append((name, meaning))

    print(f"\n{len(MUTATIONS) - len(survivors)}/{len(MUTATIONS)} mutations caught")
    if survivors:
        print("\nSURVIVORS — the harness cannot see these:")
        for name, meaning in survivors:
            print(f"  · {name}\n      {meaning}")
        return 1
    print("\nRESULT: the harness detects every seeded regression")
    return 0


if __name__ == "__main__":
    sys.exit(main())
