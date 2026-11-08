# Formatting by destination

Earheart can format a dictation differently depending on where it will land:
a chat site, an email composer, a terminal, a coding agent. This is separate
from the cleanup style (Verbatim / Clean / Polished), which decides *how much*
the cleanup edits. Formatting decides *capitalization and punctuation* only.

Settings → Cleanup → **Formatting by destination** holds a default style and a
list of rules.

## Styles

| Style | What it does |
| --- | --- |
| Standard | Nothing extra. The prompt is identical to before this feature. |
| Email / documents | Full, capitalized sentences with ending punctuation. |
| Chat | Casual: lowercase start, no final period. |
| Code-safe | Keeps file paths, command names, flags, `snake_case` / `camelCase` identifiers, version numbers and other numbers as spoken, and adds no final period. |

Formatting is a block of the cleanup prompt, so it applies **only while cleanup
is on** (and, with a remote cleanup endpoint, that endpoint sees it too). It
applies under the Custom cleanup style as well.

## Rules and precedence

A rule is a **website** (`github.com`) or an **application** (a macOS bundle id
such as `com.apple.Terminal`) plus a style. Most specific wins:

1. a website rule that matches the current host,
2. an application rule that matches the frontmost app,
3. the default style.

Matching is exact on the normalized host: lowercase, scheme/port/path removed,
trailing dot removed, one leading `www.` removed, internationalized names as
punycode. `github.com` does **not** match `gist.github.com`, `notgithub.com` or
`github.com.evil.example`; add a rule per host you want. There are no wildcards.
Two rules for the same scope (after normalization) are rejected, and at most 50
rules are kept.

## What is read, and where it works

| Platform | Application | Website host |
| --- | --- | --- |
| macOS | frontmost app (System Events) | Safari, Chrome (and Beta/Dev/Canary), Brave, Edge, Vivaldi, Opera, Arc |
| macOS, Firefox and other browsers | yes | not available (default or app rule) |
| Windows, Linux | not available | not available |

Where nothing can be read, the **default style** is used and dictation is never
blocked. macOS asks once per browser for Automation permission ("Earheart wants
to control Google Chrome"); if you decline, that browser falls back to its
application rule or the default. A browser is only asked when it is the
frontmost app. The detector returns the **hostname only** — never the full URL,
page title or text — and nothing about the destination is written to history,
logs or disk.

## Per-take behavior

The destination and the rules are read **once, as recording starts**, and that
decision is frozen for the take: live preview, the cleanup warm-up, the final
pass and a retry of a failed take all use it. Switching tabs or apps, or
editing rules, mid-take changes nothing. (Engine and model settings still
follow the live settings, and a retry uses them as they are now.) The mic and
overlay start immediately; detection runs alongside, bounded by a timeout, and
only the cleanup work waits for it. The overlay shows the matched site or app
and the style while recording.

## Identifiers and terminal literals

The Code-safe prompt asks the model to leave paths, flags, identifiers and
numbers alone. Because a prompt is advisory, there is also a deterministic
check: if cleanup changed or dropped any such token that was in the raw
transcript, the raw transcript is used for that take instead. This covers
paths, `-x` / `--flag`, `snake_case`, `camelCase` and dotted numbers; it is a
best-effort guard, not a parser, and other styles are not checked.

## Not covered

Windows and Linux detection, a manual per-take picker, wildcard or subdomain
rules, output-mode changes per destination and submit-after-paste.
