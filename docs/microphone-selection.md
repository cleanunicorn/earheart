# Microphone selection (#339)

Settings → General → Microphone (and the setup wizard) can pick the microphone
for you. Two modes:

- **Use the microphone below** (the default, and what every older install does):
  the saved device, or the system default when none is saved. If the saved
  device is unplugged the take falls back to the system default and says so on
  the card; the saved choice is kept.
- **Choose automatically**: rank what is plugged in at the start of each take.
  *Allow Bluetooth microphones* and *Allow virtual microphones* decide which
  devices may be chosen.

The saved device is never rewritten by automatic mode. Switching back to
manual brings it back.

## How a device is chosen (`renderer/mic-policy.js`)

1. Chromium's `default` / `communications` entries are aliases, not devices.
   They are used only to find the real device behind the OS default (by
   `groupId`, else by label with the `Default - ` prefix removed, and only if
   that is unique).
2. A device is **excluded** only when it is *known* to be Bluetooth (and
   Bluetooth is off) or *known* to be virtual (and virtual is off).
   A device whose class can't be established is **unknown** and is never
   excluded.
3. Among the allowed devices: the OS default device if it is allowed (the take
   opens "system default", so it follows the OS), else the first device known
   to be neither Bluetooth nor virtual, else the first unknown one.
4. If every device is excluded, the take uses the system default and the card
   says why ("Only Bluetooth microphones found — using system default").
5. If device labels are hidden (see below) or nothing is listed, the take does
   what manual mode does.

## Where Bluetooth/virtual comes from (`main/mic-probe.js`)

Chromium reports only `deviceId`, `label` and `groupId`, so the main process
asks the OS with a tool that ships with it (no npm dependency, like
`main/ducking/`):

| OS | Tool | What it tells us |
| --- | --- | --- |
| Linux | `pactl -f json list sources` | `bluez` source / `device.bus` → Bluetooth; `.monitor` and abstract/filter classes → virtual |
| macOS | `system_profiler SPAudioDataType -json` | transport type: bluetooth / virtual / aggregate / built-in / USB … |
| Windows | PowerShell `Get-PnpDevice` | Bluetooth nodes (`BTH*` instance ids) only; virtual is never claimed |

A probe record joins a Chromium device only on a **unique exact normalized
name** (case-folded, whitespace collapsed, `Default - ` prefix and a trailing
`(vid:pid)` removed). Two devices with the same name — or one name with two
probe records — join nothing and stay unknown. A missing tool, a timeout or
unexpected output yields no records: the answer is cached, refreshed in the
background (app start, then at most every 30 s when asked), and a take **never
waits** on it beyond a 300 ms budget.

On Windows the PnP friendly name rarely equals Chromium's `Microphone (Name)`
label, so most devices will stay unknown there and the two options may change
nothing. Settings says so ("This system doesn't report which microphones are
Bluetooth or virtual…") whenever the probe returns no records.

## Labels at take start

`enumerateDevices()` hides labels until the page has had a stream, and the
overlay deliberately does **not** open a throwaway stream to learn them (that
could be a Bluetooth mic and flip a headset into its call profile). It keeps
the labels from the last enumeration made while a stream was open, and
refreshes them after every take starts and on `devicechange`. The first
automatic take after launch can therefore see no labels and behaves like
manual mode; later takes rank properly.

## A route change during a take

If the microphone's track ends mid-take (unplugged, Bluetooth route dropped):

- everything captured so far stays in the take;
- one attempt is made to open a replacement (the auto-pick again in automatic
  mode, else the saved device, else the system default); the worklet is
  untouched and only its source is swapped, so the WAV is contiguous. A
  different sample rate on the new device is resampled by the 16 kHz
  `AudioContext`;
- capture is reported "not live" until the new stream delivers samples, and
  the card says "Microphone changed — kept recording";
- the error cue and "Microphone lost — audio captured so far is kept" appear
  only if the attempt fails; stopping still delivers what was captured.
- at most two recoveries per take; stop or cancel racing an attempt releases
  the new stream.

Permission denial is unchanged and shows the same error in both modes.

## Real-OS acceptance

Unit tests and the overlay/settings smokes use fakes (`test/mic-policy.test.js`,
`test/mic-probe.test.js`, `test/overlay-mic.test.js`, the fake-device
`overlay-smoke`). Results on real hardware:

| Check | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Probe returns records on this OS | PipeWire (pipewire-pulse): ran, monitor source tagged virtual | unverified | unverified |
| Monitor/loopback sources are absent from `enumerateDevices` inputs | unverified | n/a | n/a |
| Bluetooth headset classified Bluetooth and joined to its Chromium label | unverified | unverified | unverified (expected unknown) |
| Auto + Bluetooth off picks a wired/built-in mic | unverified | unverified | unverified |
| Unplug/replug mid-take keeps earlier speech and resumes | unverified | unverified | unverified |
| Labels available on the second take after launch | unverified | unverified | unverified |
