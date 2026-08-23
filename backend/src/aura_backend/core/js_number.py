"""One definition of how a number becomes text and JSON.

JavaScript has a single numeric type. `JSON.stringify(41)` is `41` and
there is no way for it to emit `41.0`; `String(1/3*3)` is `1`, not `1.0`.
Python distinguishes `int` from `float`, so the same logical value
round-trips differently:

    json.dumps(41.0)   →  "41.0"      JSON.stringify(41)   →  "41"
    f"{41.0}"          →  "41.0"      `${41}`              →  "41"

That difference is not cosmetic in two places:

* **Fingerprints.** A file mtime is stringified into an identity or
  profile fingerprint which is then compared for **equality**. A
  fingerprint written by one backend must read as unchanged under the
  other, or every artifact is regenerated on every switch.

* **The wire.** A response body is a contract. `41.0` where the
  reference sends `41` is a different document, even though a JavaScript
  client parses both to the same number.

So numbers leaving this backend — into a fingerprint, a rendered
contract, or an HTTP body — go through here.
"""

from __future__ import annotations

import math
import re
from typing import Any

_EXPONENT = re.compile(r"e([+-])0*(\d)")


def js_number(value: Any) -> str:
    """Format a number as JavaScript's string conversion would."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        # Python's `repr` is already the shortest round-tripping form, as
        # JavaScript's is; only the exponent is spelled differently
        # (`1e-07` here, `1e-7` there).
        return _EXPONENT.sub(r"e\1\2", repr(value))
    return str(value)


def to_js_numbers(payload: Any) -> Any:
    """Rewrite whole-valued floats as ints, throughout a JSON payload.

    `json.dumps` then emits what `JSON.stringify` would. Bools are left
    alone — they are `int` subclasses and are not numbers here.
    """
    if isinstance(payload, bool):
        return payload
    if isinstance(payload, float):
        if math.isfinite(payload) and payload.is_integer() and abs(payload) < 1e21:
            return int(payload)
        return payload
    if isinstance(payload, dict):
        return {k: to_js_numbers(v) for k, v in payload.items()}
    if isinstance(payload, (list, tuple)):
        return [to_js_numbers(v) for v in payload]
    return payload
