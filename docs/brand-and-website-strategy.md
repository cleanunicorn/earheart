# Earheart — brand, positioning & website strategy (merged plan)

Coordinator merge of Plan A and Plan B, 2026-10-11. Repository facts are against `cleanunicorn/earheart` at commit `95f4597` (`main`, package.json 0.37.0; latest published release v0.38.1, 2026-10-11 06:07 UTC per the GitHub API). Every web check is dated; `unknown:` marks a check that could not be run. Nothing in the repository was changed, and this run ends with this document. Everything marked `proposed:` is a proposal, not something that exists.

## Progress

Planning (done)
- [x] Phase 0 context read; AGENTS.md, PRODUCT.md, README.md, DESIGN.md, docs/agents.md, electron-builder.yml, package.json, workflows, `assets/`, `docs/screenshots/` read by both planners and re-opened by the coordinator
- [x] Two independent plans written (Plan A, Plan B)
- [x] Every load-bearing `path:line` in both plans checked against `95f4597` (appendix A.0 — 5 wrong in A, 8 stale/wrong in B; all `main/`, `test/`, workflow citations correct)
- [x] Live re-checks 2026-10-11 ~06:20 UTC: npm, Verisign/Google RDAP, authenticated `gh api` for GitHub users/repos/stars, Claude Code `/voice` doc, awesome-claude-code CONTRIBUTING, HN Algolia, Codex voice search, astro version, cleanunicorn.github.io
- [x] SWOT per plan (A: 11 S · 10 W · 10 O · 6 T; B: 11 S · 9 W · 9 O · 6 T), 30 decision records, coherence pass, this merged plan (appendix A)

Decisions the user owns (block the milestones they name — exact questions in §9)
- [ ] **Q1 keep vs rename** → blocks M2, M3 (repo/domain name only), M5
- [ ] **Q2 register earheart.dev + earheart.app now** (if keep) → blocks M5
- [ ] Q3–Q9 (appId, stt-server, analytics, demo recording, Product Hunt, README `/voice` subsection, reference links)

Implementation milestones — one deliverable (PR) per repository; checkboxes are milestones inside that PR, not separate PRs
- [ ] **M1 — Site repository** `proposed: github.com/cleanunicorn/earheart-site` (or `<name>-site`), one initial PR containing all of: zero-dependency static site (`site/`, `build.js`, `test/`), five pages with the copy in §4.3, bar replica hero, `release.json` build-time fetch with committed fallback, claims/links/tokens tests, `deploy.yml` (GitHub Pages, daily cron), short `AGENTS.md`. *Depends on:* nothing for the build (ships on `cleanunicorn.github.io/earheart-site`); on M4 for the hero video; on Q1 for the repo name.
- [ ] **M2 — Rename PRs in the app repo (only if Q1 = rename):** PR R0 `fix: accept a renamed app bundle when updating` (bridge; must be live on users' machines ≥1 update cycle before R1 — the one justified split, §3.4), then PR R1 `feat!: rename Earheart to <Name>` containing every step of §3.4. *Depends on:* Q1, Q3, Q4.
- [ ] **M3 — Domain + DNS:** register `earheart.dev` (primary) and `earheart.app` (301) — or `<name>.dev`/`.app` — then `CNAME` + apex `A`/`ALIAS` + `www` CNAME per GitHub Pages docs, HTTPS enforced. *Depends on:* Q1/Q2. Purchase is the user's action.
- [ ] **M4 — Assets:** 30–40 s demo MP4 (≤6 MB) cut into a 10 s GIF; OG image 1200×630; SVG mark + wordmark + favicon set; three real agent screenshots (terminal/Claude Code, Codex, Cursor). *Depends on:* Q6 (who records). Wordmark depends on Q1.
- [ ] **M5 — README/homepage refresh PR in the app repo** (`docs:` title, no release): hero GIF, site link, `package.json#homepage` (`package.json:14`) → site, optional "Why not the built-in `/voice`?" subsection (Q8). *Depends on:* M1 live, Q8.
- [ ] **M6 — Launch sequence** §5.3: awesome-list issue forms → Show HN + X/Bluesky same day → Reddit one subreddit per day → Product Hunt optional (Q7). *Depends on:* M1, M4, M5; a measurement table filled by hand from the GitHub API.
- [ ] **M7 — Fold in user-supplied reference links** (§6, empty slot) — whenever they arrive; revises §4.4 visual direction and §4.3 hero only.

Deferred follow-ups (recorded, not in scope)
- [ ] Homebrew cask / winget manifest (every traction leader in the category — Handy, VoiceInk — ships one; app-repo work)
- [ ] macOS notarization (removes the single biggest install-friction line; needs an Apple Developer account)
- [ ] Light-theme variant of the site and/or a self-hosted OFL webfont (launch is dark-only, `system-ui`)
- [ ] `repository_dispatch` from the app repo's `release.yml` to rebuild the site on publish (replaces the daily cron lag)
- [ ] Privacy-respecting site analytics (Q5; none at launch)
- [ ] Docs site (Starlight or similar) only if the README outgrows GitHub rendering
- [ ] Formal USPTO/EUIPO search — required before registering any *fallback* name; not needed to keep "Earheart"

---

## 1. Outcome, scope, constraints

**Outcome.** One strategy document that (a) repositions and decides keep-vs-rename with a researched shortlist and a concrete, cited migration plan; (b) defines a marketing website for a **new, separate repository**; (c) defines messaging, visuals and a launch plan — all grounded in live research and executable without re-deriving it.

**Non-goals.** No app code change, no site code, no repo creation, no DNS purchase, nothing committed.

**Binding constraints (verified against the repo).**
- Never fabricate testimonials, case studies, press, user counts, download counts, benchmarks or pricing — `PRODUCT.md:159-162`. The only performance claim allowed is "faster than realtime on CPU" (`PRODUCT.md:107`, `README.md:264`).
- Not claimed (yet): Earheart does not submit the prompt, does not speak replies, has no MCP or agent-side integration — `PRODUCT.md:74-77`, `README.md:100-103`. Never describe roadmap as shipped.
- No telemetry, no accounts, no cloud requirement — `PRODUCT.md:127`, `README.md:130`.
- Two runtime deps, plain JavaScript, no bundler — `package.json:32-34`, AGENTS.md Golden rule 9 (binds the **app** repo; the site repo is free but should match the culture so the same agents can maintain both).
- Release automation keys off Conventional Commits PR titles; the self-updater reads GitHub releases from a hard-coded repo slug — AGENTS.md "Release automation", `main/services/update-feed.js:11-13`.
- The user's global rule: `## Progress` first; milestones are checkboxes inside one PR per repo.

**Assumptions (labelled).** A1: the one-PR rule applies per repository — the app-repo rename and the site repo's initial PR are two deliverables, not a split. A2: "well-designed" for a desktop-tool landing page means (i) the first screen says what it is and for whom, (ii) per-OS download is handled in the hero, (iii) the product is shown in action. A3: the user registers domains personally.

**Current state (evidence).** Name usage: `git grep -il earheart | grep -v CHANGELOG | wc -l` → 102 files / 611 lines. Identity: `electron-builder.yml:1-2` (`appId: dev.cleanunicorn.earheart`, `productName: Earheart`), `package.json:2` (`"name": "earheart"`), `package.json:14` (`homepage` → the GitHub repo). Design system: ink `#18181b`, one coral `#fb4d5c` (`renderer/tokens.css:10-16`; `DESIGN.md:3-6, 184-199`). Assets: `assets/icon.png` + four tray PNGs (PNG only, rendered by `scripts/gen-icons.js:2-5` — no SVG source); nine screenshots in `docs/screenshots/`; star-history SVGs on the orphan `origin/star-history` branch (`README.md:508-515`); `CHANGELOG.md` ships inside the app (`electron-builder.yml:23-25`). Stars 29, created 2026-06-12, MIT (GitHub API 2026-10-11).

---

## 2. AC1 — Positioning

### 2.1 The fact that changes the positioning

Both flagship agents now ship their own voice input, and it is cloud:

- **Claude Code `/voice`** (https://code.claude.com/docs/en/voice-dictation, fetched 2026-10-11 by both planners and re-fetched by the coordinator, verbatim): *"Voice dictation streams your recorded audio to Anthropic's servers for transcription. Audio is not processed locally."* It needs *"A Claude.ai account … not available when Claude Code is configured to use an Anthropic API key directly, Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry"*, and *"does not work in cloud sessions or SSH sessions"*; the VS Code extension has the same account rule and is unavailable in Remote/SSH/Dev Containers/Codespaces; an org policy can disable it.
- **Codex CLI** — `unknown:` third-party blogs (codex.danielvaughan.com, 2026-03-28 and 2026-09-22) describe built-in push-to-talk dictation from v0.105.0 and "voice on by default" in v0.156.0, audio sent to the vendor; no official OpenAI changelog entry was found on 2026-10-11 and one vendor page says it is undocumented. **Do not state this on the site until verified against OpenAI's own changelog.**
- **Cursor** shipped Voice Mode in 2.0 (Oct 2025) per WebSearch 2026-10-11 — only inside Cursor.

So "talk to your agent" alone is no longer a differentiator. **"On your machine, for every agent, from one hotkey"** is — and it is literally true out of the box (`README.md:11, 487`).

### 2.2 Lead claim and audiences

**Lead claim:**

> **Talk to your coding agents. Your audio and prompts never leave your machine.**

The first sentence is the existing tagline (`PRODUCT.md:141`, `README.md:8`). The second is the README's own verified sentence (`README.md:11`), chosen over "privately" (`PRODUCT.md:52`) because Wispr ("Your voice stays yours"), Aqua ("Privacy Mode") and Willow ("zero data retention") all say *private* while processing in the cloud, and chosen over "Nothing leaves your machine" because the app does poll GitHub for updates (`main/services/update-feed.js:12`, `README.md:187`) and downloads models — the narrower sentence is the one that survives an honest reader.

**Primary audience:** developers prompting Claude Code / Codex / Cursor for hours a day (`PRODUCT.md:11-13`). **Secondary / served:** API-key, Bedrock, Foundry and SSH users whom the built-ins exclude; privacy-constrained and local-LLM developers; everyday technical dictation; motor/RSI users (confirmed commitment, `PRODUCT.md:27-30, 180-184`); Linux users (`PRODUCT.md` Positioning "Linux is a first-class citizen").

### 2.3 Differentiation table

All rows fetched 2026-10-11 by the planners; star counts re-verified by the coordinator the same day via `gh api`. "unknown" = the page did not say. **Prices are for this document only — flagged `verify` where they came from a summarising fetch or a third-party page — and never appear on the site.**

| Product | URL | Pricing model | Local vs cloud | Platforms | Earheart does better (+) / worse (−) |
|---|---|---|---|---|---|
| **Claude Code `/voice`** (built-in) | code.claude.com/docs/en/voice-dictation | Included with claude.ai plans; needs claude.ai login | **Cloud** (audio streamed to Anthropic; doc quote above) | CLI on macOS/Linux/Windows (WSLg), VS Code ext. | + works with API-key/Bedrock/Foundry/SSH setups and in every other app; on-device; cleanup styles + dictionary. − zero install; project/branch names as recognition hints; no model download |
| Codex CLI voice (built-in) | `unknown:` official changelog not found; third-party codex.danielvaughan.com | Included | Cloud (vendor), per third-party | Codex CLI | + one tool across agents, on-device. − zero install. **Unverified — strategy only** |
| Handy | handy.computer · github.com/cjpais/Handy (33,470 ★) | Free, MIT, donations | Local (Whisper, Parakeet V3) | macOS, Windows, Linux; Homebrew, winget, .deb | + on-device LLM cleanup with styles + dictionary; live transcript; agent recipes; repointable stages. − 33k★ vs 29; Tauri binary size; package-manager installs; the clearest one-job landing page in the category |
| Superwhisper | superwhisper.com | Free tier; Pro ≈ $8.49/mo, lifetime option (`verify`: page rendered "$849"; official pricing page 404'd for Plan B) | Both: local on Apple Silicon, cloud optional | macOS, Windows, iOS, Android | + fully local cleanup too, no account, Linux, MIT. − polish, modes, meeting notes, mobile, interactive demo |
| Wispr Flow | wisprflow.ai | Free 2,000 words/wk; Pro $15/mo ($12 annual); Growth $23/mo (`verify`) | Not stated (cloud implied by SOC 2/HIPAA and word quotas) | macOS, Windows, iPhone, Android | + no quota, no account, offline by default, Linux. − edit-as-you-speak, tone selector, team features, far more polished site |
| Aqua Voice | aquavoice.com (withaqua.com 308→) | Free 1,000 words; Pro/Max/Business (amounts not on page) | Not stated; "Privacy Mode" implies servers | macOS, Windows, iOS, Android; CLI, MCP, API | + fully local by default, open, Linux. − realtime mode, "Send it" voice command, MCP/CLI, strong Codex/Claude Code section |
| MacWhisper | goodsnooze.com (ENOTFOUND 2026-10-11; `verify` via secondary sources) | Free; Pro ≈ €59 one-time; App Store sub (`verify`) | Local (Whisper) | macOS only | + cross-platform, agent-aimed, on-device cleanup. − mature file-transcription feature set |
| VoiceInk | tryvoiceink.com · github.com/Beingpax/VoiceInk (6,727 ★) | $25/$39/$49 one-time; GPL-3.0 source | Local STT; optional cloud text "enhancement" | macOS 14.4+/15+, Apple Silicon; Homebrew | + free builds, Windows + Linux, cleanup local by default, MIT. − social proof (user counts, "wall of love") we do not have and must not invent; brew install |
| Talon | talonvoice.com | Free beta + Patreon "Talon+" | Not stated | macOS, Windows, Linux (X11) | + zero learning curve for prompts. − full hands-free control (commands, eye tracking); Earheart only pastes text |
| Willow | willowvoice.com | Subscription (prices on separate page); "Contact Sales" | Cloud by default; offline mode exists | macOS, Windows, iPhone | + local by default, no account, Linux, open. − style learning, certifications, mobile |
| Whispering → Epicenter | github.com/braden-w/whispering (archived 2026-02-14) → github.com/epicenter-md/epicenter (4,822 ★, AGPL) | Free, open source, BYOK | Local or BYOK cloud | Desktop (Tauri); `unknown:` per-OS list | + bundled models + cleanup out of the box, no key management. − Show HN precedent 591 pts (2025-08-18, HN Algolia re-verified) |
| OpenWhispr | github.com/OpenWhispr/OpenWhispr (~9.2k ★) | MIT; hosted cloud + enterprise | Local (Whisper, Parakeet, Cohere) or BYOK | macOS, Windows, Linux (+rpm, Homebrew) | + simpler, no account anywhere, agent recipes. − meeting transcription, MCP server, public API, Homebrew |
| Spokenly | spokenly.app | Local free unlimited; BYOK free; Pro $9.99/mo (`verify`) | Local (Whisper, Parakeet) or cloud; "Local Only Mode" | macOS, Windows, Linux, iPhone | + fully open, no account, cleanup local by default. − MCP voice input so agents can *ask* the user by voice |
| Ski | heyski.io (Show HN 2026-07-30, 15 pts) | Free with registration; AgentCall metered | Local STT+TTS | macOS 14.4+, Windows, Linux .deb | + no registration, works in any app not via a per-agent skill, MIT. − speaks replies back; two-way loop we do not have |
| Bol | github.com/abhiyan100/bol (1 ★, created 2026-09-01) | Free, MIT | Local (≈2.5 GB models) | macOS Apple Silicon only | + cross-platform, no always-open mic. − wake-word hands-free + spoken summaries |

Rule for every later surface: this table is the only place competitor numbers appear; the site quotes competitors only verbatim, with link and fetch date.

---

## 3. AC2 — Rebrand decision

### 3.1 Framework

Six criteria. 1–5 are pass/fail with evidence; 6 is context.

1. **Clean namespace** — no software product with the same name; GitHub org/repo, npm, `.dev` + `.app` obtainable; no obvious software/voice trademark.
2. **Says the job** — a stranger can guess "voice → text → agent", or at least "voice".
3. **Pronounceable and spellable once heard** (say it on a podcast; does the listener type it right?).
4. **Distinct in the coding-agent space** — no collision with agent/LLM/terminal tools (`Mutter` = GNOME compositor; `Whisper*` = OpenAI's model; `Speakeasy` = API tooling).
5. **Migration cost ≤ benefit** — cost side is §3.4; benefit is criteria 1–4 relative to "Earheart".
6. **Equity at stake** — at 29 stars and tens of downloads, equity ≈ 0: renaming has never been cheaper and never will be again. This cuts both ways: cheap to change, and no evidence the name is hurting.

**Decision rule:** rename only if a candidate passes criterion 1 at least as well as Earheart **and** is strictly better on 2 with no loss on 3–4. Otherwise keep and spend the effort on positioning, which is where the research says the gap is.

### 3.2 Availability method (2026-10-11)

GitHub: `gh api users/<n>` (200 = account exists; 404 = free) and `gh api "search/repositories?q=<n>+in:name"` (collision count). npm: `GET registry.npmjs.org/<n>` (404 = free). Domains: Verisign RDAP `rdap.verisign.com/com/v1/domain/<n>.com`; Google Registry RDAP `pubapi.registry.google/rdap/domain/<n>.{dev,app}` (404 = unregistered, 200 = registered). Trademark sanity: web search of Justia/USPTO mirrors for the finalists; **`unknown:` USPTO TESS/TSDR and EUIPO eSearch are JavaScript applications that could not be driven** — a formal search is a gate before registering any fallback. Both planners ran the checks ~06:00 UTC; the coordinator re-ran every finalist row at ~06:20 UTC with identical results.

### 3.3 Shortlist

Every plain English word tried by either planner (hark, sotto, parley, utter, murmur, dictum, hearsay, earshot, hearken, parlance, diction, outloud, intone, spiel, sayto, hushkey, voicebar, voicekey, utterly, hearme, hotmic, saycode, sayso, earworm, loudly, overheard, larynx, loqui, dicta, blurt, holler, utterance, voxkey, spoken, sayable — ~35 in total) is registered on `.com` and `.dev` and (with one or two exceptions) `.app`, has a GitHub account, and most are taken on npm. Only compound coinages clear criterion 1.

| Candidate | Meaning / rationale | GitHub user/org | Repos named | npm | .com | .dev | .app | Trademark sanity |
|---|---|---|---|---|---|---|---|---|
| **Earheart** (keep) | ear + heart; the icon already draws a heart as a waveform (`scripts/gen-icons.js:2-3`); nod to Amelia Earhart = taking off. Weakness: heard as "Earhart"; SEO shared with Amelia | taken — dormant personal account since 2012, 1 repo (product lives under `cleanunicorn/` anyway) | 5, none a software product (an Amelia bio, a heart-rate UI, `roundData`) | **free** | registered since 2000 (GoDaddy, exp. 2027-03-01; unrelated party) | **free** | **free** | Justia search: no software/app mark; nearest are EarMaster (music), eHeart (medical app) — different names |
| **Talkpaste** | literal: talk → paste; zero ambiguity; a utility name, not a brand | **free** | 2 | **free** | registered | **free** | **free** | none found; "SpeakPaste" iOS app is a different name — `unknown:` formal |
| **Vocable** | "a word that can be spoken"; dictionary word, says voice without saying voice; the only *brandable* candidate | org taken (2016, 0 repos) → repo would be `cleanunicorn/vocable` | — | **free** | registered | **free** | registered | `unknown:` not searched |
| **Voicepress** | press (hotkey) + voice: "press, speak, press" | **free** | 7 | **free** | registered | **free** | registered | none identical; adjacent "PowerPress" mark (RawVoice), "VocalPress" 2011 WP project |
| **Promptvoice** | literal: voice for prompts; SEO-friendly, generic, hard to own | **free** | — | **free** | registered | **free** | **free** | `unknown:` |
| Promptear | ear for prompts; agent-specific | taken | 8 | free | registered | free | free | none found |
| Voicebar | names the UI (`DESIGN.md:184`); descriptive | taken (2026-07, 0 repos) | 17 | free | registered | free | registered | descriptive, hard to own |
| Speakey | speak + key | taken | 8 | free | registered | free | registered | risk: Speakeasy (API tooling) — fails criterion 4 |
| Saykey | say + hotkey | taken | 6 | free | registered | free | registered | `unknown:` |
| Intone | "speak with a tone"; short | org taken | — | free | registered | registered | registered | `unknown:` |
| Outloud | "say it out loud" | taken | — | free | registered | registered | registered | `unknown:` |
| Earshot | keeps the "ear" lineage | taken | — | free | registered | registered | registered | **conflict:** EARSHOT filings by Auril AI LLC (2024, software) and Evzdrop Inc (2013); "Earshot Live Transcription" iOS app — reject |
| Hotmic | "hot mic" | taken | 44 | free | registered | registered | registered | connotes being overheard — contradicts the privacy claim; cautionary row |

### 3.3b Second batch of candidates (manager re-check, 2026-10-11 ~09:45 UTC)

Same method as §3.2 (`gh api users/<n>`, npm registry, Google RDAP for .dev/.app, Verisign RDAP for .com). GitHub user matters least — the repo lives under `cleanunicorn/` regardless. **No trademark search run on any row below.**

| Candidate | Idea | GitHub user | npm | .dev | .app | .com | Verdict |
|---|---|---|---|---|---|---|---|
| Voxpaste | Latin *vox* + paste | free | free | free | free | taken | clear; shorter, slightly more brandable Talkpaste |
| Utterkey | utter + hotkey | free | free | free | free | taken | clear; names the gesture; odd to spell |
| Promptvoice | voice for prompts | free | free | free | free | taken | clear; generic, hard to own |
| Dictaprompt | dictate + prompt | free | free | free | free | **free** | clear incl. .com; clunky aloud |
| Heartone | heart lineage | taken | free | free | free | taken | says nothing about voice |
| Pasteby | paste + by | taken | free | free | free | taken | hides the voice part |
| Sayprompt | say + prompt | free | free | taken | taken | taken | domains gone |
| Speakpaste | speak + paste | free | free | taken | taken | taken | domains gone; "SpeakPaste" iOS app |
| Vocalkey | vocal + key | taken | free | free | taken | taken | loses .app |
| Voiceloop | voice loop | taken | free | free | taken | taken | loses .app |
| Whisperkey | whisper + key | taken | free | taken | free | taken | borrows OpenAI's model name — reject |
| Saidso / Saidit | "said so" | taken | free | taken | taken | taken | domains gone |
| Mouthpiece, Oratio, Lokey, Speakeasy, Earwig | — | taken | mostly taken | taken | taken | taken | reject |

**Ranking across §3.3 and §3.3b:** 1. Earheart (keep). 2. Vocable (brandable word). 3. Voxpaste / Talkpaste (name does the explaining). Before registering any non-Earheart name: USPTO/EUIPO search and `gh api "search/repositories?q=<n>+in:name"` collision count.

### 3.4 Recommendation

**Keep "Earheart".** It is the only candidate that passes criterion 1 as well as the best coinage (npm free, `.dev` + `.app` free, no competing software, no trademark found) while beating every coinage on criteria 3–4 (a real-sounding proper name, not a feature description). Criterion 5 is decisive: the rename cost is measurable and user-facing (§3.5 — a mandatory bridge release, ~5 GB of models to migrate, Linux shortcuts that silently break, a GitHub redirect to protect) and the benefit is near zero because the namespace is already clean. The weaknesses — spelled "Earhart" by ear, SEO collision with Amelia — are handled by owning `earheart.dev` + `earheart.app`, always pairing the name with the tagline, and never styling it "EarHeart". The icon stays; under a rename it would be orphaned and must be redrawn (`scripts/gen-icons.js`).

**Fallbacks if the user wants a rename anyway:** **1. Talkpaste** — the cleanest namespace of all 35 checked (GitHub user, npm, `.dev`, `.app` all free; says the job; trade: memorability for clarity). **2. Vocable** — the only brandable option (`vocable.dev`, npm free, repo under `cleanunicorn/`; loses `.app` and the GitHub org name). Before registering either: run a real USPTO/EUIPO search (`unknown:` today).

### 3.5 AC3 — Rename migration plan (conditional on Q1 = rename)

If **keep** is chosen, this section collapses to zero app changes.

**Load-bearing name sites** (the remaining ~500 lines are copy that a reviewed `sed` sweep updates; the `*-contract` tests catch drift):

| Where | Evidence (path:line) | Why it is load-bearing |
|---|---|---|
| Package name | `package.json:2` (also `:4` description, `:11` author, `:14` homepage, `:17` repository) | Electron `app.name` in dev → userData directory name in dev |
| productName | `electron-builder.yml:2` (also `:3` copyright, `:45` synopsis, `:48` `StartupWMClass: earheart`, `:75-81` macOS usage strings) | names `Earheart.app`, `Earheart-Setup-x.exe`, `Earheart-x.AppImage`, `earheart_x_amd64.deb` (`README.md:159`; asserted in `test/update-feed.test.js:19-45`, `test/updates.test.js:53-55, 650-655`), the Windows install dir (`test/update-feed.test.js:164`), **and the packaged userData directory** (`~/.config/Earheart`, `~/Library/Application Support/Earheart`, `%APPDATA%\Earheart`) |
| appId / bundle id | `electron-builder.yml:1`; `main/output/mac-permissions.js:21-23` (`MAC_BUNDLE_ID`, "must match appId… a unit test holds them together"); `.github/workflows/release.yml:170` (`grep -q 'identifier "dev.cleanunicorn.earheart"'`); `CONTRIBUTING.md:108` | macOS TCC files Accessibility + Automation grants under this id; NSIS treats a new appId as a new program |
| Updater feed | `main/services/update-feed.js:11-13` (`REPO_SLUG`, `DEFAULT_FEED_BASE`, `RELEASES_PAGE`); `test/update-feed.test.js:141` | existing installs poll `github.com/cleanunicorn/earheart/releases/latest/download/latest*.yml` |
| **macOS swap basename** | `main/updates.js:717` `installMac`, `:737` `const newBundle = path.join(staging, path.basename(bundle))`, `:739` `throw new Error("Update archive did not contain the app bundle")` | **a renamed `.app` inside the update zip is not found by the old updater → every existing macOS user's auto-update fails.** Needs the bridge release first |
| macOS asset suffix check | `main/services/update-feed.js:64` (`-arm64-mac.zip`) | suffix only — survives a rename, no action; asset *prefix* is irrelevant because the path comes from `latest-mac.yml` |
| Swap/relaunch script markers | `main/updates.js:698` (`# earheart update swap`), `:771` (`# earheart update relaunch`); asserted `test/updates.test.js:409, 604` | internal; rename optional |
| Linux desktop entry / autostart | `electron-builder.yml:48`; `main/autostart.js:18` (`earheart.desktop`), `:55` (`Name=Earheart`), `:58` (`Icon=earheart`) | stale autostart entry after rename |
| CLI flags | `main/main.js:23-36`; `main/hotkeys.js:5-6`; `main/pipeline.js:362, 370`; `renderer/settings.html:78, 93, 108`; `renderer/wizard.html:99`; `README.md:77, 133, 438, 444`; `docs/agents.md:85-96`; asserted `test/overlay-contract.test.js:206, 309` | users' GNOME/KDE shortcuts and foot pedals call `earheart --toggle`; the binary name follows productName |
| Preload bridge & role flag | `preload.js:105` (`--earheart-role=`), `:124` (`window.earheart`); `main/windows.js:55`; `main/window-guard.js:2`; asserted `test/ipc-contract.test.js:15, 45, 62, 97`, `test/windows.test.js:467` | internal, not user-visible — **leave unchanged** |
| Env vars | `EARHEART_UPDATE_FEED` (`main/updates.js:23, 105-106`; `CONTRIBUTING.md:200`; `test/updates.test.js:161-162`), `EARHEART_LLAMA_GPU` (`main/engines/engine-worker.js:183`), `EARHEART_ENGINE_ROOT`, `EARHEART_MAC_SIGN_*` (`build/mac-sign.js`, `release.yml`), `EARHEART_NET_TESTS` | users' scripts and CI |
| Worker service names, log prefixes | `main/engines/index.js:21-22` (`earheart-stt`, `earheart-cleanup`), `main/engines/host.js:37`, `main/main.js:169-184` (`[earheart]`; asserted `test/main-lifecycle.test.js:338`) | internal; rename optional |
| Notification, tray, window titles | `main/setup-notices.js:19-49`; `main/tray.js:72, 96, 137-140`; `main/windows.js:428, 444`; `main/pipeline.js:337, 528, 564, 589`; `main/updates.js:140-146`; `main/output/deliver.js:38, 129, 137`; asserted `test/main-lifecycle.test.js:236, 299, 316`, `test/windows.test.js:494-495`, `test/setup-notices.test.js:111, 266, 278` | user-visible copy; tests pin the strings |
| Log file | `main/util/logger.js:99` (`earheart.log`); `.github/ISSUE_TEMPLATE/bug_report.yml:96`; `CONTRIBUTING.md:352` | support docs |
| Legacy temp sweep | `main/updates.js:828, 864` (`earheart-update`) | **keep the old literal** — it cleans up *old* paths |
| Python companion | `stt-server/pyproject.toml:2, 25, 32` (`earheart-stt`, `earheart_stt`); `Makefile:113, 117`; `.github/workflows/ci.yml:151` | separate distributable; default keep (Q4) |
| Repo slug in docs/templates | `.github/ISSUE_TEMPLATE/config.yml:4-10`; `docs/agents.md:67`; `README.md:514-515` (raw star-history URLs); `package.json:14, 17` | GitHub redirects, but the updater and the star-history embed must be re-pointed |
| Design-system artefacts, product docs | `DESIGN.md:2, 180`; `.impeccable/design.json:4, 148, 154`; `PRODUCT.md:139-141`; `test/settings-secrets.test.js:248, 265` (uses "Earheart" as a dictionary word) | copy |

**What breaks for existing users without mitigation:** (1) macOS auto-update fails at the basename check (`updates.js:737-739`); (2) if appId changed: Accessibility/Automation grants lost (repair flow exists: `mac-permissions.js:103`, `deliver.js:38`); (3) settings, history, dictionary, ≈5 GB of models (`README.md:261-262`) left in the old userData dir → first run looks fresh and re-downloads; (4) Windows: NSIS behaviour with same appId but new productName is **unverified** (install dir contains productName, `update-feed.test.js:164`) — side-by-side install possible; (5) Linux: stale `earheart.desktop` and users' `earheart --toggle` shortcuts point at a binary that no longer exists; (6) anyone creating a repo named `cleanunicorn/earheart` would hijack the redirect old clients follow; (7) `unknown:` whether `releases/latest/download/*` and `raw.githubusercontent.com` follow a repo rename — test with `curl -I` after renaming.

**Ordered migration — one bridge PR, then one rename PR:**

**PR R0 — `fix: accept a renamed app bundle when updating`** (patch release under the old name; *the one justified split*: it must be installed on users' machines before R1 exists).
1. `main/updates.js` `installMac`: locate the single `*.app` directory in `staging` instead of `path.basename(bundle)`; install it as the new name, remove the old bundle, relaunch the new path. Linux AppImage and NSIS paths unchanged. Test: extend `test/updates.test.js` (file:// feed via `EARHEART_UPDATE_FEED`, `:161-162`; mac fixtures `:202-240, 573-604`) with a zip whose bundle name differs. **Risk: low. Rollback: revert.**
2. Keep `REPO_SLUG` as is (redirect covers it until confirmed).
3. Wait ≥ one update cycle (the app checks on startup and twice a day, `README.md:187`).

**PR R1 — `feat!: rename Earheart to <Name>`** (major bump; the title becomes the in-app release note, so write it for users).
1. **Keep `appId: dev.cleanunicorn.earheart` unchanged** (Q3; preserves TCC grants and NSIS identity; invisible to users). Risk if changed: every macOS user re-grants.
2. `package.json:2,4,11,14,17`; `electron-builder.yml:2,3,45,48,75-81`; `build/`, `release.yml` bundle/zip names; `test/release-contract.test.js:225` — the contract tests fail until updated; that is the safety net.
3. Runtime strings (table above) and the tests that pin them. **Leave `window.earheart`, `--earheart-role`, swap/relaunch markers, service names unchanged** (halves the diff; nothing user-visible).
4. **userData migration** (`proposed: main/migrate-user-data.js`): on startup, if `app.getPath("userData")` does not exist or is empty and the sibling `<appData>/Earheart` exists on the same volume → `fs.renameSync(old, new)` (atomic, no 5 GB copy) and write `<new>/migrated-from.json` `{ "from": "Earheart", "version": "<R1 version>", "at": "<ISO>" }`; on `EXDEV`/failure → per-file copy of `settings.json`, `history.json`, then `models/`, log and continue. Unit test with `mkdtemp` + `t.after` cleanup. **Rollback:** a `revert:` release reads `migrated-from.json` and renames the directory back; the old directory is never deleted.
5. **Autostart**: `main/autostart.js` removes `earheart.desktop` / the old login item and re-registers under the new name when the setting is on.
6. **Env vars**: accept both `EARHEART_*` and `<NEW>_*` for one minor release, then drop the old (documented in `CONTRIBUTING.md`).
7. **First-launch setup notice** (`main/setup-notices.js` pattern): "Shortcuts bound to `earheart --toggle` must point at `<new> --toggle`".
8. `stt-server`: keep `earheart-stt` by default (Q4); if renamed, keep a deprecated console-script alias for one release.
9. Docs: README, CONTRIBUTING, AGENTS, PRODUCT (Brand Commitments), DESIGN (title), issue templates, `.impeccable`. New icon via `scripts/gen-icons.js`; `make screenshots`.
10. **GitHub, same day:** rename the repo; immediately create an **archived placeholder** `cleanunicorn/earheart` whose README points at the new slug (protects the redirect); `curl -I` an old release-asset URL; only then change `REPO_SLUG` (`update-feed.js:11`); set `homepage`; re-run the star-history workflow.

**Release gate for R1:** `make test` + all four smoke targets green; `git grep -i earheart` returns only the allowed compatibility literals (legacy temp sweep, env-var aliases, internal identifiers); an R0 → R1 auto-update via `EARHEART_UPDATE_FEED=file://…` on **all three OSes** (Windows specifically to settle the NSIS question).

**Rollback story.** R0 is independently safe. If R1 misbehaves: publish R1.1 under the new name (the feed is forward-only), or re-publish the last old-name build as a higher version under the old slug so old-name clients converge; renamed clients are told to reinstall. TCC untouched because appId never changed; userData renamed back by the marker. What code cannot restore: users who re-bound shortcuts, and the GitHub rename itself (reversible, but the redirect flips).

---

## 4. AC4 — Website strategy

### 4.1 Goals and success metrics (no targets invented)

- **Stars** — baseline **29** (2026-10-11). The existing `star-history` workflow renders the chart.
- **Release asset downloads** — `GET /repos/cleanunicorn/earheart/releases` → `assets[].download_count`; baseline v0.38.0 = 16 total (2026-10-11); record the launch-day baseline per version.
- **Referrers** — GitHub Insights → Traffic (14-day window; screenshot weekly during launch).
- **Qualitative** — issues/discussions opened by non-contributors per week.
- **Site traffic — none at launch** (Q5). The brand is "no telemetry"; the site states its own policy on `/privacy`.
- **Rule:** report weekly deltas in a Discussions note; set targets only after four weeks of baseline.

### 4.2 Site map

```
/            landing: hero (bar replica) · why not the built-in /voice · how it works · agents · built for prompts · never loses your words · Linux · honest footnotes · download · FAQ · footer
/download    OS-detected primary + full asset table (from release.json) · macOS "Open Anyway" · Linux xdotool/wtype · Windows portable · Intel-Mac note · checksums
/agents      the recipes from docs/agents.md, one card per tool (Claude Code, Codex, Cursor/VS Code/JetBrains, web chats, Wayland, foot pedal)
/privacy     data flow: mic → overlay → engines → paste; what leaves (nothing by default) and when it would (if you repoint a stage); engine badges Private Teal / External Amber
/changelog   rendered at build from the app repo's CHANGELOG.md (generated from PR titles — never hand-edited)
/404  sitemap.xml  robots.txt  og.png  favicon.svg
```
Docs stay in the app repo and are linked, not mirrored — one source of truth.

### 4.3 Page outlines with draft copy

**/ Landing**
1. **Hero.** Eyebrow: `Open source · MIT · Windows, macOS (Apple Silicon), Linux`. H1: **Talk to your coding agents.** Sub: *Press a hotkey, speak the whole prompt, press again — it lands in Claude Code, Codex, Cursor, or whatever has focus. Speech-to-text and cleanup run on your machine. Your audio and prompts never leave it.* Primary CTA: **Download for macOS / Windows / Linux** (OS-detected label; filled-white pill; links to the matching asset from `release.json`; sibling link "All releases" → `releases/latest`). Secondary: **View on GitHub ★ <count>** (count rendered at build from the API — never typed). Under the buttons: *Free. No account. Two model downloads on first run (≈5 GB).* Hero visual: the real bar re-implemented in HTML/CSS from `renderer/tokens.css` values (the overlay is already HTML — `renderer/overlay.html/.css`), cycling recording → processing → done with the real copy from `docs/screenshots/overlay-*.png`; `prefers-reduced-motion` freezes it on the done frame.
2. **Why not the built-in `/voice`?** Three columns — *Built-in voice* (cloud; claude.ai account; one agent; not for API-key/Bedrock/SSH) · *Earheart* (on-device; any agent and any app; API-key/Bedrock/SSH users included; cleanup styles + dictionary) — with the Anthropic sentence quoted verbatim, linked, and **dated** ("docs fetched 2026-10-11"). No speed or accuracy claims. Codex is not mentioned until verified.
3. **How it works.** Press / speak / press — crops of `overlay-recording.png`, `overlay-processing.png`, `overlay-done.png`; pipeline line: hotkey → Parakeet TDT 0.6B v3 on-device → Qwen3 4B Instruct 2507 on-device → paste; *or repoint any stage at an OpenAI-compatible endpoint (Ollama, llama.cpp, Groq…)* (`README.md:370-392`).
4. **Works with every agent.** Names as text, no third-party logos: Claude Code, Codex CLI, Cursor, VS Code chat, JetBrains, claude.ai / ChatGPT web, Aider, Gemini CLI — each linking to `/agents#…`. *No plugin, API key or account. It pastes where your cursor is; you press Enter.*
5. **Built for spoken prompts.** Clean / Verbatim / Polished, dictionary for identifiers, editable system prompt, live transcript, pause and discard hotkeys (`README.md:106-147`).
6. **Never loses your words.** Cleanup fails → raw transcript; paste fails → clipboard; history keeps it (AGENTS.md Golden rule 8).
7. **Linux is a first-class citizen.** AppImage + deb, X11 and Wayland, `earheart --toggle` for GNOME/KDE shortcuts and foot pedals, self-updating AppImage.
8. **Honest about the rough edges.** Signed, not notarized (one approval); Linux auto-paste needs `xdotool`/`wtype`; Intel Macs end at v0.33.9 (`README.md:159`); *it pastes — it doesn't submit (yet)* with the issue link (`README.md:100-103`). This section *is* the brand voice (`PRODUCT.md:145-149`).
9. **Star history** — the real SVGs from the `star-history` branch in a light/dark `<picture>`.
10. **FAQ (6–8).** Does it submit? (No.) Offline? (Yes, by default.) Languages? (25 — Parakeet v3, `PRODUCT.md:107`.) Own server / Ollama? (Yes.) Intel Mac? (v0.33.9 last.) Telemetry? (None.) How big is the download? (≈5 GB of models on first run.)
11. **Download repeat + footer:** GitHub · Releases · Changelog · Discussions · Issues · Contributing · Privacy · MIT.

**/download** — OS-detected primary + table (Windows installer/portable, macOS dmg/zip, Linux AppImage/deb) from `release.json`; "Apple could not verify…" → Open Anyway steps + `xattr` command (`README.md:454-455`); Linux install lines; "Updates come from GitHub releases with checksum verification" (`README.md:185-212`).
**/agents** — `docs/agents.md` re-laid out as cards; keep the terminal-newline issue link (`docs/agents.md:67`).
**/privacy** — the README "Privacy" section (`README.md:484-502`) plus a simple diagram and "what changes if you repoint a stage"; the site's own policy (no analytics at launch).
**/changelog** — `CHANGELOG.md` fetched at build.

### 4.4 Visual direction — evolve DESIGN.md, do not depart

Reasons: the bar is the product and the only recognisable image we own; coral-on-ink is already distinctive against the category (Superwhisper/Wispr/Aqua/Willow are light and photographic; Handy minimal light; Ski dark + violet). The site is **dark-only** at launch so product screenshots look like the product; `--text-dim` on `--ink` is already ≥ 4.5:1 (`renderer/tokens.css:13`).

- **Palette:** `--ink #18181b`, `--text #f4f4f5`, `--text-dim #a1a1aa`, `--accent #fb4d5c`, `--ok #34d399`, `--err #f87171`, hairlines `rgba(255,255,255,.1)` — copied from `renderer/tokens.css:10-19` and guarded by a tokens-contract test; a slightly darker page background (`#0f0f11`) behind the ink bar so the bar reads as an object.
- **One Voice Rule carried over verbatim** (`DESIGN.md:312-316`): coral only where the voice is live — capture dot, waveform, progress fill. **The primary CTA is the filled-white pill** (`DESIGN.md:521-524`), given prominence by size and position, not colour. Private Teal / External Amber only on the engine badges on `/privacy` (`DESIGN.md:306-309`). No drop shadows (`DESIGN.md:452-460`).
- **Type:** `system-ui` stack + `ui-monospace` for commands (`DESIGN.md:354`): zero webfont requests, instant paint, no third-party call that would contradict the privacy page. What the site may do that the app may not: display sizes far above the app's 16 px chrome cap (`DESIGN.md:361` is about window chrome), a 72–96 px hero measure, generous whitespace.
- **Motion:** CSS-only bar animation; `prefers-reduced-motion` respected.
- **Imagery:** real screenshots only; no illustrations, stock, AI imagery or logo walls.
- Deferred: a `prefers-color-scheme: light` variant with the tokens inverted; a self-hosted OFL variable font.

### 4.5 Assets — existing vs to produce

**Exists:** `assets/icon.png` (512 px; favicon/apple-touch after resize), tray PNGs, nine screenshots in `docs/screenshots/` (regenerable with `make screenshots`), star-history SVGs (`origin/star-history`), README copy, `docs/agents.md`, `CHANGELOG.md`, the overlay's own HTML/CSS as the replica's source.
**To produce:** (1) **demo** — one 30–40 s screen capture dictating a real prompt into Claude Code in a terminal, then Cursor (redact repo names; captions; no voice-over claims) as MP4 ≤ 6 MB, cut into a 10 s GIF for the README and X; a 6 s muted hero loop is optional; (2) **OG image** 1200×630 rendered from the bar replica (committed PNG, or a script in the pattern of `scripts/gen-icons.js:11-45`); (3) **SVG mark + wordmark + favicon set** — a one-time port of the SDF heart-waveform (`gen-icons.js` is PNG-only); (4) **three real agent screenshots** with the bar visible (terminal/Claude Code, Codex, Cursor) — `docs/screenshots/` has none with an agent window.

### 4.6 Stack, repo layout, hosting, CI

**Stack: zero-dependency static site.** Hand-written HTML, one CSS file, ≤ 200 lines of vanilla JS (OS detection, reduced-motion guard, bar animation), and a ~120-line `build.js` on `node:fs` that stamps the shared header/footer, inlines `release.json`, pulls `CHANGELOG.md`, and writes `dist/`. Rationale: 0 new dependencies, nothing to upgrade, a page is a file, the same agents that maintain the app repo (plain JS, no bundler, `node --test`) can maintain this. Rejected: Astro (good fit for agents, but a dependency tree and a toolchain to keep green for five pages — astro@7.3.8 on 2026-10-11); Next/Nuxt (overkill); Hugo/Jekyll (second language toolchain).

```
earheart-site/                       proposed: github.com/cleanunicorn/earheart-site (rename → <name>-site)
  AGENTS.md                          how to work here (mirrors app-repo rules; the claims policy)
  package.json                       no dependencies; scripts: build / test / dev (python -m http.server or node)
  build.js                           node:fs — templates, release.json, CHANGELOG.md → dist/
  site/
    index.html download.html agents.html privacy.html changelog.html 404.html
    styles.css                       tokens copied from renderer/tokens.css + page styles
    site.js                          OS detection, bar animation, reduced-motion
    assets/                          mark.svg wordmark.svg favicon.* icon.png og.png screenshots/ demo.mp4 demo.gif
  data/release.json                  committed last-known release (version, date, per-OS asset names/URLs, star count)
  scripts/fetch-release.mjs          GitHub API → data/release.json; keeps the committed file when offline/rate-limited
  scripts/sync-assets.mjs            copies docs/screenshots + CHANGELOG.md from a pinned app-repo commit
  test/claims.test.js                build fails on: /\d[\d,]*\+?\s*(users|downloads|developers|teams)/i, /\d+x faster/i,
                                     /%\s*(more|faster|accurate)/i, "trusted by", "as seen", "testimonial", literal "★ \d" outside the build-rendered element;
                                     allowlist: "faster than realtime"
  test/links.test.js                 every internal href resolves to a built page; every <img> has alt; external URLs checked weekly, not per PR
  test/tokens-contract.test.js       --ink/--accent/--text/--text-dim equal the app's renderer/tokens.css values at the pinned commit
  .github/workflows/ci.yml           node 22: node build.js && node --test; uploads dist as a PR artifact
  .github/workflows/deploy.yml       on push to main + daily cron: fetch-release → build → test → actions/upload-pages-artifact → deploy-pages
  CNAME                              earheart.dev (added at M3)
  LICENSE                            MIT for code; screenshots/video © contributors
```

**Hosting: GitHub Pages** — same account as the code and the updater, free, automatic HTTPS for custom domains (`cleanunicorn.github.io` already resolves, so the project URL `cleanunicorn.github.io/earheart-site` works before DNS). Cloudflare Pages (PR previews, free analytics) noted as the alternative only if PR previews ever matter. **CI:** build + tests on every PR; deploy on `main`; daily cron so `/download` follows releases without a cross-repo token (lag ≤ 24 h, mitigated by the "All releases" link; `repository_dispatch` from `release.yml` is deferred).

**Domain paths.** *Keep:* register **earheart.dev** (primary; `.dev` is HSTS-preloaded → HTTPS-only) and **earheart.app** (301) — both unregistered on 2026-10-11 at 06:20 UTC; do not pursue `earheart.com` (registered 2000, unrelated party, exp. 2027-03-01). *Rename:* `<name>.dev` primary, `.app` where free (Talkpaste: both free; Vocable: `.dev` only). DNS: apex `A`/`ALIAS` → Pages IPs, `www` CNAME, per docs.github.com (fetched 2026-10-11). Then `package.json:14` and `electron-builder.yml:45` synopsis point at the site (M5).

---

## 5. AC5 — Presentation and launch plan

### 5.1 Messaging hierarchy

- **Lead:** *Talk to your coding agents. Your audio and prompts never leave your machine.*
- **Supporting truths, in order** (`PRODUCT.md` Positioning): (1) one hotkey, every agent and app, no integration or account; (2) both models in-process — and here is the sentence from Anthropic's docs that says the built-in one is cloud; (3) tuned for prompts: Clean/Verbatim/Polished, dictionary, editable prompt; (4) never loses your words; (5) open, MIT, repoint any stage; (6) Linux first-class.
- **Honest limits always one scroll away:** pastes, doesn't submit; signed not notarized; Wayland shortcut recipe; ≈5 GB first-run download.
- **Never:** speed/accuracy numbers, user counts, "loved by", comparisons that need numbers we do not have.

### 5.2 Audience angles

| Audience | Angle (one sentence) | Proof to show |
|---|---|---|
| Claude Code users | `/voice` streams audio to Anthropic and needs a claude.ai login; Earheart works for API-key/Bedrock/SSH setups and in every other app, on your machine. | the dated doc quote; 10 s GIF dictating into the Claude Code TUI; the "one paragraph, no line breaks" caveat (`docs/agents.md:67`) |
| Codex / Cursor users | One hotkey for all your agents instead of one voice feature per tool; Verbatim mode keeps identifiers intact. | GIF into Cursor chat; dictionary screenshot (`docs/screenshots/settings.png`) |
| Privacy-conscious / local-LLM devs | Parakeet + Qwen3 4B in-process — no network hop, no localhost socket (`README.md:487`); or repoint to your Ollama. | Settings engine badges; `/privacy` |
| RSI / motor users | Press, speak, press; pause and discard without the mouse; foot pedal via `--toggle`; every flow keyboard-first. No medical claims. | `overlay-paused.png`; `docs/agents.md:93-96` |
| Linux users | AppImage + deb, X11 and Wayland, GNOME/KDE shortcut recipe, self-updating AppImage. | Wayland shortcut screenshot; terminal GIF on a Linux desktop |

### 5.3 Channel plan (each step gated on the previous being live)

| # | Channel | When | Prepare | Measure |
|---|---|---|---|---|
| 0 | **Site live + README refresh** (M1, M5): hero GIF, site link, `homepage` field; `/voice` subsection if Q8 = yes | prerequisite | OG image verified in a link-preview checker; launch-day baselines recorded | stars, download_count baseline |
| 1 | **Awesome lists** — `hesreallyhim/awesome-claude-code` (≈55.4k ★): **web issue form only — "Do not open a PR"** (CONTRIBUTING.md fetched 2026-10-11); requires ≥14 days old with ongoing commits **or** ≥100 stars (Earheart qualifies on age/activity); one resource per submission; one-line description that states what it does, no emoji; `unknown:` pick the category from the form's list at submission time. Also `RoggeOhta/awesome-codex-cli` (check its own rules), OpenAlternative, DevHunt | week 1 | one-line description per list | accepted entries; referrers |
| 2 | **Show HN** — title (76 chars, under HN's 80): `Show HN: Earheart – On-device voice dictation for Claude Code, Codex, Cursor`. Precedents (HN Algolia 2026-10-11): Whispering 591 pts (2025-08-18), Yap 104, Ski 15 — titles that say what the thing *is* beat slogans. First comment: why it exists (the long-prompt argument, `README.md:24-29`), what it does **not** do (submit, talk back), the 5 GB caveat, Linux/Wayland honesty, repo link first, site second. Tue–Thu, 14:00–16:00 UTC; be present 6 h | week 2 | demo GIF; first comment drafted; privacy page | points, comments, same-day stars/downloads |
| 3 | **X / Bluesky** — 4-post thread: problem → GIF → the privacy sentence → link | same day as HN | 10 s GIF | stars delta |
| 4 | **Reddit** — r/ClaudeAI, r/LocalLLaMA (lead with the models and repointing), r/cursor, r/linux (Wayland recipe), r/codex if active; one subreddit per day. `unknown:` rules could not be fetched (reddit.com blocked) — **before each post, a human reads the sub's rules and checks: self-promotion ratio, required flair, whether video must be native, whether open-source posts need a specific day** | weeks 2–3 | per-sub framing; GIF; answer "why not /voice" up front | upvotes, referrers |
| 5 | **Product Hunt** — optional (Q7): needs gallery, tagline ≤ 60 chars, a Tuesday/Wednesday slot and a day of replies; the closest comparable listing (Bol) got 2 upvotes and PH sees 500+ launches/day — low expected return for this niche | week 4 or skip | gallery, video | upvotes |
| 6 | **Claude Code / Codex community docs** — `unknown:` no official third-party-tools list; the plugin marketplace's voice entries are MCP/skill plugins, which Earheart is not (`PRODUCT.md:74-77`). Do not pursue until an MCP integration exists. Community Discord showcase channels are the fallback | ongoing | — | — |

**Measurement:** a hand-filled table (date · channel · stars 24 h/7 d · download_count delta · referrers · issues opened) in a weekly Discussions note, numbers from the API only. **Before each channel step: re-fetch the Anthropic `/voice` page and update the quote's date** if it changed.

---

## 6. AC6 — Reference research (all fetched 2026-10-11)

| Site | Borrow | Avoid |
|---|---|---|
| handy.computer | One job, one page ("speak into any text field"); demo video *with full transcript* under it; four one-word sections (Free / Open Source / Private / Simple); sponsors instead of testimonials | Platforms not stated on the page — our eyebrow names all three OSes |
| superwhisper.com | Dedicated "agentic coding" section naming Cursor, Claude Code, Codex; "press ⌥+space to try" interactive prompt | Logo wall + exec testimonials (we have none and will not fake them); the "$849" render shows the cost of unverified numbers |
| wisprflow.ai | Side-by-side raw speech vs cleaned text ("filler identified") — maps onto Clean/Verbatim; platform icons under the CTA | "4x faster than typing" WPM stats — benchmarks we may not make; quota-driven free-tier copy |
| aquavoice.com | Rotating example prompts tied to use cases; "Designed for" app rows; coding section with a terminal graphic | Vendor-run accuracy benchmark; "Get Started on Mac" hides other platforms |
| tryvoiceink.com | Three trust badges in the hero (Private · Open source · Local); "What you say / What you get" panels; FAQ as objection handling | User counts, star ratings, "wall of love" |
| heyski.io | Numbered sections 01–07; a stats strip of *verifiable facts* ("0 bytes uploaded") rather than user counts; dark + one accent | Requires registration — our "no account" is the contrast; PH badge before product value |
| talonvoice.com | Per-OS download buttons visible at once; "Try a command" block | No statement on local vs cloud |
| zed.dev | Download + "Clone source" side by side; platform note under the buttons; a founders' letter as the only social proof | Superlatives without evidence; competing banner CTAs |
| obsidian.md | OS-detected primary download with "More platforms"; demos using the product's own content | Repeated download CTAs padding the page |
| linear.app | Editorial figure labels ("Fig 0.1") on real screenshots; calm type hierarchy; terse copy | Dense repeated mockup/tagline/learn-more pattern; tiny text in mockups |
| raycast.com | Keyboard as the hero motif (our hotkey is the product); feature grid | **No download button in the hero** — we put OS-detected download first |
| bun.sh | Install command as the CTA with OS tabs; code as the visual; comparison table | A dozen benchmark sections — argument by numbers we cannot run |
| tailscale.com | Role tabs (IT / Security / DevOps / Engineering) = our audience angles | Acronym-dense subhead |
| cursor.com | Product video as hero visual | No explanatory subhead; empty `alt` on images (our links test fails on that); macOS-only download |
| ollama.com · lmstudio.ai | LM Studio: "Natively local" as a section, not a footnote; minimal text-led page | Ollama never shows the product in action and puts adoption stats before the "what"; "Get started" that is really sign-up; LM Studio Windows-only button |
| granola.ai | Single "Download for free" with platform list beneath | Same mockup repeated across three sections |
| tauri.app | Tabbed install block = our per-OS tabs | No screenshot of an actual app; long sponsor wall |
| warp.dev | — | Jargon hero |
| ghostty.org | — | `unknown:` page returned only its title to WebFetch twice (client-rendered); re-check in a browser |

### User-supplied references

*Slot — empty. The user said they may send links later.* For each link when it arrives: URL · date viewed · the one pattern to borrow · the one to avoid · which part of §4.3 (hero/sections) or §4.4 (visual direction) it changes. Then re-check decisions D13 (hero) and D15/D16 (visual direction) against them (M7).

---

## 7. AC7 — Honesty guardrails

- Every number in this document is a competitor's (table §2.3, cited and dated, flagged `verify` where not first-hand), a repository fact, or an availability check. Proposed copy contains no users, downloads, testimonials, press, benchmarks or pricing (`PRODUCT.md:159-162`).
- The single performance claim is "faster than realtime on CPU" (`README.md:264`, `PRODUCT.md:107`). "25 languages" is from `PRODUCT.md:107`. "≈5 GB" is from `README.md:261-262`.
- Star and download numbers on the site are rendered from the GitHub API at build time, never typed.
- Competitors are quoted only verbatim with link and fetch date; competitor prices never appear on the site; the Codex built-in voice is not mentioned on the site until verified.
- `test/claims.test.js` fails the site build on the forbidden patterns (§4.6). No "coming soon" sections — a placeholder invites describing roadmap as shipped (`PRODUCT.md:74-77`).
- Validation limits: WebFetch summarises pages with a small model, so visual descriptions and prices may be imperfect; two pages (Ghostty, MacWhisper) did not render; Reddit rules and formal trademark registers are explicit `unknown:`s.

---

## 8. AC8 — Verification of this document

| AC | Observable result | How to verify |
|---|---|---|
| AC1 | lead claim, audiences, 15 comparables with URL/pricing/local-cloud/platforms/±, dated | count rows in §2.3; `curl -s https://code.claude.com/docs/en/voice-dictation \| grep -c "Audio is not processed locally"` → 1 |
| AC2 | 6-criterion framework, 13 candidates × 7 checks, method + date, `unknown:` where blocked, one recommendation + 2 fallbacks | re-run: `curl -s -o /dev/null -w "%{http_code}" https://pubapi.registry.google/rdap/domain/earheart.dev` → 404; `.../registry.npmjs.org/earheart` → 404 |
| AC3 | every load-bearing site cited path:line, breakage list, ordered R0/R1 with risk + rollback | `grep -n "path.basename(bundle)" main/updates.js` → :737; `sed -n 21,23p main/output/mac-permissions.js`; `sed -n 48p electron-builder.yml` |
| AC4 | metrics with baselines, site map, outlines with hero/sub/CTA, visual direction with reasons, assets exist/needed, stack + layout + hosting + CI, both domain paths | §4 |
| AC5 | hierarchy, 5 angles, 6-step sequenced channel table with prep + measure | `printf %s "Show HN: Earheart – On-device voice dictation for Claude Code, Codex, Cursor" \| wc -m` → 76 |
| AC6 | 19 sites with borrow/avoid + empty "User-supplied references" slot | §6 |
| AC7 | no invented numbers in proposed copy | `grep -nE "[0-9][0-9,]*\+? (users|downloads|developers)" merged-plan.md` hits only §2.3/§6 competitor rows and §4.1 API baselines |
| AC8 | `## Progress` first, open decisions last | eyeball |

---

## 9. Open decisions for the user (exact questions)

1. **Keep "Earheart" (recommended), or rename to Talkpaste (fallback 1) or Vocable (fallback 2)?** Evidence §3.3; cost §3.5. Blocks M2, M3, M5 and the site repo name.
2. **If keep: register `earheart.dev` (primary) and `earheart.app` (redirect) now?** Both were unregistered on 2026-10-11 at 06:20 UTC and anyone can take them first. Blocks M3.
3. **If rename: keep `appId: dev.cleanunicorn.earheart` unchanged (recommended) so macOS permission grants and Windows install identity survive, accepting that the internal bundle id keeps the old name?** Blocks R1 step 1.
4. **If rename: also rename the Python companion `earheart-stt` (default: keep)?** Blocks R1 step 8.
5. **Site analytics: none at launch (recommended), or a cookieless counter (self-hosted GoatCounter / Plausible)?** Affects `/privacy` copy only.
6. **Who records the 30–40 s demo and when, and is a Linux-desktop capture wanted as a second clip?** Needs a real Claude Code session with repo names redacted. Blocks M4 and therefore M6 steps 2–5.
7. **Product Hunt: skip, or launch in week 4 after Show HN? And is Show HN posted from your own HN account in the Tue–Thu window?** Blocks M6 step 5.
8. **May the README gain a "Why not the built-in `/voice`?" subsection quoting Anthropic's documentation (dated), or should that comparison live only on the site?** Blocks M5 scope.
9. **Reference links you like** — send them; the slot in §6 is empty (M7).

---

# Appendix A — SWOT records, decision table, merge log

The user asked to see both plans SWOTed and the better plan that results. Section numbers below are A.0–A.5.



Coordinator run, 2026-10-11. Repository checked at commit `95f4597` (`main`), read-only. All web re-checks dated 2026-10-11 ~06:20 UTC unless stated. Plans are referred to only as **Plan A** and **Plan B**.

## A.0 Citation check (step 1)

Every `path:line` behind a load-bearing decision was opened. Results:

| Plan | Citation | Verdict | Actual |
|---|---|---|---|
| A | `package.json:864` (homepage), `:878-885` / `:882-885` (deps) | **wrong** | file is 36 lines; `homepage` at `:14`, deps at `:32-34` |
| A | `electron-builder.yml:53` (`StartupWMClass`) | **wrong** | `:48` |
| A | `README.md:135` ("faster than realtime") | **wrong** | `:264` (also `PRODUCT.md:107`) |
| A | `README.md:173-174` (update check on startup + twice daily) | **wrong** | `:187` |
| A | `README.md:243-245` (≈5 GB models) | **wrong** | `:261-262` |
| A | `README.md:449-452` (Open Anyway) | drift | `:454-455` |
| A | `PRODUCT.md:108` ("faster than realtime") | drift | `:107` |
| A | `main/updates.js` `installMac` `path.basename(bundle)` → "Update archive did not contain the app bundle" | **correct** | `:717`, `:737`, `:739` |
| A | all `main/`, `preload.js`, `renderer/`, `test/`, workflow, `stt-server`, `Makefile`, `CONTRIBUTING.md`, `DESIGN.md` citations (settings.js:199, history.js:12, engines/index.js:21-25, pipeline.js:187, updates.js:524/828/864, logger.js:29-31/99, mac-permissions.js:21-23, update-feed.js:11-13/64, autostart.js:18/55/58, main.js:23-36, hotkeys.js:5-6, settings.html:78/93/108, wizard.html:99, preload.js:105/124, release-contract.test.js:225, update-feed.test.js:141, updates.test.js:161-162, ipc-contract.test.js:45/62/97, windows.test.js:467/494-495, main-lifecycle.test.js:236/299/316, gen-icons.js:2-5, pyproject.toml:2/25/32, Makefile:113/117, ci.yml:151, CONTRIBUTING.md:108/200, DESIGN.md:3-6/184-191/312-316/354-361/452-460/521-524/639-646, PRODUCT.md:52/74-77/127/159-162) | correct | — |
| B | `PRODUCT.md:149-153` (Absent list), `:152-153` | **wrong** | `:159-162` |
| B | `PRODUCT.md:35-40` (lead claim) | **wrong** | `:52` |
| B | `PRODUCT.md:62-66` (Not claimed) | **wrong** | `:74-77` |
| B | `PRODUCT.md:112-116` (no telemetry) | **wrong** | `:127` |
| B | `PRODUCT.md:127-131` (name does not change) | **wrong** | `:139-140` |
| B | `PRODUCT.md:133-136` (tagline) | **wrong** | `:141` |
| B | `PRODUCT.md:74-77` cited for CLI flags | **wrong** | those lines are "Not claimed (yet)"; CLI flag docs are README.md:77/133/438 and docs/agents.md:85-96 |
| B | `PRODUCT.md:9-31`, `:42-57`, `:79-83`, `:89-93`, `:95-98`, `:138-143` | drift | PRODUCT.md headings are at 9 (Users), 50 (Positioning), 79 (Operating Context), 104 (Capabilities), 137 (Brand), 151 (Evidence), 164 (Principles), 180 (Accessibility); B's numbers are consistently 10–17 lines low — content exists, lines are stale |
| B | all `package.json` (:2,4,11,14,17,22,10-13), `electron-builder.yml` (:1,2,3,45,48,75-81), `main/updates.js` (:23,105-106,140-146,160,467-471,698,771,828,864), `main/windows.js:55/428/444`, `engine-worker.js:183`, `host.js:37`, `main.js:169-184`, `test/*` (updates.test.js:53-55/409/604/650-655, update-feed.test.js:19-45/161-196/164, ipc-contract.test.js:15, overlay-contract.test.js:206/309, main-lifecycle.test.js:338, settings-secrets.test.js:248/265, setup-notices.test.js:111/266/278), `docs/agents.md:67/85-96/93-96`, `mac-permissions.js:103`, `renderer/tokens.css:10-19`, `DESIGN.md:5-6/30-77/184-199/193-199`, `gen-icons.js:3`, `.impeccable/design.json:4/148/154`, `bug_report.yml:96`, `config.yml:4-10` | correct | — |

Repo counts: `git grep -il earheart | grep -v CHANGELOG | wc -l` → 102 files, 611 lines (Plan A exact; Plan B's 104/612 came from `grep -rniI`, which also counts untracked files — both acceptable).

### Live re-checks (2026-10-11 ~06:20 UTC)

| Claim | Method | Result | Plans |
|---|---|---|---|
| `earheart` npm free | `GET registry.npmjs.org/earheart` | 404 (free) | A, B correct |
| earheart.com registered; .dev/.app unregistered | Verisign RDAP / Google Registry RDAP | .com 200, .dev 404, .app 404 | A, B correct |
| GitHub user `earheart` taken, dormant | `gh api users/earheart` | User, created 2012-01-14, 1 public repo | A, B correct |
| `search/repositories?q=earheart in:name` | `gh api` | 5 repos: cleanunicorn/earheart, c3Zor/Earhearth, earheart/roundData, fr00tbat/amelia-earheart-biography, HongruiCHEN2006/EarHeartsUI — none a software product | A correct |
| talkpaste: GitHub user free, npm free, .dev/.app free, .com taken | gh api / npm / RDAP | user 404, npm 404, .com 200, .dev 404, .app 404 | A, B correct |
| vocable: GitHub org taken, npm free, .dev free, .app taken | same | Organization (2016, 0 repos), npm 404, .com 200, .dev 404, .app 200 | B correct |
| voicepress: user free, npm free, .dev free, .app taken | same | user 404, npm 404, .com 200, .dev 404, .app 200 | A correct |
| promptvoice: user free, npm free, .dev/.app free | same | user 404, npm 404, .dev 404, .app 404 | B correct |
| Stars: Earheart 29, Handy 33,470, VoiceInk 6,727, epicenter 4,822, awesome-claude-code ≈55.4k | `gh api repos/...` | 29 / 33,470 / 6,727 / 4,822 / 55,408 | A, B correct |
| Latest release | `gh api .../releases/latest` | v0.38.1, published 2026-10-11T06:07Z, 0 downloads yet (B saw v0.38.0 as latest the day before — stale, not wrong) | — |
| Claude Code `/voice` streams audio to Anthropic, needs claude.ai login, not for API key / Bedrock / Agent Platform / Foundry, not in SSH or cloud sessions | WebFetch code.claude.com/docs/en/voice-dictation | verbatim: "Voice dictation streams your recorded audio to Anthropic's servers for transcription. Audio is not processed locally." / "not available when Claude Code is configured to use an Anthropic API key directly, Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry" / "does not work in cloud sessions or SSH sessions" | A, B correct |
| awesome-claude-code submission method | WebFetch raw CONTRIBUTING.md | "ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM TEMPLATE"; "Do not open a PR"; ≥14 days with ongoing commits **or** ≥100 stars; one resource per submission; one-line non-salesy description, no emoji. No "Voice I/O" category named in CONTRIBUTING.md | **A correct; B wrong** ("PR each") |
| Show HN "Whispering" 591 pts 2025-08-18 | HN Algolia API | confirmed | A correct |
| Codex CLI built-in voice | WebSearch | third-party blogs only (danielvaughan.com: v0.105.0 Feb 2026, v0.156.0 Sep 2026 "voice on by default"); no official OpenAI changelog found; one vendor says it is undocumented | B's `unknown:` stands; A's "substitutes" row should not name Codex |
| Both plans' Show HN titles | `wc -m` | A 91 chars, B 90 chars — HN caps titles at 80 | **both wrong** |
| astro latest | npm registry | 7.3.8 | B correct |
| cleanunicorn.github.io | curl | 200 | B correct |

Not re-checked (accepted as the plans state, with their caveats): competitor pricing pages, reference-site visual descriptions, Reddit rules (blocked for both planners), USPTO/EUIPO (`unknown:` in both).

---

## A.1 SWOT records — Plan A

### Strengths (11)

```
id:        A-S1
quadrant:  strength
claim:     Found the hard blocker for a rename: installMac resolves the new bundle by the OLD basename, so a renamed .app in the update zip makes every macOS auto-update fail
evidence:  main/updates.js:737 `const newBundle = path.join(staging, path.basename(bundle))`, :739 throw "Update archive did not contain the app bundle"
affects:   D7, AC3
action:    keep
```
```
id:        A-S2
quadrant:  strength
claim:     Keeping appId under a rename preserves macOS TCC grants and Windows install identity
evidence:  main/output/mac-permissions.js:21-23 (MAC_BUNDLE_ID must match appId); .github/workflows/release.yml:170 greps identifier "dev.cleanunicorn.earheart"
affects:   D6, AC3
action:    keep
```
```
id:        A-S3
quadrant:  strength
claim:     Whole-directory userData rename covers every file the app keeps there (settings, history, models, stt-rtf.json, updates/, logs) without a 5 GB copy
evidence:  main/settings.js:199, main/history.js:12, main/engines/index.js:25, main/pipeline.js:187, main/updates.js:524, main/util/logger.js:29-31
affects:   D8, AC3
action:    keep
```
```
id:        A-S4
quadrant:  strength
claim:     awesome-claude-code rules stated correctly: web issue form only, no PR, ≥14 days active or ≥100 stars, one-line description
evidence:  raw CONTRIBUTING.md re-fetched 2026-10-11 — matches
affects:   D24, AC5
action:    keep
```
```
id:        A-S5
quadrant:  strength
claim:     Zero-dependency static site (HTML + CSS + ≤200 lines JS + ~120-line node:fs build script) — 0 new dependencies, same culture as the app repo
evidence:  AGENTS.md Golden rule 9; package.json:32-34 (two runtime deps); PRODUCT.md:124-126
affects:   D18, D19, AC4
action:    keep
```
```
id:        A-S6
quadrant:  strength
claim:     Primary CTA stays a filled-white pill; coral only on the live voice — follows the design system's One Voice Rule
evidence:  DESIGN.md:312-316 ("filled white primary pill… Never spend coral"), DESIGN.md:521-524
affects:   D16, AC4
action:    keep
```
```
id:        A-S7
quadrant:  strength
claim:     Availability method is reproducible (RDAP + npm + GitHub API) and every result re-ran identically
evidence:  re-checks table above, 2026-10-11
affects:   D4, AC2
action:    keep
```
```
id:        A-S8
quadrant:  strength
claim:     Build-failing honesty test in the site repo (test/claims.test.js) enforces AC7 mechanically
evidence:  PRODUCT.md:159-162; AGENTS.md Testing (node --test)
affects:   D21, AC7
action:    keep (merge regex with B-D17)
```
```
id:        A-S9
quadrant:  strength
claim:     Widest comparable set (12 products + substitutes), including the closest agent-aimed peers Ski, Spokenly, OpenWhispr, and the Whispering→Epicenter lineage
evidence:  §AC1 table, all rows dated 2026-10-11; Handy/VoiceInk/epicenter star counts re-verified
affects:   D2, AC1
action:    keep
```
```
id:        A-S10
quadrant:  strength
claim:     Archived placeholder repo at the old slug prevents a third party from hijacking the redirect old updaters follow
evidence:  main/services/update-feed.js:11-12 (REPO_SLUG baked into DEFAULT_FEED_BASE)
affects:   D7, AC3
action:    keep
```
```
id:        A-S11
quadrant:  strength
claim:     Star count is never typed into copy — rendered from the API — and the AC→verification table gives re-runnable grep/curl lines
evidence:  A-D11, A-D24; PRODUCT.md:159-162
affects:   D13, D30, AC7, AC8
action:    keep
```

### Weaknesses (10)

```
id:        A-W1
quadrant:  weakness
claim:     package.json citations are wrong (:864 homepage, :878-885 / :882-885 deps) — the file has 36 lines
evidence:  package.json:14 (homepage), :32-34 (dependencies)
affects:   D26, AC3, AC4
action:    fix — merged plan cites :14 and :32-34
```
```
id:        A-W2
quadrant:  weakness
claim:     electron-builder.yml:53 cited for StartupWMClass; it is at :48
evidence:  electron-builder.yml:48
affects:   D7, AC3
action:    fix
```
```
id:        A-W3
quadrant:  weakness
claim:     README line numbers drift: :135→264 (faster than realtime), :173-174→187 (update cadence), :243-245→261-262 (model sizes), :449-452→454-455 (Open Anyway)
evidence:  README.md:264, :187, :261-262, :454-455
affects:   D1, D13, AC4, AC7
action:    fix
```
```
id:        A-W4
quadrant:  weakness
claim:     Lead claim "Nothing leaves your machine" is over-broad: the app polls GitHub for updates and downloads models; the README's own true sentence is "your audio and prompts never leave it"
evidence:  main/services/update-feed.js:12 (network poll); README.md:11; README.md:187
affects:   D1, AC1, AC7
action:    fix — hybrid lead claim uses the README's audio-and-prompts wording
```
```
id:        A-W5
quadrant:  weakness
claim:     Proposed Show HN title is 91 characters; HN truncates/rejects over 80
evidence:  `wc -m` on the title; HN submission form limit
affects:   D25, AC5
action:    fix — new 76-char title
```
```
id:        A-W6
quadrant:  weakness
claim:     Client-side fetch of releases/latest from the GitHub API on every visit: 60 req/h is per source IP, so an office or university NAT during a launch spike gets empty buttons; also a flash of unresolved buttons for everyone
evidence:  A-D12; B-D18 (hit the 60/h limit during research); update-feed.test.js:19-45 (asset names are versioned, so a static link cannot be used)
affects:   D20, AC4
action:    fix — adopt B's build-time release.json with committed fallback + daily cron
```
```
id:        A-W7
quadrant:  weakness
claim:     Asserts an awesome-claude-code category "Remote Control, Notifications & Voice I/O" from README headings; CONTRIBUTING.md names no such category and the README heading was not re-verifiable
evidence:  raw CONTRIBUTING.md fetched 2026-10-11 (no category list)
affects:   D24, AC5
action:    fix — "unknown: pick the category from the form's dropdown at submission time"
```
```
id:        A-W8
quadrant:  weakness
claim:     Adds a light theme variant and a self-hosted webfont (plus an open question about it) that no acceptance criterion needs and that make the site diverge from the app's tokens
evidence:  DESIGN.md:354 (system-ui is the brand's type), renderer/tokens.css:13 (dim text already ≥4.5:1 on ink)
affects:   D15, AC4
action:    fix — dark-only, system-ui at launch; light variant and font become deferred follow-ups, not questions
```
```
id:        A-W9
quadrant:  weakness
claim:     userData rollback depends on a "migrated-from" marker and a revert release "that knows to rename back", but neither the marker's content nor the revert step is specified
evidence:  A-D7, §AC3 step 1c
affects:   D8, AC3
action:    fix — merged plan specifies the marker file and the revert step
```
```
id:        A-W10
quadrant:  weakness
claim:     Reddit per-subreddit rules are `unknown:` (fetch blocked) but the plan gives no checklist for the human who must read them
evidence:  A-D21 unknown note
affects:   D24, AC5
action:    fix — add a manual pre-post checklist (self-promo ratio, flair, video hosting rule) per subreddit
```

### Opportunities (10)

```
id:        A-O1
quadrant:  opportunity
claim:     A "Why not the built-in /voice?" section quoting Anthropic's documentation verbatim (B-D2) answers the first objection every Claude Code user has
evidence:  code.claude.com/docs/en/voice-dictation fetched 2026-10-11 — quote verified
affects:   D14, AC1, AC4, AC5
action:    adopt
```
```
id:        A-O2
quadrant:  opportunity
claim:     Build-time release.json with committed fallback and daily cron (B-D18) removes the client-side rate-limit risk
evidence:  B §6.6; GitHub API 60 req/h anonymous
affects:   D20, AC4
action:    adopt
```
```
id:        A-O3
quadrant:  opportunity
claim:     B's tokens-contract test (site tokens equal the app's renderer/tokens.css values) and internal-links test extend A's test/ directory
evidence:  B §6.6 test list; renderer/tokens.css:10-19; AGENTS.md "*-contract.test.js" convention
affects:   D19, AC4
action:    adopt
```
```
id:        A-O4
quadrant:  opportunity
claim:     B's Vocable is the only brandable (non-descriptive) rename candidate with a clean npm + .dev; A's two fallbacks are both descriptive utility names
evidence:  re-check 2026-10-11: npm 404, vocable.dev 404; org taken (0 repos), .app 200
affects:   D4, AC2
action:    adopt as fallback #2
```
```
id:        A-O5
quadrant:  opportunity
claim:     B ran a Justia trademark search (no "Earheart" software mark; EARSHOT has two filings) — stronger sanity check than A's web search
evidence:  B §4.2 trademark column
affects:   D5, AC2
action:    adopt
```
```
id:        A-O6
quadrant:  opportunity
claim:     Homebrew cask / winget manifest — every traction leader in the category has one (Handy, VoiceInk)
evidence:  B deferred list; A's table (Handy row: "Homebrew")
affects:   deferred, AC5
action:    adopt as deferred follow-up
```
```
id:        A-O7
quadrant:  opportunity
claim:     Leave window.earheart and --earheart-role untouched under a rename (B-D9) — halves the diff, nothing user-visible
evidence:  preload.js:105,124; main/windows.js:55; test/ipc-contract.test.js:15,45,62,97
affects:   D9, AC3
action:    adopt
```
```
id:        A-O8
quadrant:  opportunity
claim:     Accept both EARHEART_* and new env var names for one minor release (B-D10) instead of a hard cut
evidence:  main/updates.js:105-106; main/engines/engine-worker.js:183; CONTRIBUTING.md:200
affects:   D10, AC3
action:    adopt
```
```
id:        A-O9
quadrant:  opportunity
claim:     B's hero eyebrow ("Open source · MIT · Windows, macOS (Apple Silicon), Linux") and honest friction line ("Two model downloads on first run, ≈5 GB") fix Handy's "platforms not stated" weakness that A itself identified
evidence:  README.md:159, :261-262; A §AC6 Handy row
affects:   D13, AC4, AC7
action:    adopt
```
```
id:        A-O10
quadrant:  opportunity
claim:     B recorded API baselines (29 stars; v0.38.0 = 16 asset downloads) and rules "set targets only after four weeks" — gives the metrics a floor without inventing targets
evidence:  gh api 2026-10-11
affects:   D11, AC4
action:    adopt
```

### Threats (6)

```
id:        A-T1
quadrant:  threat
claim:     Whether github.com/<old>/releases/latest/download/* and raw.githubusercontent.com redirect after a repo rename is not confirmed; old updaters depend on it
evidence:  main/services/update-feed.js:11-13; README.md:514-515 (raw star-history URLs)
affects:   D7, AC3
action:    mitigate — R0 keeps the old slug; after the GitHub rename run `curl -I` on an old asset URL and only then change REPO_SLUG
```
```
id:        A-T2
quadrant:  threat
claim:     Windows: with appId unchanged but productName changed, NSIS install-dir / uninstall-key behaviour (update in place vs side-by-side) is unverified
evidence:  test/update-feed.test.js:164 (install path contains productName); electron-builder.yml:83-85 (nsis)
affects:   D7, AC3
action:    mitigate — R0→R1 `EARHEART_UPDATE_FEED=file://` test on a Windows VM is a release gate
```
```
id:        A-T3
quadrant:  threat
claim:     earheart.dev and earheart.app are unregistered today; anyone can take them before the user decides
evidence:  RDAP 404 on 2026-10-11
affects:   D23, AC4
action:    ask — Q2 asks the user to register both as soon as Q1 is answered
```
```
id:        A-T4
quadrant:  threat
claim:     Competitor prices came from a summarising fetch and third-party pages (Superwhisper rendered "$849"; MacWhisper via secondary sources)
evidence:  A-D24; B §3.3 notes
affects:   D2, AC1, AC7
action:    mitigate — prices stay in the strategy table only, flagged "verify"; never on the site (B §9)
```
```
id:        A-T5
quadrant:  threat
claim:     The Anthropic /voice sentence can change at any time; a stale quote on the site becomes a false comparison
evidence:  code.claude.com doc shows version-specific troubleshooting (v2.1.195–2.1.231) — it is actively edited
affects:   D14, AC7
action:    mitigate — the quote carries its fetch date and link; re-fetch is a step before each launch channel
```
```
id:        A-T6
quadrant:  threat
claim:     Codex built-in voice facts rest on third-party blogs only
evidence:  WebSearch 2026-10-11: no official OpenAI changelog entry found
affects:   D2, D29, AC1, AC7
action:    mitigate — adopt B-D25: strategy-only mention; no site copy about Codex's built-in voice until verified
```

---

## A.2 SWOT records — Plan B

### Strengths (11)

```
id:        B-S1
quadrant:  strength
claim:     Quotes Anthropic's /voice documentation verbatim (cloud, claude.ai login, not for API key/Bedrock/Foundry, not SSH) and builds the hero comparison on it
evidence:  code.claude.com/docs/en/voice-dictation fetched 2026-10-11 — sentences match word for word
affects:   D1, D2, D14, AC1, AC5
action:    keep
```
```
id:        B-S2
quadrant:  strength
claim:     Download-page data is fetched at build into release.json with a committed fallback and a daily cron rebuild — no per-visitor API calls, no cross-repo token
evidence:  B §6.6; test/update-feed.test.js:19-45 (versioned asset names)
affects:   D20, AC4
action:    keep
```
```
id:        B-S3
quadrant:  strength
claim:     Trademark sanity via Justia search found a real conflict (EARSHOT filings) and none for Earheart
evidence:  B §4.2 trademark column
affects:   D4, D5, AC2
action:    keep
```
```
id:        B-S4
quadrant:  strength
claim:     Leaves internal identifiers (window.earheart, --earheart-role) untouched under a rename
evidence:  preload.js:105,124; main/windows.js:55; test/ipc-contract.test.js:15,45,62,97 (pinned, not user-visible)
affects:   D9, AC3
action:    keep
```
```
id:        B-S5
quadrant:  strength
claim:     Most complete load-bearing inventory, with the tests that pin each string
evidence:  test/updates.test.js:409,604 (swap/relaunch markers), test/overlay-contract.test.js:206,309, test/main-lifecycle.test.js:338, main/windows.js:55, main/main.js:169-184 — all verified
affects:   D7, AC3
action:    keep
```
```
id:        B-S6
quadrant:  strength
claim:     Metrics have API-sourced baselines and a rule to set targets only after four weeks of data
evidence:  gh api 2026-10-11 (29 stars; release download_count)
affects:   D11, AC4, AC7
action:    keep
```
```
id:        B-S7
quadrant:  strength
claim:     Audience angles come with a "proof to show" column tied to real assets (docs/screenshots/settings.png, overlay-paused.png, docs/agents.md:93-96 foot pedal)
evidence:  docs/screenshots listing; docs/agents.md:93-96
affects:   D24, AC5
action:    keep
```
```
id:        B-S8
quadrant:  strength
claim:     Deferred-follow-ups list captures real distribution levers (Homebrew/winget, notarization) without scope creep
evidence:  B Progress "Deferred"; Handy/VoiceInk rows
affects:   D28
action:    keep
```
```
id:        B-S9
quadrant:  strength
claim:     Competitor pricing is kept out of the site and competitor claims are quoted verbatim with date — honesty rule beyond AC7's minimum
evidence:  B §9
affects:   D21, AC7
action:    keep
```
```
id:        B-S10
quadrant:  strength
claim:     Treats the agents' built-in voice as the primary comparison target rather than subscription dictation apps (different buyer)
evidence:  PRODUCT.md:11-13 (primary audience); B-D2
affects:   D2, AC1
action:    keep
```
```
id:        B-S11
quadrant:  strength
claim:     "Equity at stake ≈ 0" criterion states plainly that a rename is cheapest now — and that this is not evidence the name hurts
evidence:  gh api: 29 stars, created 2026-06-12
affects:   D3, AC2
action:    keep
```

### Weaknesses (9)

```
id:        B-W1
quadrant:  weakness
claim:     Every PRODUCT.md citation is 10–17 lines low (:149-153 Absent→159-162; :35-40 lead claim→52; :62-66 Not claimed→74-77; :112-116 telemetry→127; :127-131 name→139-140; :133-136 tagline→141), and :74-77 is cited for CLI flags, which it is not
evidence:  PRODUCT.md:52, :74-77, :127, :139-141, :159-162
affects:   D1, D3, AC1, AC7, AC8
action:    fix — merged plan re-cites
```
```
id:        B-W2
quadrant:  weakness
claim:     Channel plan says "PR each" for awesome lists; awesome-claude-code forbids PRs and accepts only its web issue form
evidence:  raw CONTRIBUTING.md fetched 2026-10-11: "ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM TEMPLATE… Do not open a PR"
affects:   D24, AC5
action:    fix — adopt A's method
```
```
id:        B-W3
quadrant:  weakness
claim:     Proposed Show HN title is 90 characters (limit 80)
evidence:  `wc -m`
affects:   D25, AC5
action:    fix — new title
```
```
id:        B-W4
quadrant:  weakness
claim:     Coral on the primary download CTA breaks the design system's One Voice Rule, which the plan itself says it is evolving, not departing from
evidence:  DESIGN.md:312-316 "Coral is spent only on the dictation itself… filled white primary pill… Never spend coral"; DESIGN.md:521-524
affects:   D16, AC4
action:    fix — adopt A-D14's white CTA
```
```
id:        B-W5
quadrant:  weakness
claim:     R0 step "accept both old and new asset-name prefixes" is unnecessary: the updater takes the asset path from latest*.yml and only checks the -arm64-mac.zip suffix
evidence:  main/services/update-feed.js:64; test/update-feed.test.js:141
affects:   D7, AC3
action:    fix — drop the step; bridge is the installMac basename fix only
```
```
id:        B-W6
quadrant:  weakness
claim:     Astro adds a dependency tree and a toolchain to keep green; the reasons given for rejecting hand-written HTML (shared chrome, build-time data) are met by a ~120-line node:fs script
evidence:  AGENTS.md Golden rule 9 ethos; A-D17; astro@7.3.8 on npm 2026-10-11
affects:   D18, AC4
action:    fix — adopt A's stack, keep B's build-time data idea
```
```
id:        B-W7
quadrant:  weakness
claim:     Open question Q4 (GitHub Pages vs Cloudflare Pages) re-asks a decision the plan already makes (GitHub Pages, B-D19)
evidence:  B §6.6 Hosting; B-D19
affects:   D22, AC8
action:    fix — drop the question; Cloudflare noted as the alternative only
```
```
id:        B-W8
quadrant:  weakness
claim:     Lead claim "Talk to your coding agents — on your machine." is less specific than the README's own verified sentence and awkward as an H1 (em-dash clause)
evidence:  README.md:11 "your audio and prompts never leave it"
affects:   D1, AC1
action:    fix — hybrid lead claim
```
```
id:        B-W9
quadrant:  weakness
claim:     userData migration moves only settings.json, history.json, models/ — leaves stt-rtf.json, updates/ staging and logs behind
evidence:  main/pipeline.js:187, main/updates.js:524, main/util/logger.js:29-31
affects:   D8, AC3
action:    fix — adopt A's whole-directory rename
```

### Opportunities (9)

```
id:        B-O1
quadrant:  opportunity
claim:     A's narrower bridge (installMac finds the single *.app in staging) is the minimal R0
evidence:  main/updates.js:737-739
affects:   D7, AC3
action:    adopt
```
```
id:        B-O2
quadrant:  opportunity
claim:     A's archived placeholder repo at the old slug protects the redirect
evidence:  main/services/update-feed.js:11-12
affects:   D7, AC3
action:    adopt
```
```
id:        B-O3
quadrant:  opportunity
claim:     A's whole-directory fs.renameSync with marker file covers every userData file atomically
evidence:  A-S3 paths
affects:   D8, AC3
action:    adopt
```
```
id:        B-O4
quadrant:  opportunity
claim:     A's zero-dependency stack
evidence:  A-D17
affects:   D18, AC4
action:    adopt
```
```
id:        B-O5
quadrant:  opportunity
claim:     A's extra comparables (Ski — the closest "voice for coding agents" peer, Spokenly with MCP voice input, OpenWhispr, Whispering lineage) sharpen the differentiation table
evidence:  A §AC1 rows dated 2026-10-11
affects:   D2, AC1
action:    adopt
```
```
id:        B-O6
quadrant:  opportunity
claim:     A's verified awesome-claude-code rules plus OpenAlternative and DevHunt listings
evidence:  A-D21; CONTRIBUTING.md re-fetched
affects:   D24, AC5
action:    adopt
```
```
id:        B-O7
quadrant:  opportunity
claim:     A's SVG wordmark/mark as a one-time port of the SDF heart-waveform
evidence:  scripts/gen-icons.js:2-5 (PNG-only renderer, no SVG source)
affects:   D17, AC4
action:    adopt
```
```
id:        B-O8
quadrant:  opportunity
claim:     A's reference rows (Handy demo-with-transcript, heyski.io "verifiable facts strip", Granola, Tauri install tabs, Ghostty unknown) extend the borrow/avoid table
evidence:  A §AC6
affects:   AC6
action:    adopt
```
```
id:        B-O9
quadrant:  opportunity
claim:     A's AC→verification table with re-runnable curl/grep lines
evidence:  A-D24
affects:   D30, AC8
action:    adopt
```

### Threats (6)

```
id:        B-T1
quadrant:  threat
claim:     Astro major-version churn and transitive-dependency advisories would put upkeep on a single maintainer
evidence:  package.json:10-13 (one contributor group); astro@7.x
affects:   D18
action:    mitigate — moot once A's stack is chosen
```
```
id:        B-T2
quadrant:  threat
claim:     With a daily cron, /download can lag a release by up to 24 h and link one version behind
evidence:  release cadence: v0.37.0 → v0.38.1 within days (gh api)
affects:   D20, AC4
action:    mitigate — every download button has a sibling "All releases" link to releases/latest; repository_dispatch from release.yml is a deferred follow-up
```
```
id:        B-T3
quadrant:  threat
claim:     Redirect behaviour of releases/latest/download after a repo rename is unconfirmed (B says so itself)
evidence:  B §5.2 row 1
affects:   D7, AC3
action:    mitigate — same as A-T1
```
```
id:        B-T4
quadrant:  threat
claim:     Vocable: GitHub org exists (could become a product), .app taken, trademark unknown
evidence:  gh api users/vocable (Organization, 2016); RDAP vocable.app 200
affects:   D4, AC2
action:    mitigate — Talkpaste is fallback #1; USPTO/EUIPO search is a gate before registering any fallback
```
```
id:        B-T5
quadrant:  threat
claim:     A verbatim Anthropic quote on the site goes stale silently
evidence:  the doc carries version-specific notes (v2.1.195–v2.1.231) — it changes often
affects:   D14, AC7
action:    mitigate — dated quote + re-fetch step before each channel (same as A-T5)
```
```
id:        B-T6
quadrant:  threat
claim:     Codex built-in voice is unverified
evidence:  WebSearch 2026-10-11, third-party only
affects:   D2, D29
action:    mitigate — B-D25 adopted
```

---

## A.3 Decision table

Rules applied in order: 1 project rules/user constraints disqualify · 2 verified evidence beats unverified · 3 covers more ACs with named verification · 4 lower risk · 5 smaller complete change · 6 prevailing codebase pattern · 7 tie → plan that supplied more.

```
topic:      D1 lead claim
plan_A:     A-D1 "Talk to your coding agents. Nothing leaves your machine."
plan_B:     B-D1 "Talk to your coding agents — on your machine."
chosen:     hybrid
rule:       2
reason:     took the tagline both keep (PRODUCT.md:141) and the README's verified sentence (README.md:11 "your audio and prompts never leave it"): A's "nothing leaves" is contradicted by the updater poll (update-feed.js:12); B's is vaguer than the truth available
swot_refs:  [A-W4, B-W8, B-S1]
```
```
topic:      D2 comparison target and table composition
plan_A:     A-D1/§AC1 12 products + substitutes row (Claude Code /voice, Cursor Voice Mode)
plan_B:     B-D2 built-in /voice first, Handy second; 11 rows incl. Bol
chosen:     hybrid
rule:       3
reason:     B's framing (built-in /voice is the first objection) with A's wider verified rows (Ski, Spokenly, OpenWhispr, Whispering/Epicenter); Codex built-in voice kept as "unverified"
swot_refs:  [B-S10, A-S9, A-T6, B-T6]
```
```
topic:      D3 keep vs rename
plan_A:     A-D2 KEEP
plan_B:     B-D3 KEEP
chosen:     hybrid
rule:       3
reason:     both agree and both availability claims re-verified; merged framework uses A's five pass/fail criteria plus B's "equity at stake" criterion and B's explicit decision rule
swot_refs:  [A-S7, B-S3, B-S11]
```
```
topic:      D4 shortlist and fallbacks
plan_A:     A-D3 8 rows; fallbacks Talkpaste, Voicepress
plan_B:     B-D4 8 rows; fallbacks Vocable, Talkpaste
chosen:     hybrid
rule:       4
reason:     union of both checked tables (13 named rows); fallback #1 Talkpaste (cleanest namespace, re-verified), #2 Vocable (the only brandable candidate; Voicepress has the same .app miss plus an adjacent "PowerPress" mark) — two descriptive fallbacks (A) would give the user no stylistic alternative
swot_refs:  [A-O4, B-T4, A-S7]
```
```
topic:      D5 trademark sanity method
plan_A:     A-D4 WebSearch per name; registers `unknown:`
plan_B:     B-D5 Justia search for finalists; USPTO `unknown:`
chosen:     B
rule:       2
reason:     B's search produced evidence (EARSHOT filings; no Earheart mark); both correctly refuse to claim clearance
swot_refs:  [B-S3, A-O5]
```
```
topic:      D6 appId under a rename
plan_A:     A-D5 keep dev.cleanunicorn.earheart
plan_B:     B-D7 keep dev.cleanunicorn.earheart
chosen:     A
rule:       7
reason:     identical and verified (mac-permissions.js:21-23; release.yml:170); attributed to A as the plan that supplied more of the rename mechanics
swot_refs:  [A-S2]
```
```
topic:      D7 rename migration shape (bridge + rename)
plan_A:     A-D6 bridge = installMac single-*.app fix; wait one update cycle; feat!: rename PR with placeholder repo
plan_B:     B-D6 R0 = updater tolerance + both asset prefixes + dormant migration helper; R1 rename; R0→R1 test on all OSes
chosen:     hybrid
rule:       5
reason:     A's narrower bridge (B's prefix step is unnecessary — update-feed.js:64 checks only the suffix) plus B's named release gate (R0→R1 file:// update on three OSes) and B's "re-publish old-name build" rollback option; A's placeholder repo kept
swot_refs:  [A-S1, A-S10, B-W5, B-O1, A-T1, A-T2]
```
```
topic:      D8 userData migration
plan_A:     A-D7 fs.renameSync whole legacy dir; per-file fallback; marker
plan_B:     B-D8 move settings.json, history.json, models/ ; marker
chosen:     A
rule:       3
reason:     whole-dir rename also carries stt-rtf.json, updates/ and logs (pipeline.js:187, updates.js:524, logger.js:29-31); A-W9's unspecified marker is specified in the merged plan
swot_refs:  [A-S3, B-W9, A-W9]
```
```
topic:      D9 internal identifiers under a rename
plan_A:     "rename optional"
plan_B:     B-D9 leave window.earheart and --earheart-role untouched
chosen:     B
rule:       5
reason:     explicit smaller diff; identifiers are not user-visible and are pinned by contract tests
swot_refs:  [B-S4, A-O7]
```
```
topic:      D10 env vars and stt-server under a rename
plan_A:     A-D8 stt-server: open decision, default keep
plan_B:     B-D10 accept old+new env names for one minor release; stt-server renamed with alias
chosen:     hybrid
rule:       4
reason:     B's dual-accept for EARHEART_* env vars (lowest compatibility risk); stt-server keeps its name by default and is an open question (A) — it has no user base to protect and renaming adds pyproject/Makefile/ci churn
swot_refs:  [A-O8, A-D8]
```
```
topic:      D11 success metrics
plan_A:     A-D9 stars, download_count, GitHub Traffic referrers, issues; no analytics
plan_B:     B §6.1 stars + download_count with baselines; targets only after 4 weeks
chosen:     hybrid
rule:       3
reason:     B's baselines and four-week rule plus A's Traffic referrers and issues-by-newcomers
swot_refs:  [B-S6, A-O10]
```
```
topic:      D12 site map
plan_A:     A-D10 /, /download, /agents, /privacy, /changelog + sitemap, og.png
plan_B:     B-D11 same five + 404, robots.txt, favicon.svg
chosen:     B
rule:       3
reason:     identical pages; B's list is the complete static set
swot_refs:  [—]
```
```
topic:      D13 hero composition and copy
plan_A:     A-D11 H1 + 2-sentence sub + OS-detected white pill + "View on GitHub ★ live"; HTML/CSS bar replica
plan_B:     B-D12 eyebrow + H1 + sub + CTA + friction line "≈5 GB"; HTML/CSS replica from the app's tokens
chosen:     hybrid
rule:       3
reason:     same visual; B's eyebrow names the platforms (fixes the Handy weakness A found) and the friction line serves AC7; A's white pill (D16); star count rendered at build (D20)
swot_refs:  [A-O9, A-S6, A-S11]
```
```
topic:      D14 "Why not the built-in /voice?" section
plan_A:     — (angle 1 only)
plan_B:     B-D2/§6.3 three-column comparison with the verbatim Anthropic sentence, dated, linked
chosen:     B
rule:       2
reason:     only B; quote verified; serves AC1/AC4/AC5; dated-quote rule added for A-T5/B-T5
swot_refs:  [B-S1, A-O1, A-T5]
```
```
topic:      D15 visual direction: theme and type
plan_A:     A-D14/15 dark-first + light variant; self-hosted OFL webfont (open question)
plan_B:     B-D13 dark-only; system-ui
chosen:     B
rule:       5
reason:     smaller complete change that matches DESIGN.md:354 (system-ui) and tokens.css:13 (AA already proven on ink); light variant and a webfont become deferred follow-ups
swot_refs:  [A-W8]
```
```
topic:      D16 accent on the primary CTA
plan_A:     A-D14 filled-white pill; coral only on the live voice
plan_B:     B-D14 coral on the download CTA as a sanctioned exception
chosen:     A
rule:       6
reason:     DESIGN.md:312-316 is explicit ("Never spend coral" outside the voice; "filled white primary pill"); B's worry (white reads secondary) is handled by size and position, not colour
swot_refs:  [A-S6, B-W4]
```
```
topic:      D17 assets to produce
plan_A:     A-D16 SVG mark/wordmark; 30–45 s demo + 6 s hero loop (WebM+MP4); OG by script; 3 agent screenshots
plan_B:     §6.5 25–40 s MP4 + 10 s GIF; OG; favicon set + SVG icon; replica component
chosen:     hybrid
rule:       3
reason:     union: one 30–40 s MP4 (≤6 MB) cut into a 10 s GIF for README/X; OG; SVG mark + favicon set; three real agent screenshots; hero loop optional
swot_refs:  [B-O7]
```
```
topic:      D18 site stack
plan_A:     A-D17 zero-dependency HTML/CSS/JS + ~120-line node:fs build + node --test
plan_B:     B-D15 Astro static, no integrations
chosen:     A
rule:       5
reason:     0 vs 1 (+transitive) new dependencies for the same five pages; B's two reasons for a framework (shared chrome, build-time data) are met by the build script; rule 1 does not apply (AGENTS.md rule 9 governs the app repo; the user gave the site repo full freedom)
swot_refs:  [A-S5, B-W6, B-T1, B-O4]
```
```
topic:      D19 site repo layout
plan_A:     A-D18 site/, build.js, test/, deploy.yml, CNAME, AGENTS.md
plan_B:     B-D16 Astro tree + scripts/{fetch-release,sync-assets} + claims/links/tokens tests + ci.yml & deploy.yml
chosen:     hybrid
rule:       3
reason:     A's flat structure carrying B's scripts (fetch-release, sync-assets) and B's three tests (claims, links, tokens-contract)
swot_refs:  [A-O3, B-S2]
```
```
topic:      D20 release data on /download
plan_A:     A-D12 client-side fetch per visit, static fallback
plan_B:     B-D18 build-time release.json + committed fallback + daily cron
chosen:     B
rule:       4
reason:     per-IP rate limit and empty-button flash vs a 24 h lag mitigated by an "All releases" link; star count also rendered at build
swot_refs:  [A-W6, B-S2, B-T2]
```
```
topic:      D21 honesty guard (claims lint)
plan_A:     A-D13 regex: counts of users/downloads/developers/teams, testimonial, "as seen in", literal ★ N
plan_B:     B-D17 regex: counts, "x faster", percentages, "trusted by", "as seen", testimonial; allowlist "faster than realtime"
chosen:     hybrid
rule:       3
reason:     union of both pattern sets with B's allowlist
swot_refs:  [A-S8, B-S9]
```
```
topic:      D22 hosting
plan_A:     A-D19 GitHub Pages, apex + www, HTTPS, deploy-pages, nightly cron
plan_B:     B-D19 GitHub Pages; Cloudflare only if PR previews win (Q4)
chosen:     A
rule:       7
reason:     identical choice; A's includes DNS detail; B's Q4 dropped (B-W7)
swot_refs:  [B-W7]
```
```
topic:      D23 domain paths
plan_A:     A-D20 keep → earheart.dev + earheart.app redirect, ignore .com; rename → <name>.dev
plan_B:     B-D20 same
chosen:     A
rule:       7
reason:     identical and re-verified (RDAP 2026-10-11); B's extra fact (earheart.com registered 2000, expires 2027-03-01) kept
swot_refs:  [A-T3]
```
```
topic:      D24 launch channel order and method
plan_A:     A-D21 README → site → Show HN → Reddit → X/Bluesky → awesome-claude-code (issue form) → PH last
plan_B:     B-D21 awesome lists ("PR each") → Show HN → Reddit → X same day as HN → PH optional
chosen:     hybrid
rule:       2
reason:     B's ordering (awesome lists first — Earheart already qualifies, low effort, trickle before HN) with A's verified method (issue form, not PR) and A's extra listings (OpenAlternative, DevHunt); Reddit rule-reading checklist added
swot_refs:  [A-S4, B-W2, A-W7, A-W10]
```
```
topic:      D25 Show HN title
plan_A:     A-D22 91 chars
plan_B:     §7.3 90 chars
chosen:     new
rule:       2
reason:     HN caps titles at 80 characters; "Show HN: Earheart – On-device voice dictation for Claude Code, Codex, Cursor" is 76 and keeps A's what-it-is shape
swot_refs:  [A-W5, B-W3]
```
```
topic:      D26 README refresh scope
plan_A:     A-D21 step 1: docs: PR — site link, shorter install, GIF, homepage field
plan_B:     B-D22 GIF, "Why not /voice" subsection, site link, homepage
chosen:     hybrid
rule:       3
reason:     B's content with A's non-release `docs:` title; the "/voice" subsection is an open question (B Q8)
swot_refs:  [A-W1]
```
```
topic:      D27 analytics
plan_A:     A-D9 none at launch; open decision
plan_B:     B-D23 none; open decision
chosen:     A
rule:       7
reason:     identical
swot_refs:  [—]
```
```
topic:      D28 left out and deferred
plan_A:     A-D23 no notarization/MCP/mobile/analytics/blog/pricing/testimonials/light app theme
plan_B:     B-D24 + deferred Homebrew/winget, Starlight docs, notarization
chosen:     hybrid
rule:       3
reason:     union; Homebrew/winget and notarization recorded as deferred product work
swot_refs:  [B-S8, A-O6]
```
```
topic:      D29 Codex built-in voice as a cited fact
plan_A:     — (substitutes row names Cursor Voice Mode; Codex not in the row)
plan_B:     B-D25 strategy-only "third-party reports"; never on the site until verified
chosen:     B
rule:       2
reason:     re-search 2026-10-11 found no official changelog entry
swot_refs:  [A-T6, B-T6]
```
```
topic:      D30 verification of the strategy document itself
plan_A:     A-D24 AC→verification table with re-runnable grep/curl lines; prices flagged
plan_B:     §10 AC→where→how table
chosen:     A
rule:       3
reason:     A's lines are executable; B's are descriptive
swot_refs:  [A-S11, B-O9]
```

---

## A.4 Acceptance-coverage matrix

| Criterion | Plan A | Plan B | Merged |
|---|---|---|---|
| AC1 positioning | covered (12 rows; lead claim over-broad) | covered (11 rows; built-in /voice row) | covered |
| AC2 rebrand | covered | covered | covered |
| AC3 migration | covered (3 wrong citations) | covered (PRODUCT.md citations stale) | covered |
| AC4 website | covered | covered | covered |
| AC5 launch | partial (HN title >80; category unverified) | partial (awesome-list method wrong; HN title >80) | covered |
| AC6 references | covered (14 rows + slot) | covered (15 rows + slot) | covered |
| AC7 honesty | covered | covered | covered |
| AC8 format | covered | covered | covered |

## A.5 Merge log

- **13 contested decisions** (D1, D2, D4, D5, D7, D8, D9, D10, D15, D16, D18, D20, D24, D25 — D25 contested in that both were wrong), 17 topics where the plans agreed or only one covered the topic.
- **Plan A: 11 S · 10 W · 10 O · 6 T. Plan B: 11 S · 9 W · 9 O · 6 T.**
- **Decisions: 8 from A, 8 from B, 13 hybrid, 1 new** (30 topics).
- Wrong citations: Plan A 5 (package.json ×2, electron-builder.yml, README ×2 hard-wrong, 2 drift); Plan B 7 PRODUCT.md anchors (systematic offset) + 1 mis-cite (PRODUCT.md:74-77 for CLI flags). Wrong web claims: Plan B "PR each" for awesome lists; both Show HN titles over the length limit.
- `ask` actions: A-T3 (register earheart.dev/.app now?) → Q2; stt-server rename (D10) → Q4; README "/voice" subsection (D26) → Q8.
