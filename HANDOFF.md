# Phase 5 — Platform — handoff

Branch `phase5/platform`, based on `origin/main` @ `1212724`.

Status words are used precisely, per the repo's own convention:

- **BUILT** — the code exists and is wired in.
- **BUILT: NOT COMPILED** — written carefully, but the Rust/native
  toolchain it needs was not run here (disk/OS constraints). The exact
  command a human must run is given.
- **RUNTIME VERIFIED** — a verification script exercised it on this
  machine and passed, with a negative control proving the check can fail.
- **NOT VERIFIED (why)** — could not be exercised from this Linux
  machine; the exact command and OS are given.

`npm run typecheck` passes clean at every commit. Verified.

Machine this was built and verified on: **Arch Linux, i3, X11.**
Re-measured, not assumed: X11 session, `xdotool`/`wmctrl`/`xprop`/`bwrap`
present, `ydotool`/`wtype` absent, AT-SPI bus live with 4 apps
publishing trees, `secret-tool` installed but **no Secret Service
running** in this session.

---

## Commits on this branch

```
57d0a7c feat(fabric): make the actuation tier a declared, first-class field
2d91d72 feat(fabric): select the tier once, under policy, and record what ran
ec77c36 feat(environment): discover applications by adapter format, tiers 5 and 6
bfc4994 feat(fabric): govern desktop observation, and prove the ladder holds
18269b9 fix(security): OS keychain for provider keys, and a real KDF behind it
9decb4a test(security): attack a stolen providers.json, for real
5433d31 test(security): prove retrieved content cannot cause an invocation
a6c3681 test(security): prove a tampered journal line is detectable
fd93065 ci(release): OS-level signing pipeline that refuses loudly, never fakes
```

---

## Deliverable 1 — Application discovery, adapter format

**BUILT · RUNTIME VERIFIED (Linux).**

- `packages/connected-environment/src/applications.ts` — applications as
  *data*: per-platform detection (`.desktop` entries, Launch Services
  bundle ids, registry uninstall keys, Start Menu), declared tiers, and
  an `observationSensitivity` (`inventory`/`personal`/`confidential`).
  Ten adapters, each detection source real. Photoshop is discoverable
  with **no rung at all** (AURA ships no UXP plugin) rather than a
  guessed GUI rung.
- `scanApplications()` added to the ONE environment scanner
  (`packages/ai-service/src/environment.ts`) — not a second scanner.
  Sensitivity is assigned at the scanner and reported as the highest it
  *reached* (looking, not finding). Detection never guesses; an
  application absent claims no available tier even where the session
  supports it.
- Governed as `desktop.applications.discover` (manifest), `system.observe`
  scope, `medium` risk (a machine inventory is not a silent read).

Verified by `scripts/desktop-tier-verify.mjs` §6 and the live scan:
`cursor`, `chromium`, `gimp`, `dolphin`, `thunar`, `telegram`,
`tor-browser` found; `vscode`, `xcode`, `photoshop` absent — matching
the machine exactly. macOS/Windows detection paths (Launch Services,
`reg`): **NOT VERIFIED** — no macOS/Windows machine. Run
`node scripts/desktop-tier-verify.mjs` on each.

## Deliverable 2 — The tier ladder, IPC → GUI

**BUILT · RUNTIME VERIFIED (Linux tiers 5 & 6).**

- `packages/connected-environment/src/tiers.ts` — the ladder vocabulary
  (native-api→gui), `selectTier` (highest available wins, never
  substitutes down), per-platform declarations. Lives here so the
  application adapters can declare tiers without depending on the Fabric.
- `packages/capability-fabric/src/tiers.ts` — what a tier COSTS
  (`tierFloor`, `tierRisk`), beside the one policy engine; re-exports the
  ladder so `@aura/capability-fabric` stays a single import.
- Tier is a first-class field on the descriptor, executor result,
  invocation result and **audit record**. Selected once under policy
  (`fabric.ts`), recorded from the executor's own report. No available
  tier → new `not-executed` outcome, `effectStarted: false`, nothing
  substituted.
- `policy.ts`: a tier-6 action is never `auto-execute` — not under a
  fully permissive policy, not for `user-direct` (a click authorises an
  intent; it cannot say which window has focus when the keys land). Tier
  ≥5 raises risk to at least medium.
- Drivers (`packages/ai-service/src/desktop/`): tier 5 (AT-SPI / AX /
  UIAutomation) and tier 6 (X11 EWMH / user32 EnumWindows), **read-only
  observation, no synthetic input**. `session.ts` measures the session
  (X11 vs Wayland vs headless; AT-SPI bus AND whether apps publish trees).

Verified by `scripts/desktop-tier-verify.mjs` — **65 checks, 0 failed**,
every claim paired with a control. Live: AT-SPI returns 4 applications,
`wmctrl` 4 windows, tier 6 executes and records tier 6.

**NOT VERIFIED:** tier 5/6 on macOS and Windows (AX/UIAutomation,
EnumWindows), and tier 6 on Wayland (declared unsupported by design). Run
`node scripts/desktop-tier-verify.mjs` on each OS. Wayland: the driver
declares it unavailable with a reason; that is the intended answer.

### Driver-registry interface assumed (coordinate with Phase 4)

Phase 4 owns the driver registry and tiers 1–4. This phase's tier-5/6
drivers are written against this interface (`desktop/drivers.ts`), which
Phase 4's registry should satisfy so the two drivers register into it
unchanged:

```ts
interface TierDriver {
  readonly id: string;
  readonly tier: ActuationTier;               // from @aura/connected-environment
  readonly platforms: PlatformDeclaration[];
  probe(refresh?: boolean): Promise<TierProbe>;
  observe(): Promise<ObservationResult>;       // read-only in this phase
}
interface TierDriverRegistry {
  register(driver: TierDriver): void;          // one driver per rung; dup throws
  get(tier: ActuationTier): TierDriver | undefined;
  all(): TierDriver[];
  probeAll(refresh?: boolean): Promise<TierProbe[]>;
}
```

`DesktopTierRegistry` here holds ONLY tiers 5 and 6 — an empty slot for
1–4, never a placeholder that would compete with Phase 4's authority.
When Phase 4's registry lands, delete `DesktopTierRegistry` and register
`accessibilityDriver` and `guiDriver` into theirs. The Fabric reaches
tiers through `FabricHost.probeTiers` (wired in `fabric/index.ts`), which
delegates to whichever registry is in force.

## Deliverable 3 — Windows/macOS lifecycle E2E, signing

**Signing pipeline: BUILT · gate RUNTIME VERIFIED (Linux) · actual
signing BUILT: NOT COMPILED (no runner, no certs).**

- `scripts/sign-desktop.mjs` — Authenticode (Windows) and codesign +
  notarization (macOS), verified by the OS's own verifier. Three
  outcomes, never a fourth: requested+present signs and verifies;
  requested+absent exits non-zero naming every missing secret and signs
  nothing; not-requested ships honestly unsigned. Never fabricates an
  identity, never fakes success.
- `.github/workflows/ci.yml` — a `sign` workflow_dispatch input; a
  signing step (secrets by reference only); and signature-verification
  steps (`signtool verify`/`Get-AuthenticodeSignature`, `spctl
  --assess`) that assert OS acceptance when signing was requested and
  record the artifact as honestly unsigned when it was not.
- The install→launch→detect→uninstall lifecycle E2E already existed per
  OS in CI; this extends it with signing and signature verification.

Verified by `scripts/signing-config-verify.mjs` — **27 checks, 0
failed**, the missing-credential case as the central control, forcing
each platform's decision path from Linux via a `process.platform` shim.

**NOT VERIFIED / BLOCKED ON THE USER:** the actual `signtool` and
`codesign`/`notarytool` invocations. They need a Windows/macOS runner and
**real certificates, which I have none of and must not fabricate.** The
exact secrets and the OV-vs-EV / API-key-vs-Apple-ID decisions are in
`QUESTIONS.md`. To run: set the secrets, dispatch CI with `sign = true`.

## Deliverable 4 — Injection resistance, keychain, hash-chain, npm.cmd

**Keychain: BUILT · RUNTIME VERIFIED (Linux, incl. the no-service
fallback).**

- `packages/ai-service/src/provider/keychain.ts` — libsecret / macOS
  `security` / Windows DPAPI, driven via the OS's own CLI (zero
  third-party runtime deps; trade-off in QUESTIONS.md §4). Secret on
  stdin, never a command line. The probe is a real write/read/delete
  round trip — which on THIS machine correctly reports libsecret
  unavailable (installed, no Secret Service) where a `which` would lie.
- `credentialStore.ts` rewritten: `os-keychain` → `passphrase` (scrypt
  N=2^15 over a random per-credential salt) → **refuse**. The old scheme
  (AES key stored beside the ciphertext) is now `legacy-obfuscated`,
  still readable, migrated in place on first read; the legacy seed is
  dropped when unused. Storing now throws where there is nowhere safe;
  `connectProvider` surfaces it as an error.

Verified by `scripts/credential-protection-verify.mjs` — **33 checks, 0
failed**. The negative control ACTUALLY ATTACKS a legacy file and
recovers the key; the same attack fails against the new format. Caught a
real migration bug (env-first legacy key precedence → data loss) before
it shipped. **NOT VERIFIED:** macOS `security` and Windows DPAPI
backends. Run `node scripts/credential-protection-verify.mjs` on each.

**Injection resistance: BUILT · RUNTIME VERIFIED (Linux).**
`scripts/injection-resistance-verify.mjs` — **52 checks, 0 failed**.
Retrieved content used as a capability id, as an argument, as a window
title, and as an actor claim in the journal — none causes an invocation.
The shell boundary, the three disjoint allow-lists (AGENT disjoint from
the rest; the shared package managers guarded by `installSubcommand`),
and no privilege-escalating binary anywhere.

**Audit hash-chain: detection RUNTIME VERIFIED (Linux) · integration NOT
VERIFIED (Phase 1's store not present).**
`scripts/audit-chain-verify.mjs` — **16 checks, 0 failed**, consuming
REAL `AuditRecord`s from the running Fabric. Every tamper shape detected,
including a field change with a locally-recomputed hash (the chain vs
per-line-hash distinction). Truncation is caught by the external head
hash — documented as a requirement on Phase 1's store.

### Contract this phase needs from Phase 1's journal

Phase 1 owns `packages/capability-fabric/src/auditStore.ts` (the durable
hash-chained journal). It was not present in this tree, so
`audit-chain-verify.mjs` consumes a reference implementation and switches
to Phase 1's automatically once it exports:

```ts
// entry: { seq: number, record: AuditRecord, prevHash: string, hash: string }
export function appendToChain(records: AuditRecord[]): ChainEntry[];
export function verifyAuditChain(entries: ChainEntry[]):
  { ok: boolean; brokenAt: number; reason: string };

// hash(entry) = sha256( prevHash + "\n" + canonicalJSON(record) )
//   genesis prevHash = "AURA-AUDIT-CHAIN-GENESIS-v1"
//   canonicalJSON = object keys sorted at every depth
//   the head (tail hash) MUST be persisted OUTSIDE the file so a
//   truncation of the tail is detectable — it is invisible within the
//   file itself.
```

If Phase 1 chooses a different serialization, tell me and I will align
the verifier; the four tamper controls hold for any forward-linked chain.

**npm.cmd bug: BUILT · RUNTIME VERIFIED (Linux).**
`packages/governance/src/security/security_review.ts` hardcoded
`npm.cmd` — ENOENT on Linux/macOS, unspawnable on Windows since
CVE-2024-27980. Fixed by injecting the resolver that already exists in
`exec/which.ts` (governance cannot import ai-service; the resolver is
registered at the single wiring point in `server.ts`). Verified: `npm
audit` now genuinely runs on Linux, reporting 3 real vulnerabilities
where it previously always said `available: false`.

---

## How to run every verification here

```
node scripts/desktop-tier-verify.mjs            # 65 checks — ladder, drivers, discovery
node scripts/credential-protection-verify.mjs   # 33 checks — keychain, KDF, migration
node scripts/injection-resistance-verify.mjs    # 52 checks — content cannot invoke
node scripts/audit-chain-verify.mjs             # 16 checks — tamper detection
node scripts/signing-config-verify.mjs          # 27 checks — signing gate never fakes
npm run typecheck                               # clean
```

All five pass on this machine. 193 checks, 0 failed, every claim with a
negative control.

## What is NOT done, and why

- OS signing on real hardware — blocked on certificates (QUESTIONS.md).
- tier 5/6 and discovery on macOS/Windows — no such machine here.
- Wayland tier 6 — impossible by Wayland's design, declared unsupported.
- Synthetic INPUT (writing at tiers 5/6) — deliberately out of scope this
  phase; only read-only observation ships, which is what makes the
  writing half governable when it is built.
- Integration with Phase 1's durable journal and Phase 4's driver
  registry — both consume-not-fork; interfaces recorded above.
