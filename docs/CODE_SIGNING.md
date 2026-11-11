# Code signing (Windows and macOS)

AURA Hub's installers are signed for the **updater** (the `.sig` files), but
not by **Apple or Microsoft**. Until they are:

- Windows shows SmartScreen: "Windows protected your PC — unknown publisher".
- macOS refuses to open the app ("cannot be opened" / "is damaged").

CI signs automatically as soon as the secrets below exist. Without them the
build is unsigned, exactly as before. Nothing else needs to change.

## What to buy

| Platform | What | Cost (approx.) |
|---|---|---|
| macOS | Apple Developer Program membership (organization or individual) | US$99 / year |
| Windows | A code-signing certificate as a `.pfx` (OV, or EV for instant SmartScreen trust) from a CA such as DigiCert, Sectigo or SSL.com | US$200–600 / year |

Azure Trusted Signing (about US$10 / month) is a cheaper Windows option; it
needs a different signing command and is not wired up here yet.

## Repository secrets to add

GitHub → the repository → Settings → Secrets and variables → Actions.

### macOS

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Your "Developer ID Application" certificate exported as `.p12`, then base64: `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Company (TEAMID)` |
| `APPLE_ID` | The Apple ID email used for notarization |
| `APPLE_PASSWORD` | An **app-specific password** for that Apple ID (appleid.apple.com) |
| `APPLE_TEAM_ID` | Your 10-character team ID |

Signing turns on with the first three; notarization (needed so Gatekeeper
opens the app without a warning) turns on when all six are set.

### Windows

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | The `.pfx` file, base64: `base64 -w0 cert.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` password |

## How to check it worked

In the next CI run, the step **"Enable OS code signing when its secrets are
set"** prints `macOS signing: on`, `macOS notarization: on` and
`Windows signing: on`. A downloaded installer then shows your company as
the publisher.
