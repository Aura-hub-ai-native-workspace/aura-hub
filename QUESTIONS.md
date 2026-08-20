# Phase 5 — questions only the user can answer

These are the sub-items I stopped on because the answer is a credential,
a certificate, or a product decision I must not invent. Everything else
in the phase is complete. Each question below names exactly what is
needed and where it must live, so answering it is a matter of pasting
values into GitHub repository secrets — no code change is required to
turn signing on.

Nothing here is stubbed to look finished. The signing pipeline
(`scripts/sign-desktop.mjs`, wired into `.github/workflows/ci.yml`) is
real and refuses loudly when these are absent; it does not fake success.

---

## 1. Windows Authenticode signing

To produce a Windows build SmartScreen does not warn on, AURA needs a
code-signing certificate. There is a genuine choice here, and it is
yours because it has cost and trust implications I cannot decide:

**Question 1a — which kind of certificate?**

- **OV (Organization Validation)** — cheaper, but SmartScreen reputation
  builds up only after many installs, so early users still see a warning.
- **EV (Extended Validation)** — immediate SmartScreen reputation, but
  the private key must live on hardware (an HSM or a cloud signing
  service such as Azure Trusted Signing / DigiCert KeyLocker). An EV cert
  cannot be exported as a `.pfx`.

This decides which secrets to set:

- If OV with an exportable `.pfx`:
  - `WINDOWS_CERTIFICATE` — the `.pfx`, base64-encoded.
  - `WINDOWS_CERTIFICATE_PASSWORD` — its password.
- If EV / cloud-HSM (the certificate is installed in the runner's machine
  store or reachable via a signing service):
  - `WINDOWS_CERTIFICATE_THUMBPRINT` — the SHA-1 thumbprint of the cert.
  - (A cloud service may need its own extra secrets and a different
    `signtool` dispatcher; tell me which service and I will wire it.)

**Question 1b — timestamp authority?** Defaults to
`http://timestamp.digicert.com`. Override with `WINDOWS_TIMESTAMP_URL` if
your CA requires a specific one.

All of these are set at **GitHub → repo → Settings → Secrets and
variables → Actions**.

---

## 2. macOS signing and notarization

To produce a macOS build Gatekeeper opens without the "unidentified
developer" block, AURA needs a Developer ID and an Apple notarization
credential.

**Question 2a — the Developer ID Application certificate.**

- `APPLE_CERTIFICATE` — the "Developer ID Application" certificate
  exported as a `.p12`, base64-encoded.
- `APPLE_CERTIFICATE_PASSWORD` — its export password.
- `APPLE_SIGNING_IDENTITY` — the exact identity string, e.g.
  `Developer ID Application: Your Name (TEAMID1234)`.

This requires membership in the Apple Developer Program ($99/year). I
cannot create the certificate; it is generated from your Apple Developer
account.

**Question 2b — notarization credentials.** Pick ONE set:

- **App Store Connect API key (recommended):**
  - `APPLE_API_KEY` — the `.p8` key, base64-encoded (or a path the CI
    materialises; tell me your preference).
  - `APPLE_API_KEY_ID` — the key id.
  - `APPLE_API_ISSUER` — the issuer id.
- **Apple ID (simpler, less robust):**
  - `APPLE_ID` — the Apple ID email.
  - `APPLE_APP_PASSWORD` — an app-specific password (not the account
    password), generated at appleid.apple.com.
  - `APPLE_TEAM_ID` — your 10-character team id.

**Question 2c — the Team ID itself.** I need the 10-character Apple Team
ID (e.g. `A1B2C3D4E5`) regardless of which notarization path you choose;
it also appears inside `APPLE_SIGNING_IDENTITY`.

---

## 3. Turning it on

Once the secrets above are set, run the CI **workflow_dispatch** with the
`sign` input checked. That is the whole switch:

- `sign = false` (default) → the current honest-unsigned build. Nothing
  changes for anyone who does not set these secrets.
- `sign = true` with the secrets present → signed, notarized artifacts,
  verified by the OS's own verifier (`signtool verify`, `spctl
  --assess`) inside the same CI run.
- `sign = true` with a secret missing → the build FAILS and names the
  missing secret. It never ships an unsigned artifact under a signed
  release.

There is no question for me hidden in this step — it is here so the
switch is documented in one place.

---

## 4. Keychain dependency trade-off (decided, recorded for visibility)

Not a blocking question, but a decision worth your sign-off because it
touches the "zero third-party runtime dependencies" invariant.

The OS keychain integration (`packages/ai-service/src/provider/keychain.ts`)
drives the platform's own command-line tools — `secret-tool` (libsecret),
`security`, PowerShell/DPAPI — rather than adding a native npm binding
(`keytar` and its successors are all native modules). This keeps the
backend's dependency count at zero, at the cost that:

- `secret-tool` is not installed on every Linux machine, and some
  headless sessions run no Secret Service at all. On those, AURA falls
  back to the `AURA_PROVIDER_SECRET` + scrypt path, and if neither is
  present it **refuses to store the key** rather than obfuscating it.

If you would rather take on a native keychain dependency for a smoother
Linux experience, say so and I will scope it. Until then the
zero-dependency path stands and is fully implemented.
