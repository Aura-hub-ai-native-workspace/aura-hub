"""AURA Hub canonical Python backend.

Migration constitution: docs/migration/ (FROZEN). This package conforms to
those contracts; it never reinterprets them. Layering: api -> domain ->
fabric -> policy/approvals/audit/persistence; contracts is importable by all.
"""

__version__ = "0.1.0"
