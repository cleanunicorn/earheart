# earheart.app launch plan: GitHub organization, repo move, website

Goal: Earheart lives in its own GitHub organization, and earheart.app presents the
app and serves the downloads.

## Progress

Planning
- [x] Audit every place the repo hard-codes `cleanunicorn/earheart`
- [x] Confirm installed apps survive the move (the updater uses `fetch`, which
      follows GitHub's redirects, and checks every download's sha512, so no host is pinned)
- [x] Check org names: `earheart` belongs to an unrelated user account.
      `earheart-app`, `earheartapp`, `earheart-hq`, `earheart-dev` and `getearheart` are free
- [x] Check the domain: earheart.app is on Cloudflare DNS with no A, AAAA or MX records yet
- [x] Pick the org name: **`earheart-hq`**

Phase 1: Organization (you, in the web UI; no API exists for this)
- [x] Create the org on the Free plan: github.com → Settings → Organizations → New organization
- [ ] Turn on 2FA enforcement and set the base member permission to Read
- [ ] Verify earheart.app for the org (add a TXT record in Cloudflare) to get the "Verified" badge
- [ ] Set the org's profile: avatar (`assets/icon.png`), URL https://earheart.app, description
- [ ] Allow fine-grained PATs that target the org (needed for `STAR_HISTORY_TOKEN`)

Phase 2: Transfer the repo (depends on Phase 1)
- [ ] Repo Settings → Danger zone → Transfer → the new org
- [ ] Update the local remote once (worktrees share it):
      `git remote set-url origin git@github.com:earheart-hq/earheart.git`
- [ ] Run the post-transfer checks below
- [ ] Merge the slug PR (Phase 3). **Not before the transfer**, or new builds point at a 404

Phase 3: In-repo slug PR (one PR, merged right after the transfer)
- [x] `main/services/update-feed.js` `REPO_SLUG`
- [x] `test/update-feed.test.js` fixture URL
- [x] `package.json` `repository` and `homepage` (→ https://earheart.app once the site is live)
- [x] README, CONTRIBUTING, `docs/agents.md`, `docs/videos/README.md`, `stt-server/README.md`
- [x] `.github/ISSUE_TEMPLATE/config.yml` URLs (it also links to Discussions, which are
      disabled: turn Discussions on or drop that link)
- [ ] Repo "homepage" field: from the releases page to https://earheart.app

Phase 4: Domain and email (can run in parallel with Phases 1–3)
- [ ] Cloudflare Email Routing: hello@, support@ and security@earheart.app forward to your inbox
- [ ] Add a `SECURITY.md` that points to security@earheart.app or GitHub private advisories
- [x] Choose hosting for the site: **Cloudflare Pages**. `.app` is HSTS-preloaded, so HTTPS is mandatory

Phase 5: Website repo (depends on Phase 1 and the hosting decision)
- [ ] `gh repo create earheart-hq/earheart.app --public` (or `earheart-hq/website`)
- [ ] Connect it to the host, deploy a placeholder page, and point earheart.app and www at it
- [ ] Build the site (separate work)

Phase 6: Delivering the app from the site (depends on Phase 5)
- [ ] Stable download links: release assets carry the version in their names
      (`Earheart-0.57.3-arm64.dmg`), so the site needs either a resolver
      (`earheart.app/download/mac` → read `latest-mac.yml` or the Releases API) or
      unversioned copies added in `release.yml`
- [ ] A privacy page: the app is local, but it downloads models from Hugging Face and
      checks GitHub for updates. Say so plainly
- [ ] Windows signing: builds are unsigned, so SmartScreen warns on download
- [ ] Decide whether new builds read the update feed from earheart.app (see Decisions)

Out of scope (do not change)
- The bundle/app id `dev.cleanunicorn.earheart` (electron-builder `appId`,
  `MAC_BUNDLE_ID`, `release.yml:259`). macOS permission grants, signing checks and the
  Windows install identity are keyed to it. Renaming it costs users their permissions
  and buys nothing visible.

## Hard rules

1. **Never create a repo or fork named `cleanunicorn/earheart` again.** Every installed
   copy up to v0.57.3 checks `github.com/cleanunicorn/earheart/releases/latest/download/…`.
   That only works through GitHub's redirect, and GitHub deletes the redirect for good if
   the old name is reused. If you want a personal fork, give it a different name.
2. Merge the slug PR only after the transfer.
3. Make the first release from the org a dry run: a manual, non-tag run of `release.yml`.

## Post-transfer checks

GitHub's docs promise redirects for web and git URLs. They don't mention release
downloads, raw.githubusercontent.com, Actions variables or the API, so verify these:

```sh
for f in latest.yml latest-mac.yml latest-linux.yml release-notes.json; do
  curl -sIL -o /dev/null -w "%{http_code} $f\n" \
    "https://github.com/cleanunicorn/earheart/releases/latest/download/$f"
done
curl -sIL -o /dev/null -w "%{http_code} asset\n" \
  https://github.com/cleanunicorn/earheart/releases/download/v0.57.3/earheart_0.57.3_amd64.deb
curl -sIL -o /dev/null -w "%{http_code} raw\n" \
  https://raw.githubusercontent.com/cleanunicorn/earheart/refs/heads/main/docs/videos/poster.jpg
gh secret list -R earheart-hq/earheart     # expect 6: APPLE_* ×3, MAC_CSC_* ×2, STAR_HISTORY_TOKEN
gh variable list -R earheart-hq/earheart   # expect MAC_SIGNING_CERT_SHA1
```

Every line should end in `200`. Then run the star-history workflow by hand. If it fails,
regenerate `STAR_HISTORY_TOKEN` as a fine-grained PAT with the org as resource owner.
Then check that an installed copy of the app still says "up to date".

## Decisions

- **Org name.** `earheart` is taken by an inactive personal account. Chosen: `earheart-hq`.
  Whether GitHub will release a dormant name is unverified (their name-squatting policy
  decides case by case), so don't plan around it.
- **Hosting: Cloudflare Pages (chosen).** DNS is already on Cloudflare, so Cloudflare Pages keeps DNS, redirects
  (`/download/*`), email routing and analytics in one place. GitHub Pages works too,
  but download redirects would need client-side JS. Check current pricing and limits
  before you choose; this plan doesn't verify them.
- **Update feed host.** The feed could stay on GitHub (no change, depends on the
  redirect for old installs) or move to `earheart.app/update/…` for new builds,
  redirecting to GitHub. The second makes any future move free, but the site becomes
  part of the update path.
- **Windows signing.** Ship unsigned with a "More info → Run anyway" note, or buy
  signing: Azure Trusted Signing or an OV/EV certificate. Eligibility and price need
  checking.
