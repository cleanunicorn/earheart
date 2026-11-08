# Snippets

Settings → **Snippets** saves blocks of text you would otherwise dictate in
full: an address, a signature, a standing brief for an agent. Say the
**trigger phrase** and Earheart types the saved text instead, exactly as
written. It works with cleanup on or off, and History keeps what you said.

Code: [renderer/snippets.js](../renderer/snippets.js) (records, validation,
merging, tags), [main/text-expansions.js](../main/text-expansions.js) (the
matcher and the cleanup hand-off), the call in `process()` and `cleanKept()` in
[main/pipeline.js](../main/pipeline.js), the Snippets section in
[renderer/settings.js](../renderer/settings.js).

## A snippet

| Field | Rule |
| --- | --- |
| Trigger phrases | 1–8 per snippet, up to 120 characters each, one line, at least one letter or digit |
| Text | Up to 8,000 characters, any number of lines |
| Total | Up to 100 snippets |
| Id | Stable (`snp_…`), kept across edits, so windows can merge by snippet |

A trigger belongs to one snippet: comparing them ignores capitalization,
accents written as combining marks and runs of spaces, so `My Address` and
`my  address` are the same trigger. Saving a second owner is refused with the
snippet named, and nothing is saved.

The text is inserted byte for byte. Line breaks are stored as `\n`; leading and
trailing spaces and blank lines are kept. Nothing rewrites it: not cleanup, not
**Always replace**. The one exception is your own **Deliver as one line**
option (Settings → General), which joins everything delivered, snippets
included, into a single line; History keeps the multiline text.

## How a trigger is matched

On the recognized text, left to right, in one pass:

- **Whole words, any capitalization.** `my address` matches `My Address,` but
  not `my addresses` or `army address`. Spaces inside a trigger match any run of
  spaces. Text is compared in Unicode NFC with simple case folding, so
  `café` matches the same word typed with a combining accent.
- **Overlaps.** The leftmost match wins; at one spot the longest trigger wins.
  With `my`, `my address` and `my address book` saved, "my address book" inserts
  the third and "my cat" the first. Matches never overlap.
- **No cascading.** What a snippet inserts is never scanned again, for
  triggers or anything else, so a snippet whose text contains another trigger
  just types that text.
- **Up to 16 snippets per dictation.** Triggers past the 16th stay words.
- **The ends.** Space at both ends of the dictation, and the full stop, comma
  or similar the speech engine adds right after a trigger that ends it
  (`My address.`), are dropped. Saying only a trigger therefore inserts exactly
  the snippet.

## Cleanup and Always replace

The snippet text skips both. Only the words between snippets go through
cleanup and then **Always replace**, one stretch at a time, with their original
spacing kept around the snippet. Stretches without a letter or digit
(whitespace, a lone comma) and a dictation that is only a trigger skip the
cleanup model altogether.

If cleanup fails for one stretch, that stretch and the rest stay as spoken, you
get the usual single "cleanup failed" notice, and the snippets still go in.
A dictation that cancels part-way delivers and records nothing, as before.
Retranscribing a kept recording from History expands snippets the same way.

## Tags

Four tags can appear in a snippet's text. Insert them with the buttons under
the text box; the preview shows the result (the clipboard shows as `‹clipboard›`
there).

| Tag | Becomes |
| --- | --- |
| `{{clipboard}}` | The clipboard's text, up to 20,000 characters |
| `{{date}}` | Today's date as `2026-11-08` |
| `{{time}}` | The time as `14:05`, 24-hour |
| `{{timezone}}` | Your time zone, e.g. `Europe/Bucharest` |

Names ignore capitalization and spaces inside the braces (`{{ Date }}`). A
`{{…}}` with another name, or empty, can't be saved. In a settings file edited
by hand it is left exactly as typed when you dictate it.

Tags are filled once per dictation, from values taken when the recording
stops. The clipboard is read at that moment, before Earheart's own paste
replaces it, and only when some saved snippet uses `{{clipboard}}` — otherwise
the clipboard is never touched. What a tag inserts is inserted as is: a
clipboard that contains `{{date}}` types `{{date}}`.

Because the inserted text is part of what Earheart delivers, it lands in
History and, if the paste has to be held back because the clipboard changed
(**Copy last transcription**, the "not pasted" notice), in that held copy too.
Don't use `{{clipboard}}` with secrets you don't want in History; turn History
off, or leave the tag out.

## Saving and several windows

Add, edit and delete change the list in the window; **Save** writes it with the
rest of the settings. Save refuses while a snippet is half-edited, and names
the problem for any invalid snippet before anything is written. Snippets are
merged per id with changes made in another Settings or setup window, so two
windows adding different snippets keep both; if they gave different snippets the
same trigger, the later save fails and the earlier one stays.

Snippets are stored as the top-level `snippets` setting in `settings.json`,
which older versions ignore. A hand-edited file is repaired on load without
being rewritten: invalid snippets are dropped and logged, a trigger claimed
twice stays with the first snippet.

## Not included

No sync, import or export, per-app snippets, expansion in the live preview
(it shows the words you said), arbitrary templates or scripting, and no
clipboard monitoring.
