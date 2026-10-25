# macOS signing and notarization runbook

Earheart's macOS releases are signed with the **Developer ID Application**
certificate of team `XTZB5CXLUQ`, built under the hardened runtime, and
notarized by Apple with an App Store Connect API key. electron-builder signs
and notarizes the `.app` (`notarize: true` in
[electron-builder.yml](../electron-builder.yml)); a step in
[release.yml](../.github/workflows/release.yml) notarizes and staples the dmg.
[CONTRIBUTING.md](../CONTRIBUTING.md#macos-signing) explains why; this page is
the how.

## The secrets

All five are repository secrets. A tag build fails if any is missing; a branch
dry run without them builds unsigned.

| Secret | What it holds |
| --- | --- |
| `MAC_CSC_LINK` | base64 of a `.p12` with the Developer ID Application certificate **and its private key** |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY_P8_BASE64` | base64 of the App Store Connect API key (`AuthKey_<id>.p8`) |
| `APPLE_API_KEY_ID` | that key's Key ID (10 characters) |
| `APPLE_API_ISSUER_ID` | the Issuer ID (a UUID) shown above the key list |

Set them with `gh` from a file, so nothing lands in shell history:

```bash
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK
gh secret set MAC_CSC_KEY_PASSWORD          # prompts for the value
base64 -i AuthKey_ABC123DEFG.p8 | gh secret set APPLE_API_KEY_P8_BASE64
gh secret set APPLE_API_KEY_ID --body ABC123DEFG
gh secret set APPLE_API_ISSUER_ID           # prompts for the value
```

Delete the local `.p12` and `.p8` copies once they are stored somewhere safe
(a password manager). Never commit them.

## Renewing the Developer ID certificate

Developer ID Application certificates last five years. Already-notarized
releases keep launching after the certificate expires, because their
signatures carry a secure timestamp; only new builds need the new one.

1. On a Mac, Keychain Access → Certificate Assistant → **Request a Certificate
   From a Certificate Authority**, saved to disk.
2. In the Apple Developer portal → Certificates → **+** → *Developer ID
   Application*, upload the request, download the `.cer`, and double-click it
   to add it to your login keychain.
3. In Keychain Access, select the certificate together with its private key →
   **Export 2 items…** → `.p12` with a strong password.
4. Replace `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (see above).
5. Run a dry run (below) and check the verify step passes.

Users keep their Accessibility and Automation grants: the designated
requirement names the bundle id and the team (`certificate leaf[subject.OU] =
XTZB5CXLUQ`), not the certificate, so a renewed certificate from the same team
satisfies it.

If the key leaked, also **revoke** the old certificate in the portal after the
new one is live. Revoking can stop Gatekeeper from accepting past releases
signed with it too, so ship a release signed with the new certificate first.

## Rotating the App Store Connect API key

The key only talks to the notary service; it never ends up in a release.

1. App Store Connect → Users and Access → **Integrations** → App Store Connect
   API → **+**, with the *Developer* role. Download the `.p8` (it can be
   downloaded only once) and note its Key ID.
2. Replace `APPLE_API_KEY_P8_BASE64` and `APPLE_API_KEY_ID`. The Issuer ID
   stays the same for the team.
3. Run a dry run, then **revoke** the old key in App Store Connect.

## Dry run

```bash
gh workflow run release.yml --ref <branch>
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

A branch run signs, notarizes, verifies, and uploads the build as a workflow
artifact, but creates and publishes no release.

## Verifying a release by hand

On a Mac, with the dmg downloaded from the release (or the `earheart-macos-latest`
workflow artifact):

```bash
dmg=~/Downloads/Earheart-<version>-arm64.dmg
hdiutil attach "$dmg" -nobrowse -mountpoint /tmp/earheart-dmg
app=/tmp/earheart-dmg/Earheart.app

# Signature intact, hardened runtime on, signed by Earheart's Developer ID.
codesign --verify --deep --strict --verbose=2 "$app"
codesign -dvv "$app" 2>&1 | grep -E '^(Authority|TeamIdentifier|flags)'
#   flags=0x10000(runtime)
#   Authority=Developer ID Application: … (XTZB5CXLUQ)
codesign -dr - "$app"      # identifier "dev.cleanunicorn.earheart" … subject.OU] = XTZB5CXLUQ
codesign -d --entitlements - "$app"

# Notarization tickets stapled to both.
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"

# Gatekeeper's verdict: "accepted" and "source=Notarized Developer ID".
spctl -a -vvv -t exec "$app"
spctl -a -vvv -t open --context context:primary-signature "$dmg"

hdiutil detach /tmp/earheart-dmg
```

The update zip must verify the same way after extraction, or the in-app
updater would re-sign it ad-hoc (and void users' permission grants):

```bash
mkdir -p /tmp/earheart-zip && ditto -xk ~/Downloads/Earheart-<version>-arm64-mac.zip /tmp/earheart-zip
codesign --verify --deep --strict /tmp/earheart-zip/Earheart.app
```

## When notarization fails

`notarytool` prints a submission id. Fetch Apple's log for it with the same
key:

```bash
xcrun notarytool log <submission-id> --key AuthKey_<id>.p8 \
  --key-id <key-id> --issuer <issuer-id>
```

The usual causes are a binary missing the hardened runtime or a secure
timestamp (something signed outside electron-builder), or an unsigned Mach-O
added to the bundle after signing.
