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
//   warm(), close()      optional: start the tool ahead of the first take, and
//                        let it go (Windows' long-lived PowerShell helper)
//
// Speed (#369): a lowering is read() then write(), issued the moment the
// first samples arrive, so every call before the set is time the user's
// background audio stays loud. Independent queries run in parallel, and
// write() sets first — the caller has just read the device.
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
      const [volumeOut, muteOut] = await Promise.all([
        run(...pactl.getVolume(sink), C_LOCALE),
        run(...pactl.getMute(sink), C_LOCALE),
      ]);
      const channels = parsePactlVolume(volumeOut);
      const muted = parsePactlMute(muteOut);
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
  // system_profiler is the slow one (most of a second): the volume query
  // runs alongside it.
  async function read() {
    const [profile, settings] = await Promise.all([run(...osa.devices()), run(...osa.get())]);
    const device = parseMacDefaultOutput(profile);
    if (!device) throw new Error("macOS reports no default output device");
    const { raw, volume, muted } = parseOsaVolume(settings);
    return { device, volume, muted, raw };
  }
  return {
    name: "osascript",
    // osascript only reaches the default device: read(device) reads whatever
    // is the default now (its `device` says which), and write() sets whatever
    // is the default and says which device that was afterwards.
    addressable: false,
    // The tool itself; a device problem (none, ambiguous) is read()'s to report.
    probe: async () => parseOsaVolume(await run(...osa.get())),
    read,
    scale: (raw, fraction) => Math.max(0, Math.min(100, Math.round(raw * fraction))),
    same: (a, b) => a === b,
    // Many outputs snap to 1/16 steps (6.25 points): up to ~3 points of
    // rounding; a volume-key press moves a whole step and is not mistaken.
    matches: (got, asked) => Math.abs(got - asked) <= 3,
    // Every caller has just read() the default device (lower, restore): the
    // set goes out at once, without a second system_profiler (#369; that
    // lookup cost most of a second and narrowed no window — a switch can land
    // between its answer and the set just the same). A switch before the set
    // shows up here: the readback names the device that is the default now,
    // and the controller keeps the marker for the one it meant.
    async write(device, raw) {
      await run(...osa.set(raw));
      // The volume query starts right after the set (alongside the slower
      // device lookup), so a user's change can't slip in behind ours.
      const [settings, profile] = await Promise.all([run(...osa.get()), run(...osa.devices())]);
      const { raw: got, volume, muted } = parseOsaVolume(settings);
      return { device: parseMacDefaultOutput(profile), volume, muted, raw: got };
    },
  };
}

// --- Windows ------------------------------------------------------------------

// Core Audio through COM interop. Only the vtable slots before the ones used
// need to exist, in order; the placeholders stand for the methods skipped.
// It runs as one long-lived helper (createWinHelper): requests arrive as JSON
// lines on stdin, and each answer is one JSON line.
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
# One helper per app run (#369): the shim above compiles once, then each
# request is one JSON line in and one out, a few milliseconds apiece. The
# request is data, never script: ConvertFrom-Json, and the device id and level
# were validated before they were sent. stdin closing (the app exiting) ends it.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = 0
  try {
    $req = ConvertFrom-Json $line
    $id = [int]$req.id
    if ($req.op -eq 'set') { $out = [EarheartVolume]::Set([string]$req.device, [float]$req.level) }
    else { $out = [EarheartVolume]::Read([string]$req.device) }
  } catch {
    $out = '{"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}'
  }
  [Console]::Out.WriteLine('{"id":' + $id + ',"r":' + $out + '}')
  [Console]::Out.Flush()
}
`;

// Endpoint ids look like "{0.0.0.00000000}.{c3a1f2e4-...}"; anything else is
// refused before it reaches PowerShell.
const WIN_DEVICE_ID = /^[A-Za-z0-9{}.\-#_\\?&]{1,256}$/;

const winEncoded = Buffer.from(WIN_SCRIPT, "utf16le").toString("base64");

const WIN_HELPER = [
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", winEncoded],
];

// One request line for the helper, validated: nothing else reaches PowerShell.
function winRequest(id, op, device, level) {
  if (device && !WIN_DEVICE_ID.test(device)) throw new Error("refusing an unexpected audio endpoint id");
  if (op === "set" && !(Number.isFinite(level) && level >= 0 && level <= 1)) throw new Error("volume out of range");
  const req = { id, op: op === "set" ? "set" : "read", device: device || "" };
  if (op === "set") req.level = Number(level.toFixed(4));
  return `${JSON.stringify(req)}\n`;
}

function parseWinState(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text.trim()) : text;
  } catch {
    throw new Error(`unexpected PowerShell output: ${String(text).trim().slice(0, 80)}`);
  }
  if (!data || typeof data !== "object") throw new Error("unexpected PowerShell output");
  if (typeof data.error === "string") throw new Error(data.error);
  if (data.gone) return null;
  if (typeof data.device !== "string" || !Number.isFinite(data.volume) || typeof data.muted !== "boolean") {
    throw new Error("unexpected PowerShell output");
  }
  return { device: data.device, volume: data.volume, muted: data.muted, raw: data.volume };
}

// The long-lived PowerShell behind the Windows backend (#369). Starting
// PowerShell and compiling the shim costs ~1–2 s; a lowering used to pay it on
// every call (probe, read, write: 3–5 s before the volume moved). Started
// once — ahead of the first take, see warm() — it answers each request in
// milliseconds. One request at a time; a request that times out kills the
// process, and the next one starts a fresh helper. close() lets it go
// (the feature turned off, quit); the next request starts it again.
function createWinHelper(spawn, { timeoutMs = 15000 } = {}) {
  let child = null;
  let buf = "";
  let stderr = "";
  let current = null; // { id, resolve, reject, timer }
  let nextId = 1;
  let queue = Promise.resolve();

  function settle(fn, value) {
    const c = current;
    if (!c) return;
    current = null;
    clearTimeout(c.timer);
    fn === "resolve" ? c.resolve(value) : c.reject(value);
  }

  function drop(proc, err) {
    if (child !== proc) return;
    child = null;
    try {
      proc.kill();
    } catch {}
    settle("reject", err);
  }

  function start() {
    const [cmd, args] = WIN_HELPER;
    const proc = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child = proc;
    buf = "";
    stderr = "";
    proc.stdout.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk) => {
      if (child !== proc) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not ours (a PowerShell warning, say)
        }
        if (current && msg?.id === current.id) settle("resolve", msg.r);
      }
    });
    proc.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    proc.on("error", (err) => drop(proc, err));
    // A write after PowerShell died (EPIPE) must not become an uncaught error.
    proc.stdin.on?.("error", (err) => drop(proc, err));
    proc.on("exit", (code) => drop(proc, new Error(stderr.trim() || `PowerShell exited (${code})`)));
    // Never what keeps a process alive: the app quits, or a script exits, with
    // the helper idle (stdin closing ends it).
    proc.unref?.();
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.unref?.();
  }

  function send(op, device, level) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const line = winRequest(id, op, device, level);
      if (!child) start();
      const proc = child;
      current = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => drop(proc, new Error(`PowerShell did not answer within ${timeoutMs} ms`)), timeoutMs),
      };
      try {
        proc.stdin.write(line);
      } catch (err) {
        drop(proc, err);
      }
    });
  }

  return {
    // Resolves to the request's raw result ({ device, volume, muted } |
    // { gone } | { error }), parsed by parseWinState.
    request(op, device, level) {
      const result = queue.then(() => send(op, device, level));
      queue = result.catch(() => {});
      return result;
    },
    close() {
      if (!child) return;
      const proc = child;
      child = null;
      try {
        proc.stdin.end();
      } catch {}
      try {
        proc.kill();
      } catch {}
      settle("reject", new Error("PowerShell helper closed"));
    },
    running: () => !!child,
  };
}

function createWindowsBackend(helper) {
  const call = async (op, device, level) => parseWinState(await helper.request(op, device, level));
  return {
    name: "powershell",
    addressable: true,
    same: (a, b) => Math.abs(a - b) < 1e-6,
    // The level goes in with four decimals and comes back as a float32.
    matches: (got, asked) => Math.abs(got - asked) <= 1e-4,
    probe: () => call("read"),
    // Start the helper (and compile the shim) ahead of the first take.
    warm: () => call("read").then(() => {}),
    close: () => helper.close(),
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
// `spawn` (child_process.spawn) starts the Windows helper.
function candidates(platform, run, { spawn = require("node:child_process").spawn, timeoutMs } = {}) {
  if (platform === "darwin") return [createMacBackend(run)];
  if (platform === "win32") return [createWindowsBackend(createWinHelper(spawn, { timeoutMs }))];
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
  winRequest,
  createWinHelper,
  WIN_HELPER,
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
