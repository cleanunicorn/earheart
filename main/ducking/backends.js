// Per-OS output-volume backends for "lower other audio while recording".
//
// Each backend reads and writes the master volume of ONE output device through
// a platform tool — no npm dependency (AGENTS.md golden rule 9):
//
//   Linux    pactl (PulseAudio, and PipeWire through pipewire-pulse), else
//            wpctl (PipeWire/WirePlumber)
//   macOS    osascript (`get volume settings` / `set volume output volume`)
//   Windows  PowerShell + inline C# over Core Audio's IAudioEndpointVolume
//
// The commands are argv arrays run through execFile with a timeout; nothing
// is ever interpolated into a shell string. Values that reach a script (a
// device id, a level) go in through argv or the environment and are validated
// first.
//
// Interface (everything async; `run(cmd, args, opts)` resolves to stdout):
//   name                 "pactl" | "wpctl" | "osascript" | "powershell"
//   probe()              resolves when the tool answers; rejects with a reason
//   read(device?)        the default device (no argument) or that device:
//                        { device, volume, muted, raw } — volume is 0..1
//                        (above 1 when the OS over-amplifies), raw is whatever
//                        write() takes back. Resolves null when `device` is
//                        gone, and { …, volume: null } when the device has no
//                        volume control.
//   scale(raw, fraction) the raw value for `fraction` of `raw`
//   same(a, b)           whether two raw readings are the same volume, in the
//                        tool's own resolution (no tolerance: one step is a
//                        user's change)
//   matches(read, asked) whether a readback right after write(asked) is that
//                        write landing, within the tool's own rounding — and
//                        not someone else's change in between
//   write(device, raw)   sets it and resolves to read(device) afterwards, or
//                        null when the device is gone
//   addressable          false when read(device)/write(device) can only reach
//                        the current default device (macOS): read(device)
//                        then returns whichever device is the default
//
// The pure builders and parsers are exported for the unit tests.

const PACTL_NORM = 65536; // PA_VOLUME_NORM: 100%

// --- pactl ------------------------------------------------------------------

// pactl's text is localized; LC_ALL=C keeps the "Volume:"/"Mute:" labels and
// the number format parseable.
const C_LOCALE = { env: { ...process.env, LC_ALL: "C" } };

const pactl = {
  defaultSink: () => ["pactl", ["get-default-sink"]],
  getVolume: (sink) => ["pactl", ["get-sink-volume", sink]],
  getMute: (sink) => ["pactl", ["get-sink-mute", sink]],
  // One value per channel keeps the balance the user set.
  setVolume: (sink, channels) => ["pactl", ["set-sink-volume", sink, ...channels.map((v) => String(v))]],
};

// "Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 / ..."
// → [26214, 26214]. The raw values (the first number after each channel name)
// are exact, unlike the rounded percentages.
function parsePactlVolume(text) {
  const line = String(text).split("\n").find((l) => /^\s*Volume:/.test(l));
  if (!line) throw new Error(`unexpected pactl volume output: ${String(text).trim().slice(0, 80)}`);
  const channels = [...line.matchAll(/:\s*(\d+)\s*\//g)].map((m) => Number(m[1]));
  if (!channels.length) throw new Error(`unexpected pactl volume output: ${line.trim().slice(0, 80)}`);
  return channels;
}

function parsePactlMute(text) {
  const m = /Mute:\s*(yes|no)/.exec(String(text));
  if (!m) throw new Error(`unexpected pactl mute output: ${String(text).trim().slice(0, 80)}`);
  return m[1] === "yes";
}

const isPactlGone = (err) => /No such entity/i.test(err?.message || "");

function createPactlBackend(run) {
  async function read(device) {
    const sink = device ?? (await run(...pactl.defaultSink(), C_LOCALE)).trim();
    if (!sink) throw new Error("pactl reports no default output");
    try {
      const channels = parsePactlVolume(await run(...pactl.getVolume(sink), C_LOCALE));
      const muted = parsePactlMute(await run(...pactl.getMute(sink), C_LOCALE));
      return { device: sink, volume: Math.max(...channels) / PACTL_NORM, muted, raw: channels };
    } catch (err) {
      if (device && isPactlGone(err)) return null;
      throw err;
    }
  }
  return {
    name: "pactl",
    addressable: true,
    same: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    // pactl stores the integers it is given and reads them back unchanged, so
    // only an exact readback is our own set.
    matches: (got, asked) => got.length === asked.length && got.every((v, i) => v === asked[i]),
    probe: () => run("pactl", ["get-default-sink"], C_LOCALE),
    read,
    scale: (raw, fraction) => raw.map((v) => Math.max(0, Math.round(v * fraction))),
    async write(device, raw) {
      await run(...pactl.setVolume(device, raw), C_LOCALE);
      return read(device);
    },
  };
}

// --- wpctl ------------------------------------------------------------------

const DEFAULT_SINK = "@DEFAULT_AUDIO_SINK@";

const wpctl = {
  inspect: (id) => ["wpctl", ["inspect", String(id)]],
  getVolume: (id) => ["wpctl", ["get-volume", String(id)]],
  // Four decimals: wpctl stores a float; anything coarser drifts on restore.
  setVolume: (id, volume) => ["wpctl", ["set-volume", String(id), volume.toFixed(4)]],
};

// "id 36, type PipeWire:Interface:Node\n ... * node.name = "auto_null"" →
// { id: 36, name: "auto_null" }. The node id alone can be reused by a device
// plugged in later, so the name goes with it.
function parseWpctlInspect(text) {
  const id = /^id\s+(\d+),/m.exec(String(text));
  if (!id) throw new Error(`unexpected wpctl inspect output: ${String(text).trim().slice(0, 80)}`);
  const name = /node\.name\s*=\s*"([^"]*)"/.exec(String(text));
  return { id: Number(id[1]), name: name ? name[1] : "" };
}

// "Volume: 0.40" or "Volume: 0.40 [MUTED]".
function parseWpctlVolume(text) {
  const m = /Volume:\s*([0-9]*\.?[0-9]+)(\s*\[MUTED\])?/.exec(String(text));
  if (!m) throw new Error(`unexpected wpctl volume output: ${String(text).trim().slice(0, 80)}`);
  return { volume: Number(m[1]), muted: !!m[2] };
}

const isWpctlGone = (err) => /not found/i.test(err?.message || "");

function createWpctlBackend(run) {
  // device = "<id>:<node.name>"
  async function read(device) {
    let node;
    try {
      node = parseWpctlInspect(await run(...wpctl.inspect(device ? device.split(":")[0] : DEFAULT_SINK)));
    } catch (err) {
      if (device && isWpctlGone(err)) return null;
      throw err;
    }
    const id = `${node.id}:${node.name}`;
    if (device && id !== device) return null; // the id now names another node
    // `get-volume` on a vanished id prints "not found" and still exits 0.
    const out = await run(...wpctl.getVolume(node.id));
    if (/not found/i.test(out)) {
      if (device) return null;
      throw new Error(out.trim());
    }
    const { volume, muted } = parseWpctlVolume(out);
    return { device: id, volume, muted, raw: volume };
  }
  return {
    name: "wpctl",
    addressable: true,
    // get-volume prints two decimals; the stored target is that readback.
    same: (a, b) => a === b,
    // scale() asks for two decimals and get-volume prints two: exact.
    matches: (got, asked) => got === asked,
    probe: () => run(...wpctl.inspect(DEFAULT_SINK)),
    read,
    // Two decimals: exactly what get-volume prints back, so the readback of
    // our own set is an exact match and any other value is someone else's.
    scale: (raw, fraction) => Math.max(0, Math.round(raw * fraction * 100) / 100),
    async write(device, raw) {
      await run(...wpctl.setVolume(device.split(":")[0], raw));
      return read(device);
    },
  };
}

// --- macOS --------------------------------------------------------------------

const osa = {
  get: () => ["osascript", ["-e", "get volume settings"]],
  // The level travels as argv, never spliced into the script text.
  set: (volume) => [
    "osascript",
    ["-e", "on run argv", "-e", "set volume output volume (item 1 of argv as integer)", "-e", "end run", String(volume)],
  ],
  // Which device is the default output. osascript can't say, and only ever
  // addresses the default, so this is the identity the ownership check uses.
  devices: () => ["system_profiler", ["SPAudioDataType", "-json"]],
};

// "output volume:44, input volume:75, alert volume:100, output muted:false".
// A device without a software volume (some HDMI/USB outputs) reports
// "output volume:missing value".
function parseOsaVolume(text) {
  const s = String(text);
  const vol = /output volume:\s*(\d+|missing value)/.exec(s);
  const mute = /output muted:\s*(true|false|missing value)/.exec(s);
  if (!vol) throw new Error(`unexpected osascript output: ${s.trim().slice(0, 80)}`);
  const raw = vol[1] === "missing value" ? null : Number(vol[1]);
  return { raw, volume: raw === null ? null : raw / 100, muted: mute?.[1] === "true" };
}

// The default output device in `system_profiler SPAudioDataType -json`: the
// item flagged coreaudio_default_audio_output_device, named with its
// transport so two outputs that share a name on different buses stay apart.
// null when none is flagged. Two outputs with the same name on the same
// transport (two identical USB DACs) can't be told apart, and osascript would
// write whichever is the default: that is refused rather than guessed.
function parseMacDefaultOutput(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    throw new Error("unexpected system_profiler output");
  }
  const outputs = [];
  let def = null;
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node && typeof node === "object") {
      if (typeof node._name === "string") {
        const id = `${node._name}|${node.coreaudio_device_transport || ""}`;
        const isDefault = node.coreaudio_default_audio_output_device === "spaudio_yes";
        if (isDefault || node.coreaudio_device_output !== undefined) outputs.push(id);
        if (isDefault) def = id;
      }
      stack.push(...Object.values(node));
    }
  }
  if (def && outputs.filter((id) => id === def).length > 1) {
    throw new Error(`two outputs are both named "${def.split("|")[0]}", so the one to restore can't be told apart`);
  }
  return def;
}

function createMacBackend(run) {
  async function read() {
    const device = parseMacDefaultOutput(await run(...osa.devices()));
    if (!device) throw new Error("macOS reports no default output device");
    const { raw, volume, muted } = parseOsaVolume(await run(...osa.get()));
    return { device, volume, muted, raw };
  }
  return {
    name: "osascript",
    // osascript only reaches the default device: read(device) reads whatever
    // is the default now (its `device` says which), and write() is refused
    // unless that is the device asked for.
    addressable: false,
    // The tool itself; a device problem (none, ambiguous) is read()'s to report.
    probe: async () => parseOsaVolume(await run(...osa.get())),
    read,
    scale: (raw, fraction) => Math.max(0, Math.min(100, Math.round(raw * fraction))),
    same: (a, b) => a === b,
    // Many outputs snap to 1/16 steps (6.25 points): up to ~3 points of
    // rounding; a volume-key press moves a whole step and is not mistaken.
    matches: (got, asked) => Math.abs(got - asked) <= 3,
    async write(device, raw) {
      const now = await read();
      if (now.device !== device) return null;
      await run(...osa.set(raw));
      // Volume first, right after the set: the slower device lookup must not
      // widen the window in which a user's change could pass for ours.
      const { raw: got, volume, muted } = parseOsaVolume(await run(...osa.get()));
      const after = parseMacDefaultOutput(await run(...osa.devices()));
      return { device: after, volume, muted, raw: got };
    },
  };
}

// --- Windows ------------------------------------------------------------------

// Core Audio through COM interop. Only the vtable slots before the ones used
// need to exist, in order; the placeholders stand for the methods skipped.
// The op, device id and level come from the environment (set by execFile, so
// no quoting), and the output is one JSON object.
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p);
  int UnregisterControlChangeNotify(IntPtr p);
  int GetChannelCount(out uint n);
  int SetMasterVolumeLevel(float db, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int GetMasterVolumeLevel(out float db);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float db);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(int access, out IntPtr store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class EarheartVolume {
  static string State(IMMDevice dev) {
    string id; Marshal.ThrowExceptionForHR(dev.GetId(out id));
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    IAudioEndpointVolume v = (IAudioEndpointVolume)o;
    float level; bool mute;
    Marshal.ThrowExceptionForHR(v.GetMasterVolumeLevelScalar(out level));
    Marshal.ThrowExceptionForHR(v.GetMute(out mute));
    return "{\"device\":\"" + id.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"volume\":" +
      level.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"muted\":" + (mute ? "true" : "false") + "}";
  }
  static IMMDevice Find(string id) {
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev;
    if (String.IsNullOrEmpty(id)) { Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev)); return dev; }
    if (e.GetDevice(id, out dev) != 0 || dev == null) return null;
    int state; dev.GetState(out state);
    return state == 1 ? dev : null; // DEVICE_STATE_ACTIVE
  }
  public static string Read(string id) {
    IMMDevice dev = Find(id);
    return dev == null ? "{\"gone\":true}" : State(dev);
  }
  public static string Set(string id, float level) {
    IMMDevice dev = Find(id);
    if (dev == null) return "{\"gone\":true}";
    Guid iid = typeof(IAudioEndpointVolume).GUID; object o; Guid ctx = Guid.Empty;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    Marshal.ThrowExceptionForHR(((IAudioEndpointVolume)o).SetMasterVolumeLevelScalar(level, ref ctx));
    return State(dev);
  }
}
'@
if ($env:EARHEART_VOLUME_OP -eq 'set') {
  [Console]::Out.Write([EarheartVolume]::Set($env:EARHEART_VOLUME_DEVICE, [float]::Parse($env:EARHEART_VOLUME_LEVEL, [System.Globalization.CultureInfo]::InvariantCulture)))
} else {
  [Console]::Out.Write([EarheartVolume]::Read($env:EARHEART_VOLUME_DEVICE))
}
`;

// Endpoint ids look like "{0.0.0.00000000}.{c3a1f2e4-...}"; anything else is
// refused before it reaches PowerShell.
const WIN_DEVICE_ID = /^[A-Za-z0-9{}.\-#_\\?&]{1,256}$/;

const winEncoded = Buffer.from(WIN_SCRIPT, "utf16le").toString("base64");

function winCommand(op, device, level) {
  if (device && !WIN_DEVICE_ID.test(device)) throw new Error("refusing an unexpected audio endpoint id");
  if (op === "set" && !(Number.isFinite(level) && level >= 0 && level <= 1)) throw new Error("volume out of range");
  return [
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", winEncoded],
    {
      windowsHide: true,
      env: {
        ...process.env,
        EARHEART_VOLUME_OP: op,
        EARHEART_VOLUME_DEVICE: device || "",
        EARHEART_VOLUME_LEVEL: op === "set" ? level.toFixed(4) : "",
      },
    },
  ];
}

function parseWinState(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim());
  } catch {
    throw new Error(`unexpected PowerShell output: ${String(text).trim().slice(0, 80)}`);
  }
  if (data.gone) return null;
  if (typeof data.device !== "string" || !Number.isFinite(data.volume) || typeof data.muted !== "boolean") {
    throw new Error("unexpected PowerShell output");
  }
  return { device: data.device, volume: data.volume, muted: data.muted, raw: data.volume };
}

function createWindowsBackend(run) {
  const call = async (op, device, level) => {
    const [cmd, args, opts] = winCommand(op, device, level);
    return parseWinState(await run(cmd, args, opts));
  };
  return {
    name: "powershell",
    addressable: true,
    same: (a, b) => Math.abs(a - b) < 1e-6,
    // The level goes in with four decimals and comes back as a float32.
    matches: (got, asked) => Math.abs(got - asked) <= 1e-4,
    probe: () => call("read"),
    async read(device) {
      const state = await call("read", device);
      if (!state && !device) throw new Error("no default output device");
      return state;
    },
    scale: (raw, fraction) => Math.max(0, Math.min(1, raw * fraction)),
    write: (device, raw) => call("set", device, raw),
  };
}

// --- selection ----------------------------------------------------------------

// The backends to try on `platform`, best first; the first whose probe answers
// is used.
function candidates(platform, run) {
  if (platform === "darwin") return [createMacBackend(run)];
  if (platform === "win32") return [createWindowsBackend(run)];
  if (platform === "linux") return [createPactlBackend(run), createWpctlBackend(run)];
  return [];
}

module.exports = {
  candidates,
  createPactlBackend,
  createWpctlBackend,
  createMacBackend,
  createWindowsBackend,
  pactl,
  wpctl,
  osa,
  winCommand,
  parsePactlVolume,
  parsePactlMute,
  parseWpctlInspect,
  parseWpctlVolume,
  parseOsaVolume,
  parseMacDefaultOutput,
  parseWinState,
  WIN_SCRIPT,
  PACTL_NORM,
};
