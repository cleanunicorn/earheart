# Usage stats

Settings → **Usage** shows how much you dictate: lifetime takes, words and
speaking time, your average speaking speed, your current and longest streak,
the last 14 days, and an **estimate** of the typing time saved. It is on by
default, works with History off, and never leaves your computer.

Code: [main/usage.js](../main/usage.js) (store and maths),
[renderer/usage-stats.js](../renderer/usage-stats.js) (the section), the
`usage.record` call in `process()` in [main/pipeline.js](../main/pipeline.js).

## What is stored

Counts only. The pipeline hands the store a word count and a duration; no
transcript text, raw or cleaned, ever reaches it. The file is
`usage.json` in Earheart's settings folder (`userData`), written with mode
0600 through a temp file and a rename. In an installed copy:

| OS | Path |
| --- | --- |
| Linux | `~/.config/Earheart/usage.json` |
| macOS | `~/Library/Application Support/Earheart/usage.json` |
| Windows | `%APPDATA%\Earheart\usage.json` |

A run from source (`make run`) uses a lowercase `earheart` folder instead.

```json
{ "version": 1,
  "since": "2026-11-04",
  "totals": { "takes": 12, "words": 1840, "speechMs": 731000 },
  "days": { "2026-11-04": { "takes": 5, "words": 610, "speechMs": 240000 },
            "2026-11-05": { "takes": 7, "words": 1230, "speechMs": 491000 } } }
```

- Every number is a non-negative integer. Day keys are the **local** calendar
  date when the take was delivered, so a take at 23:30 counts on the day you
  spoke it, not the UTC date.
- `totals` are lifetime and kept apart from `days`; dropping old days never
  lowers them.
- **Bound:** at most 3,660 day buckets (about 10 years, roughly 220 KB);
  the oldest go first.
- `since` is the first counted day, or the day of the last Reset.

## What counts

One count per take whose words landed. The call sits after `deliver()`, so
it adds nothing to the time before the paste, and the disk write is deferred
a turn and coalesced.

| Event | Counted |
| --- | --- |
| Delivered by paste, clipboard, or both | yes |
| Partial transcript delivered (the engine died part-way) | yes — the duration is the whole take, so WPM reads a little low |
| Delivery cancelled mid-way | no |
| Not pasted because the clipboard changed (`clipboard-changed`) | no — the words are still in History and **Copy last transcription** |
| Empty transcript | no |
| Transcription, cleanup or delivery failed before anything landed | no |
| Discarded or cancelled while recording or processing | no |
| A failed take's **Retry** | yes, once — the failed attempt counted nothing |
| History **Retranscribe** | no — it never delivers |
| Live-transcript chunks | no |
| Paused time | no — the overlay drops samples while paused, so the recording is the captured time only |
| The same take id twice | no |
| Counting switched off | no — earlier numbers stay |

**Words** are the words of the delivered text (after cleanup and the
dictionary aliases): the text you would otherwise have typed. Words are
whitespace-separated runs. **Speaking time** is the duration of the whole
recording.

## The figures

- **Average speed** = total words ÷ total speaking minutes, shown once at
  least one second of speech is counted (never Infinity or NaN).
- **Time saved (estimate)** = (total words ÷ typing speed) − speaking time,
  never below zero. The typing speed is **40 WPM** by default, a typical
  typing speed, and can be set from 10 to 200 WPM next to the figure. It is
  not measured: Earheart doesn't know how fast you type, how much you'd have
  edited, or how long you spent fixing a transcript. The section always says
  so.
- **Streak** counts consecutive calendar days with at least one take, ending
  today, or yesterday if you haven't dictated yet today. Days step on the
  calendar, so a 23- or 25-hour daylight-saving day is still one day.
- **Last 14 days** lists each day newest first with its word count in text;
  the bar beside it is relative to the busiest day shown.

## When something is wrong

Usage never blocks or delays delivery (Golden rule 8): `record()` never
throws, the pipeline also wraps the call, and a write failure is logged.

| File state | What happens |
| --- | --- |
| Missing | Starts empty. |
| Not JSON, or not an object | Renamed to `usage.json.corrupt-<time>-<pid>`, counting starts again. |
| Older or hand-edited | Read field by field: bad numbers become 0, impossible or malformed dates are dropped; saved as version 1 on the next take. |
| Written by a newer Earheart (`version` > 1) | Shown as far as it can be read, but never counted into or overwritten. Settings says so. |
| Unreadable (permissions, a directory in its place) | Shows nothing and writes nothing that session, so a passing error can't replace your counts. |

## Turning it off, resetting, deleting

- **Count my dictations** (Settings → Usage) stops counting; the numbers you
  have stay on screen.
- **Reset statistics** asks first, then writes an empty file at once with
  today as the new start. Transcripts and History are untouched. If the disk
  refuses, the counts stay and Settings says why.
- To remove every trace, quit Earheart and delete `usage.json` from the path
  above.
