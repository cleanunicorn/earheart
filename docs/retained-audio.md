# Kept recordings

Settings → History → **Keep recordings** saves each dictation's audio on this
computer, encrypted, so it can be played, exported or retranscribed from its
History entry later, after a restart too (#343). It is **off by default**.
If you never turn it on, Earheart keeps no recording on disk; the only audio
it holds is the one failed take kept in memory for ten minutes so you can
retry it (#293). Turning it **off** stops keeping new recordings, but doesn't
delete the ones already kept: they stay playable until their age or size
limit removes them, or until you choose **Delete all recordings** (or Clear
history).

## When a recording is kept

A recording is kept when all three hold:

- **Keep recordings** is on (`recordings.keep` in `settings.json`);
- **History** is on: each recording belongs to one History entry and is named
  by that entry's id (the id contract in `main/history.js`);
- the OS offers real secure storage: macOS Keychain, Windows DPAPI, or on
  Linux a Secret Service keyring such as GNOME Keyring or KWallet.

Earheart writes the audio a moment after the transcript is saved to History.
The write never delays the paste, and a failed write never touches the
transcript. A dictation that produced no words, or that failed to transcribe,
gets no History entry, so its audio isn't kept. A failed take still gets the
in-memory retry (#293).

## Encryption, and why it fails closed

Recordings are never written in plaintext.

- A random 256-bit **data key** is made the first time a recording is kept.
  Only its **wrapped** form is stored, in `audio/key.json`, encrypted by
  Electron `safeStorage` (the OS keychain).
- Each recording is sealed with **AES-256-GCM** under that key, with a fresh
  random IV. The authenticated data binds the file to its History entry id,
  so a file renamed onto another entry fails to open instead of playing the
  wrong words.
- **No secure storage → no recordings.** Some systems have no OS-backed
  secure storage, such as headless Linux with no keyring, where Electron
  falls back to its `basic_text` backend (a password built into Chromium). On
  those, Keep recordings can't be turned on. Settings disables the switch and
  says why, and `settings.save()` refuses `keep: true` as well.
- **A lost key never loses audio silently.** The key file can exist but fail
  to unwrap (the keyring is locked or was replaced, or the profile was copied
  from another machine). It can also be missing while recordings remain.
  Either way, every recording is reported **unreadable** and new recordings
  aren't kept. Settings explains this, and Earheart never makes a replacement
  key on its own. The recordings stay on disk: a keyring that unlocks gets
  them back after a restart. **Delete all recordings** removes them and the
  key, and the next recording starts a new key.

**Export…** is the only way audio leaves its encryption, and only to a file
you choose.

## On disk

Everything lives under `<userData>/audio/`. The directory is created `0700`
and files `0600` (on Windows the profile folder's ACL applies).

| File | Contents |
| --- | --- |
| `key.json` | `{ "version": 1, "wrapped": "<base64 safeStorage ciphertext of the base64 data key>" }` |
| `<entryId>.wav.enc` | format v1: `"EHAU"` (4 bytes) · version `0x01` (1) · IV (12) · GCM tag (16) · ciphertext of the WAV (16 kHz mono PCM) |

Each write goes to a temp file and is then renamed into place, so a crash or
a full disk never leaves a truncated recording.

**Migration.** The version byte names the format. A file with an unknown
magic or version (written by a newer build, say) is reported unreadable. It
is never rewritten, and it can still be deleted and still expires. A future
format keeps reading v1.

## Limits

| Setting | Default | Range |
| --- | --- | --- |
| Delete recordings after (days) | 30 | 1–365 |
| Keep at most (MB) | 1024 | 50–10240 |

Pruning deletes three kinds of recording, in this order:

1. recordings older than the age limit, judged by when they were written;
2. recordings whose History entry is gone (deleted, cleared, or pushed out by
   History's own 100-entry limit);
3. the oldest recordings, until the total, including the one about to be
   written, fits the size limit.

A single recording bigger than the whole size limit isn't kept, and neither
is a new one when older recordings that would have to go to make room can't
be deleted (held open): the size limit is never exceeded. Pruning runs
at startup, every hour, after each save, and whenever settings change. It
runs whether or not Keep recordings is on, so turning it off never strands
recordings past their limits.

## Failure and recovery

| What happens | Outcome |
| --- | --- |
| Disk full or write refused (`ENOSPC`, `EACCES`, …) | The temp file is removed and nothing half-written remains. Settings shows the code under Keep recordings. The transcript is in History and was delivered as usual. |
| Recording missing (deleted, expired) | The entry shows no Play button. A request that races the deletion gets "no longer kept". |
| Recording damaged, or a format this build can't read | Unknown formats and truncated files are marked "recording unreadable" in the list. Damage inside the ciphertext is found when it's read, and Play, Export or Retranscribe then says so. **Delete** always works. |
| Key locked, replaced or missing | All recordings are reported unreadable and new ones aren't kept (see above). |
| Deleting the entry being played | The player stops, its blob URL is revoked, and the file is deleted with the entry. |
| Deleting an entry, but its recording can't be deleted (held open) | The entry goes, Settings says the recording will be retried, and the next prune deletes it as an orphan. |
| Clear history / Delete all recordings partly fails | Recordings are deleted first and the key last, only once every recording is gone. Whatever is left can be deleted again. |

## Retranscribe

**Retranscribe** runs a kept recording through speech-to-text again, plus
cleanup if it's on, using the current settings. It belongs to its History
entry, not to a dictation:

- It never pastes, copies, or touches the focused app.
- It never changes the entry's original transcript (`raw`, `text`), never adds
  an entry, and so never counts as a second dictation. The result goes in
  `entry.retry` (`{ seq, at, status, raw, text, cleaned, incomplete?, error? }`)
  and shows under the original with its own **Copy retranscription** button.
- One runs at a time. A second request gets "busy", and none starts while a
  dictation is running.
- Starting a dictation cancels a running retranscription: it's marked
  **cancelled** and can be run again.
- `seq` only ever increases (it's time-based), so an older retranscription that
  finishes late never overwrites a newer result. A result for an entry deleted
  meanwhile is dropped.

## Where it lives in the code

- `main/audio-store.js` holds the format, the key handling, pruning, and
  failure handling. Its tests in `test/audio-store.test.js` use a stand-in
  `safeStorage`.
- `main/recordings.js` decides when audio is kept, runs pruning and export,
  and holds the retranscriber.
- `main/pipeline.js` keeps a dictation's audio after `history.add` and wires
  `retranscribe()` to the engines without delivery.
- `main/ipc.js` handles `history:audio-get`, `history:audio-export`,
  `history:retranscribe`, `recordings:status` and `recordings:clear`, which
  are open to the Settings window only. `history:delete` and `history:clear`
  cascade to the audio.
- In `renderer/settings.js`, the Keep recordings card, the player and the
  retranscription block live under History.
