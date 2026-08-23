"""The harness must not be able to hide a behavioral difference.

A parity harness that normalizes too eagerly is worse than no harness:
it reports green while the backends disagree. These tests pin down what
it is allowed to erase.
"""

from __future__ import annotations

from parity.harness import diff, normalize


def test_timestamps_and_ids_are_erased():
    a = {"id": "run_1", "createdAt": "2026-08-23T10:00:00Z", "name": "build"}
    b = {"id": "run_2", "createdAt": "2026-01-01T00:00:00Z", "name": "build"}
    assert diff(normalize(a), normalize(b)) == []


def test_a_missing_field_is_still_a_difference_even_when_nondeterministic():
    a = {"id": "run_1", "name": "build"}
    b = {"name": "build"}
    assert diff(normalize(a), normalize(b)) != []


def test_a_changed_type_of_a_nondeterministic_field_is_a_difference():
    assert diff(normalize({"durationMs": 12}), normalize({"durationMs": "12"})) != []


def test_denial_codes_are_never_normalized():
    a = {"decision": "denied", "rule": "irreversible-floor"}
    b = {"decision": "denied", "rule": "node-not-connected"}
    d = diff(normalize(a), normalize(b))
    assert any("rule" in x for x in d), "a differing denial reason must be reported"


def test_home_paths_are_normalized_but_the_rest_of_the_path_is_not():
    a = {"file": "/home/u/.aura/workflows/w1.json"}
    b = {"file": "/home/u/.aura-py/workflows/w1.json"}
    n = {"home_ts": "/home/u/.aura", "home_py": "/home/u/.aura-py"}
    assert diff(normalize(a, **n), normalize(b, **n)) == []

    c = {"file": "/home/u/.aura-py/workflows/OTHER.json"}
    assert diff(normalize(a, **n), normalize(c, **n)) != []


def test_list_length_difference_is_reported():
    assert diff(normalize({"runs": [1, 2]}), normalize({"runs": [1]})) != []
