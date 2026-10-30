"""Usage ledger for paid grants. Spend is reserved before a call and settled after.

Every paid call goes through three steps:

  1. reserve(): in one IMMEDIATE transaction, check that the grant's spend
     (settled plus still-reserved) plus this estimate stays within the cap, then
     record the reservation. Two concurrent callers cannot both pass the check
     because SQLite serialises writers on the database file.
  2. settle(): record what the call actually cost, if the provider reported its
     usage and a price was declared. Otherwise the reserved estimate stays on
     the books and is labelled as an estimate, never as measured spend.
  3. release(): for a call that failed. If the failure is known not to bill
     (for example a connection refused before any request was sent), the
     reservation is freed. If not, it is kept at the estimate. Silence is never
     treated as "not billed".

The ledger never invents a price. A caller without a declared price cannot
reserve at all.

Limitations, stated in the data: only the caller can report usage. A provider
that does not report usage leaves the estimate as the recorded amount. A
usage report that arrives twice is counted once, keyed by provider event id.
"""

from __future__ import annotations

import math
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


class SpendCapExceeded(RuntimeError):
    """A reservation would take the grant past its cap. Nothing was recorded."""


class DuplicateUsage(RuntimeError):
    """The provider event id was already counted against another reservation."""


class LedgerError(RuntimeError):
    """A reservation or settlement was invalid. Nothing was changed."""


BASIS_ESTIMATE = "estimate-unverified"        # no usage report; estimate kept
BASIS_PROVIDER = "provider-reported"          # usage reported and priced by declared price
BASIS_NOT_BILLED = "released-not-billed"      # failed before billing, freed
BASIS_FAILED_UNKNOWN = "failed-billing-unknown"  # failed, billing unknown; estimate kept

_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
    reservation_id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
    reserved REAL NOT NULL CHECK (reserved >= 0),
    charged REAL CHECK (charged IS NULL OR charged >= 0),
    basis TEXT,
    provider_event_id TEXT UNIQUE,
    created REAL NOT NULL,
    updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_grant ON usage (endpoint_id, model_name);
"""


def estimate_cost(price_per_1k_tokens: float, max_output_tokens: int) -> float:
    """Worst-case cost of one call, from a declared price and the output ceiling."""
    if not (isinstance(price_per_1k_tokens, (int, float))
            and math.isfinite(price_per_1k_tokens) and price_per_1k_tokens > 0):
        raise LedgerError("a finite, positive declared price is required")
    if not (isinstance(max_output_tokens, int) and max_output_tokens > 0):
        raise LedgerError("max_output_tokens must be a positive integer")
    return round(price_per_1k_tokens * max_output_tokens / 1000.0, 9)


class UsageLedger:
    """SQLite-backed ledger. Each call opens its own connection, so threads are safe."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=30.0, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    # ── reservation ─────────────────────────────────────────────────────

    def reserve(self, endpoint_id: str, model_name: str, cap: float, estimate: float) -> str:
        """Record a reservation if the grant has room for ``estimate``. Returns its id."""
        if not (math.isfinite(cap) and cap > 0):
            raise LedgerError("cap must be a finite, positive number")
        if not (math.isfinite(estimate) and estimate > 0):
            raise LedgerError("estimate must be a finite, positive number")
        reservation_id = uuid.uuid4().hex
        now = time.time()
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            spent = self._spent_in(conn, endpoint_id, model_name)
            if spent + estimate > cap + 1e-12:
                conn.execute("ROLLBACK")
                raise SpendCapExceeded(
                    f"grant {endpoint_id!r}/{model_name!r}: spent {spent:.6f} + "
                    f"estimate {estimate:.6f} exceeds cap {cap:.6f}")
            conn.execute(
                "INSERT INTO usage (reservation_id, endpoint_id, model_name, state, reserved, "
                "created, updated) VALUES (?, ?, ?, 'reserved', ?, ?, ?)",
                (reservation_id, endpoint_id, model_name, estimate, now, now))
            conn.execute("COMMIT")
        except SpendCapExceeded:
            raise
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
        return reservation_id

    # ── settlement ──────────────────────────────────────────────────────

    def settle(self, reservation_id: str, *, output_tokens: int | None = None,
               price_per_1k_tokens: float | None = None,
               provider_event_id: str | None = None,
               expect_grant: tuple[str, str] | None = None) -> str:
        """Record the final amount. Returns the basis it was recorded under.

        Provider usage is used only when both the token count and the declared price
        are present. A repeated settle with the same arguments changes nothing.
        """
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT state, reserved, charged, basis, provider_event_id, endpoint_id, "
                "model_name FROM usage WHERE reservation_id = ?",
                (reservation_id,)).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                raise LedgerError(f"unknown reservation {reservation_id!r}")
            state, reserved, charged, basis, existing_event, r_endpoint, r_model = row
            if expect_grant is not None and (r_endpoint, r_model) != tuple(expect_grant):
                conn.execute("ROLLBACK")
                raise LedgerError(
                    f"reservation {reservation_id!r} belongs to grant "
                    f"{r_endpoint!r}/{r_model!r}, not {expect_grant[0]!r}/{expect_grant[1]!r}")

            if output_tokens is not None and price_per_1k_tokens is not None:
                if isinstance(output_tokens, bool) or not isinstance(output_tokens, int) \
                        or output_tokens < 0:
                    conn.execute("ROLLBACK")
                    raise LedgerError("output_tokens must be a non-negative integer")
                if not (math.isfinite(price_per_1k_tokens) and price_per_1k_tokens > 0):
                    conn.execute("ROLLBACK")
                    raise LedgerError("price_per_1k_tokens must be finite and positive")
                new_charge = round(price_per_1k_tokens * output_tokens / 1000.0, 9)
                new_basis = BASIS_PROVIDER
            else:
                new_charge = reserved
                new_basis = BASIS_ESTIMATE

            if state == "settled":
                if charged == new_charge and basis == new_basis and \
                        (provider_event_id is None or provider_event_id == existing_event):
                    conn.execute("COMMIT")
                    return basis           # the same settlement repeated: no double count
                conn.execute("ROLLBACK")
                raise LedgerError(f"reservation {reservation_id!r} is already settled differently")
            if state == "released":
                conn.execute("ROLLBACK")
                raise LedgerError(f"reservation {reservation_id!r} was released")

            if provider_event_id is not None:
                clash = conn.execute(
                    "SELECT reservation_id FROM usage WHERE provider_event_id = ?",
                    (provider_event_id,)).fetchone()
                if clash is not None:
                    conn.execute("ROLLBACK")
                    raise DuplicateUsage(
                        f"provider event {provider_event_id!r} is already counted")

            conn.execute(
                "UPDATE usage SET state = 'settled', charged = ?, basis = ?, "
                "provider_event_id = ?, updated = ? WHERE reservation_id = ?",
                (new_charge, new_basis, provider_event_id, time.time(), reservation_id))
            conn.execute("COMMIT")
            return new_basis
        except (LedgerError, DuplicateUsage):
            raise
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def release(self, reservation_id: str, *, not_billed: bool) -> str:
        """Settle a failed call. Only a failure known to be unbilled frees the reservation."""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT state, reserved FROM usage WHERE reservation_id = ?",
                               (reservation_id,)).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                raise LedgerError(f"unknown reservation {reservation_id!r}")
            state, reserved = row
            if state != "reserved":
                conn.execute("ROLLBACK")
                raise LedgerError(f"reservation {reservation_id!r} is already {state}")
            if not_billed:
                conn.execute("UPDATE usage SET state='released', charged=0, basis=?, "
                             "updated=? WHERE reservation_id=?",
                             (BASIS_NOT_BILLED, time.time(), reservation_id))
                basis = BASIS_NOT_BILLED
            else:
                conn.execute("UPDATE usage SET state='settled', charged=reserved, basis=?, "
                             "updated=? WHERE reservation_id=?",
                             (BASIS_FAILED_UNKNOWN, time.time(), reservation_id))
                basis = BASIS_FAILED_UNKNOWN
            conn.execute("COMMIT")
            return basis
        except LedgerError:
            raise
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # ── reading ─────────────────────────────────────────────────────────

    @staticmethod
    def _spent_in(conn: sqlite3.Connection, endpoint_id: str, model_name: str) -> float:
        row = conn.execute(
            "SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN charged "
            "WHEN state = 'reserved' THEN reserved ELSE 0 END), 0) FROM usage "
            "WHERE endpoint_id = ? AND model_name = ?", (endpoint_id, model_name)).fetchone()
        return float(row[0])

    def spent(self, endpoint_id: str, model_name: str) -> float:
        """Settled spend plus outstanding reservations. The figure used for caps."""
        conn = self._connect()
        try:
            return self._spent_in(conn, endpoint_id, model_name)
        finally:
            conn.close()

    def stale_reservations(self, older_than_seconds: float) -> list[dict]:
        """Reservations still open after ``older_than_seconds``.

        A process that dies mid-call leaves its reservation open. That keeps the
        spend counted, which is the safe direction. This report lets an operator
        see them. It never releases one, because only the original caller can
        establish whether the call was billed.
        """
        if not (math.isfinite(older_than_seconds) and older_than_seconds >= 0):
            raise LedgerError("older_than_seconds must be a finite, non-negative number")
        cutoff = time.time() - older_than_seconds
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT reservation_id, endpoint_id, model_name, reserved, created FROM usage "
                "WHERE state = 'reserved' AND created <= ? ORDER BY created", (cutoff,)).fetchall()
        finally:
            conn.close()
        return [{"reservationId": r, "endpointId": e, "modelName": m,
                 "reserved": round(v, 9), "createdAt": c}
                for r, e, m, v, c in rows]

    def report(self, endpoint_id: str, model_name: str) -> dict:
        """Per-grant accounting, with every basis shown so estimates are never mistaken for usage."""
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT state, basis, COUNT(*), COALESCE(SUM(reserved),0), "
                "COALESCE(SUM(charged),0) FROM usage WHERE endpoint_id=? AND model_name=? "
                "GROUP BY state, basis", (endpoint_id, model_name)).fetchall()
        finally:
            conn.close()
        return {
            "endpointId": endpoint_id,
            "modelName": model_name,
            "spent": self.spent(endpoint_id, model_name),
            "breakdown": [
                {"state": s, "basis": b, "count": n,
                 "reservedTotal": round(r, 9), "chargedTotal": round(c, 9)}
                for s, b, n, r, c in rows],
        }


def spent_for_grants(ledger: UsageLedger, grants) -> dict[tuple[str, str], float]:
    """``spent_by_grant`` for the candidate filter: one entry per grant, exact identity.

    Each figure is settled spend plus outstanding reservations, so a reservation
    still in flight counts against the cap. Grants with no usage map to 0.0.
    """
    spent: dict[tuple[str, str], float] = {}
    for grant in grants:
        key = (grant.endpoint_id, grant.model_name)
        spent[key] = ledger.spent(grant.endpoint_id, grant.model_name)
    return spent


@dataclass(frozen=True)
class SpendRead:
    """One read-only snapshot of spend for a set of grants. Used only by observational views."""
    spent: dict            # (endpoint_id, model_name) -> spend, same basis as UsageLedger.spent
    observed_at: float     # wall-clock time of the read
    status: str            # "ok" | "ledger-absent" (no file; nothing was created)


def read_spent_bounded(path, grants, *, busy_timeout_ms: int = 500,
                       clock=time.time) -> SpendRead:
    """Spend for each grant, read without writing and without waiting long.

    Opens the database read-only. It never creates the database file and never changes
    a row or a reservation. Limitation, measured rather than assumed: the ledger uses WAL
    mode, and a read-only open of a WAL database whose connections are all closed creates
    the ``-wal`` and ``-shm`` sidecar files. A live writer already has them, so nothing new
    appears in that case. Avoiding the sidecars would mean rollback-journal mode, which
    lets readers and writers block each other, or ``immutable=1``, which is unsafe while a
    writer is active. Neither is made here.

    It gives up after ``busy_timeout_ms``. All grants are read in one statement, so the
    figures come from one consistent view. Raises LedgerBusy when the database stays
    locked, and LedgerUnavailable for any other read failure.
    """
    target = Path(path)
    keys = [(g.endpoint_id, g.model_name) for g in grants]
    if not target.exists():
        return SpendRead(spent={k: 0.0 for k in keys}, observed_at=clock(),
                         status="ledger-absent")
    uri = f"{target.resolve().as_uri()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=busy_timeout_ms / 1000.0,
                               isolation_level=None)
    except sqlite3.Error as exc:
        raise LedgerUnavailable(type(exc).__name__) from None
    try:
        conn.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
        conn.execute("BEGIN")                  # one read transaction for every grant
        rows = conn.execute(
            "SELECT endpoint_id, model_name, COALESCE(SUM(CASE WHEN state = 'settled' "
            "THEN charged WHEN state = 'reserved' THEN reserved ELSE 0 END), 0) "
            "FROM usage GROUP BY endpoint_id, model_name").fetchall()
        conn.execute("COMMIT")
        observed = clock()
    except sqlite3.OperationalError as exc:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise LedgerBusy("ledger busy") from None
        raise LedgerUnavailable(type(exc).__name__) from None
    except sqlite3.Error as exc:
        raise LedgerUnavailable(type(exc).__name__) from None
    finally:
        conn.close()
    table = {(e, m): float(v) for e, m, v in rows}
    return SpendRead(spent={k: table.get(k, 0.0) for k in keys}, observed_at=observed,
                     status="ok")


class LedgerBusy(RuntimeError):
    """The ledger stayed locked past the read's time bound."""


class LedgerUnavailable(RuntimeError):
    """The ledger could not be read. The message is a type name only, never a path."""
