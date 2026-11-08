// Automatic microphone selection (#339): a pure policy, shared by the overlay
// (take start) and the Settings/wizard pages (preview). No DOM, no Electron.
//
// Chromium's MediaDeviceInfo only gives { deviceId, label, groupId }, so
// whether a device is Bluetooth or virtual comes from a main-process probe
// (main/mic-probe.js): records { name, bluetooth, virtual } where each flag is
// true, false, or null (unknown). A record joins a device ONLY on a unique
// exact normalized name — a name that appears twice on either side joins
// nothing, and the device stays "unknown". Unknown is never excluded by the
// Bluetooth/virtual preferences (that could hide a real microphone); it just
// ranks below a device known to be eligible.
//
// Modes: "manual" (default) keeps today's behaviour — the saved device, or the
// system default when none is saved. "auto" ranks the present devices. The
// saved device id is never touched here: resolution only returns a choice.

// Chromium's aliases for "whatever the OS routes to". They are not devices.
const PSEUDO_DEVICE_IDS = ["default", "communications"];

function isPseudoDevice(device) {
  return PSEUDO_DEVICE_IDS.includes(device?.deviceId);
}

// Case-fold, trim, collapse whitespace, and strip what Chromium adds around a
// device's own name: the "Default - " / "Communications - " prefix of the
// alias entries and a trailing "(vid:pid)" on Linux/Windows USB labels.
function normalizeLabel(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(default|communications) - /, "")
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/, "")
    .trim();
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) || 0) + 1);
  return counts;
}

// Attach { bluetooth, virtual } (true | false | null) to each real device.
// Pseudo-devices are dropped: they are never ranked as their own device.
function classifyDevices(devices, records) {
  const real = (devices || []).filter((d) => d && (!d.kind || d.kind === "audioinput") && !isPseudoDevice(d));
  const labelCounts = countBy(real, (d) => normalizeLabel(d.label));
  const recordList = (records || []).filter((r) => r && normalizeLabel(r.name));
  const recordCounts = countBy(recordList, (r) => normalizeLabel(r.name));
  return real.map((device) => {
    const name = normalizeLabel(device.label);
    let record = null;
    if (name && labelCounts.get(name) === 1 && recordCounts.get(name) === 1) {
      record = recordList.find((r) => normalizeLabel(r.name) === name);
    }
    const flag = (value) => (value === true || value === false ? value : null);
    return {
      deviceId: device.deviceId,
      label: device.label,
      groupId: device.groupId,
      bluetooth: record ? flag(record.bluetooth) : null,
      virtual: record ? flag(record.virtual) : null,
    };
  });
}

// The real device behind Chromium's "default" entry, or null when it cannot be
// told apart (no alias, no unique match). groupId is the reliable link; the
// label (minus "Default - ") is the fallback and must be unique.
function osDefaultDevice(devices, classified) {
  const alias = (devices || []).find((d) => d?.deviceId === "default");
  if (!alias) return null;
  if (alias.groupId) {
    const byGroup = classified.filter((d) => d.groupId && d.groupId === alias.groupId);
    if (byGroup.length === 1) return byGroup[0];
    if (byGroup.length > 1) return null;
  }
  const name = normalizeLabel(alias.label);
  if (!name) return null;
  const byLabel = classified.filter((d) => normalizeLabel(d.label) === name);
  return byLabel.length === 1 ? byLabel[0] : null;
}

function excludedByPreference(device, prefs) {
  if (device.bluetooth === true && !prefs.includeBluetooth) return "bluetooth";
  if (device.virtual === true && !prefs.includeVirtual) return "virtual";
  return null;
}

function known(device) {
  return device.bluetooth === false && device.virtual === false;
}

const fallbackChoice = (saved) => (saved ? saved : "");

// resolveMicrophone: what to open for a take.
//   { mode, savedId, includeBluetooth, includeVirtual, devices, records }
// → { deviceId, source, notice }
//   deviceId  "" = system default, else an exact id
//   source    "manual" | "os-default" | "ranked" | "saved" (auto, nothing
//             usable known → the saved choice or system default) | "fallback"
//             (auto, every present device excluded by a preference)
//   label     the chosen device's name when known (for the Settings preview)
//   notice    non-empty only when auto could not honour the preferences, so the
//             overlay can show the fallback instead of doing it silently
function resolveMicrophone(input = {}) {
  const savedId = typeof input.savedId === "string" ? input.savedId : "";
  if (input.mode !== "auto") {
    return { deviceId: savedId, source: "manual", notice: "" };
  }
  const prefs = {
    includeBluetooth: input.includeBluetooth !== false,
    includeVirtual: input.includeVirtual !== false,
  };
  const devices = Array.isArray(input.devices) ? input.devices : [];
  const classified = classifyDevices(devices, input.records);
  // No usable list (permission not granted, labels hidden, nothing plugged in):
  // do what manual mode would.
  const labelled = classified.filter((d) => normalizeLabel(d.label));
  if (labelled.length === 0) {
    return { deviceId: fallbackChoice(savedId), source: "saved", notice: "" };
  }
  const eligible = classified.filter((d) => !excludedByPreference(d, prefs));
  if (eligible.length === 0) {
    // The preferred class is absent: a Bluetooth-only or virtual-only machine
    // must still record. The system default is the one choice the OS vouches
    // for; say so.
    const why = classified.every((d) => excludedByPreference(d, prefs) === "bluetooth")
      ? "Only Bluetooth microphones found"
      : "No eligible microphone found";
    return { deviceId: "", source: "fallback", notice: `${why} — using system default` };
  }
  const osDefault = osDefaultDevice(devices, classified);
  if (osDefault && eligible.includes(osDefault)) {
    // "" follows the OS if its default changes, rather than pinning an id.
    return { deviceId: "", source: "os-default", notice: "", label: osDefault.label };
  }
  const best = eligible.find(known) || eligible[0];
  return { deviceId: best.deviceId, source: "ranked", notice: "", label: best.label };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PSEUDO_DEVICE_IDS,
    normalizeLabel,
    classifyDevices,
    osDefaultDevice,
    resolveMicrophone,
  };
}
