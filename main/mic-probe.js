// Which input devices are Bluetooth or virtual (#339). Chromium's device list
// can't say, so this asks the OS with a tool that ships with it — no npm
// dependency, like main/ducking/backends.js:
//
//   Linux    pactl -f json list sources   (PulseAudio / pipewire-pulse)
//   macOS    system_profiler SPAudioDataType -json
//   Windows  PowerShell Get-PnpDevice     (Bluetooth only; see below)
//
// A record is { name, bluetooth, virtual } with true / false / null (null =
// the tool didn't say). The renderer joins records to Chromium devices by a
// unique exact normalized name (renderer/mic-policy.js); anything it can't
// join stays "unknown" and is never hidden by a preference.
//
// The probe NEVER delays or fails a take: a missing tool, a timeout or garbage
// output resolves to []. Callers read the cache and refresh in the background.

const { execFileAsync } = require("./util/exec-file");

const TIMEOUT_MS = { win32: 8000, darwin: 6000 };

// --- parsers (pure; exported for the tests) ----------------------------------

// pactl -f json list sources → records. Monitor sources (the loopback of an
// output) are virtual; bluez devices are Bluetooth. A source with a bus
// (pci/usb/…) is physical, so both flags are false; with no hints, null.
function parsePactlSources(text) {
  let sources;
  try {
    sources = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(sources)) return [];
  const records = [];
  for (const source of sources) {
    const name = String(source?.description || "").trim();
    if (!name) continue;
    const props = source.properties || {};
    const id = String(source.name || "");
    const bluetooth =
      /^bluez_/.test(id) || String(props["device.api"] || "").startsWith("bluez") || props["device.bus"] === "bluetooth";
    const monitor = /\.monitor$/.test(id) || props["device.class"] === "monitor" || source.monitor_of_sink != null;
    const abstract = ["abstract", "filter"].includes(props["device.class"]);
    const virtual = monitor || abstract;
    const physical = Boolean(props["device.bus"]) || Boolean(props["device.api"]);
    records.push({
      name,
      bluetooth: bluetooth ? true : physical || virtual ? false : null,
      virtual: virtual ? true : physical ? false : null,
    });
  }
  return records;
}

// system_profiler SPAudioDataType -json → input devices with their transport.
function parseSystemProfiler(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const records = [];
  for (const group of Array.isArray(data?.SPAudioDataType) ? data.SPAudioDataType : []) {
    for (const item of Array.isArray(group?._items) ? group._items : []) {
      const name = String(item?._name || "").trim();
      const hasInput = Number(item?.coreaudio_device_input) > 0;
      if (!name || !hasInput) continue;
      const transport = String(item.coreaudio_device_transport || "").toLowerCase();
      if (!transport) {
        records.push({ name, bluetooth: null, virtual: null });
        continue;
      }
      records.push({
        name,
        bluetooth: transport.includes("bluetooth"),
        virtual: transport.includes("virtual") || transport.includes("aggregate"),
      });
    }
  }
  return records;
}

// Get-PnpDevice … | ConvertTo-Json → Bluetooth devices only. The friendly name
// of a Bluetooth PnP node rarely equals Chromium's "Microphone (Name)" label,
// so on Windows most devices stay unknown by design; virtual is never claimed.
function parsePnpDevices(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data ? [data] : [];
  const records = [];
  for (const item of list) {
    const name = String(item?.FriendlyName || "").trim();
    if (name && /^(BTHENUM|BTHHFENUM|BTH)/i.test(String(item?.InstanceId || ""))) {
      records.push({ name, bluetooth: true, virtual: null });
    }
  }
  return records;
}

const PS_COMMAND =
  "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'BTH*' } | " +
  "Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress";

// The command for a platform, or null where there is no probe.
function commandFor(platform) {
  if (platform === "linux") return { cmd: "pactl", args: ["-f", "json", "list", "sources"], parse: parsePactlSources, env: { LC_ALL: "C" } };
  if (platform === "darwin") return { cmd: "system_profiler", args: ["SPAudioDataType", "-json"], parse: parseSystemProfiler };
  if (platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", PS_COMMAND], parse: parsePnpDevices };
  }
  return null;
}

// --- cache --------------------------------------------------------------------

// createProbe({ platform, run, now, ttlMs }): get() is the cache, instant;
// refresh() runs the tool (one at a time) and resolves to the records, [] on
// any failure; stale() says whether a refresh is due. `available` is true once
// a probe returned at least one record — the Settings hint ("classification
// unavailable") reads it.
function createProbe({
  platform = process.platform,
  run = (cmd, args, opts) => execFileAsync(cmd, args, { timeout: TIMEOUT_MS[platform] ?? 3000, ...opts }),
  now = Date.now,
  ttlMs = 30000,
} = {}) {
  const command = commandFor(platform);
  let records = [];
  let at = -Infinity;
  let inflight = null;
  const refresh = () => {
    if (!command) return Promise.resolve([]);
    if (inflight) return inflight;
    const opts = command.env ? { env: { ...process.env, ...command.env } } : {};
    inflight = (async () => {
      try {
        records = command.parse(await run(command.cmd, command.args, opts));
      } catch {
        records = [];
      }
      at = now();
      return records;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  return {
    get: () => records,
    refresh,
    stale: () => now() - at > ttlMs,
    pending: () => inflight,
    available: () => records.length > 0,
  };
}

// --- Electron wiring ------------------------------------------------------------

// `mics:classes` answers from the cache at once and refreshes in the
// background when it is stale. `{ wait: ms }` (Settings, the wizard) waits for
// a first answer up to that long; the overlay passes nothing, so a take never
// waits on a slow tool.
let probe = null;

function init(ipcMain) {
  probe = createProbe();
  probe.refresh();
  ipcMain.handle("mics:classes", async (event, request) => {
    const wait = Math.min(Math.max(Number(request?.wait) || 0, 0), 10000);
    let inflight = probe.stale() ? probe.refresh() : probe.pending();
    if (wait > 0 && inflight && probe.get().length === 0) {
      await Promise.race([inflight, new Promise((resolve) => setTimeout(resolve, wait))]);
    }
    return { records: probe.get(), available: probe.available() };
  });
  return probe;
}

module.exports = {
  init,
  createProbe,
  commandFor,
  parsePactlSources,
  parseSystemProfiler,
  parsePnpDevices,
};
