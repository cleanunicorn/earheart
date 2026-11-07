// Lowers other apps' playback while Earheart is capturing, and puts it back.
//
// Pure of Electron: the OS backends (./backends.js), the marker store and the
// settings come in as arguments, so the whole lifecycle is unit-tested with a
// fake backend (test/ducking.test.js).
//
// Owners: every capture that wants the output lowered holds an owner key
// (setCapturing(owner, true)) and gives it back (setCapturing(owner, false)).
// The output is lowered while at least one owner holds it and the setting is
// on, and restored when the last one lets go — so overlapping sessions never
// lower twice or restore early, and a pause (owner released) restores until
// the resume takes it again.
//
// Work is serialized on one promise chain and setCapturing() never waits on
// it: the record → transcribe pipeline only flips a flag (golden rule 8 — a
// slow, failing or missing OS tool can't cost a dictation). Each pass compares
// what is wanted with what is held, so a burst of events collapses into the
// last one.
//
// Speed (#369): the lowering starts when the first samples arrive — the
// moment the overlay says "Listening…" — so only read() and write() may stand
// between that and the quieter output. The tool is probed (and on Windows its
// helper started) by prepare(), at launch and when the setting is turned on,
// never at the first take.
//
// Ownership: the restore writes the prior volume only when the device still
// reads exactly the level we set (in the tool's own units, see `same` in
// backends.js). A user who moved the volume during the take keeps their
// level; a muted output is never touched (and a mute during the take is left
// alone: only the level is restored). The restore addresses the device that
// was lowered, never whichever is the default now, so an output-device
// switch leaves the new device alone.
//
// Crash safety: before the volume is lowered a marker (mechanism, device,
// prior, target) is saved; it is cleared once the restore is settled. A
// marker found at launch is recovered by the same ownership rule. A backend
// that only reaches the default device (macOS) keeps the marker while another
// device is the default, and recovers it once the lowered device is back.

const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A probe that failed for a reason that can pass (the audio server not up yet
// at login, a PowerShell start that timed out under load) is tried again after
// this long; a missing tool or an unsupported platform is final.
const PROBE_RETRY_MS = 30 * 1000;

function createDucker({ backends, store, getConfig, logger = console, now = Date.now }) {
  const owners = new Set();
  let backendPromise = null;
  let retryAt = null; // when a passing probe failure may be tried again
  let backend = null;
  let held = null; // { device, prior, target } while the output is lowered
  let skipped = false; // decided not to lower for the current capture span
  let closed = false;
  let chain = Promise.resolve();
  let pending = 0;
  const status = {
    available: null, // null until probed
    mechanism: null,
    reason: "",
    state: "idle", // idle | lowered | skipped | pending (a restore waits for its device)
    detail: "",
    lastError: "",
  };

  // The first backend whose tool answers. Cached, including "none" — but a
  // failure that can pass is probed again after PROBE_RETRY_MS (#369: the probe
  // now runs at launch, which with start-on-login can be before the audio
  // server is up).
  function pick() {
    if (backendPromise && retryAt !== null && now() >= retryAt) {
      backendPromise = null;
      retryAt = null;
    }
    if (!backendPromise) {
      backendPromise = (async () => {
        let reason = backends.length ? "" : "not supported on this platform";
        let final = true; // every candidate missing, or none at all
        for (const candidate of backends) {
          try {
            await candidate.probe();
            backend = candidate;
            status.available = true;
            status.mechanism = candidate.name;
            status.reason = "";
            return candidate;
          } catch (err) {
            const missing = err?.code === "ENOENT" || /ENOENT/.test(err?.message || "");
            if (!missing) final = false;
            reason = missing ? `${candidate.name} not found` : `${candidate.name}: ${err?.message || err}`;
          }
        }
        if (!final) retryAt = now() + PROBE_RETRY_MS;
        status.available = false;
        status.reason = reason;
        logger.warn?.(`audio ducking unavailable: ${reason}`);
        return null;
      })();
    }
    return backendPromise;
  }

  const config = () => {
    const cfg = getConfig() || {};
    const level = Number.isFinite(cfg.levelPercent) ? cfg.levelPercent : 20;
    return { enabled: !!cfg.enabled, fraction: Math.min(1, Math.max(0, level / 100)) };
  };
  const wanted = () => !closed && owners.size > 0 && config().enabled;

  function fail(where, err) {
    status.lastError = `${where}: ${err?.message || err}`;
    logger.warn?.(`audio ducking: ${status.lastError}`);
  }

  // Whether the marker is on disk.
  function saveMarker(entry) {
    try {
      store.save({ ...entry, mechanism: backend.name, at: now() });
      return true;
    } catch (err) {
      fail("could not save the restore marker", err);
      return false;
    }
  }
  function clearMarker() {
    try {
      store.clear();
    } catch (err) {
      fail("could not clear the restore marker", err);
    }
  }
  function loadMarker() {
    try {
      return store.load();
    } catch {
      return null;
    }
  }

  // Put a marker's device back when it still sits at the lowered level.
  // Resolves "restored" | "changed" | "gone" | "elsewhere" (a non-addressable
  // backend whose default device is another one: nothing was touched).
  async function settle({ device, prior, target }) {
    const cur = await backend.read(device);
    if (!cur) return "gone";
    if (cur.device !== device) return "elsewhere";
    if (!backend.same(cur.raw, target)) return "changed";
    const after = await backend.write(device, prior);
    if (!after) return "gone";
    // macOS: the default moved between the read and the set. The marker stays
    // and the lowered device is settled again once it is back.
    return after.device === device ? "restored" : "elsewhere";
  }

  // A marker left by a crash, a failed restore, or a device switch on a
  // backend that can't address the lowered device.
  async function recoverMarker() {
    const marker = loadMarker();
    if (!marker) return;
    if (!marker.mechanism || now() - (marker.at || 0) > MARKER_MAX_AGE_MS) return clearMarker();
    const b = await pick();
    if (!b || b.name !== marker.mechanism) return clearMarker();
    try {
      const result = await settle(marker);
      if (result === "elsewhere") return; // try again when that device is back
      logger.info?.(`audio ducking: earlier lowering ${result === "restored" ? "restored" : `left as is (${result})`}`);
      clearMarker();
    } catch (err) {
      fail("could not restore an earlier lowering", err);
    }
  }

  // Not lowering for the rest of this capture span, and why (Settings shows it).
  function skip(detail) {
    skipped = true;
    status.state = "skipped";
    status.detail = detail;
  }

  async function lower() {
    const b = await pick();
    if (!b) {
      skip(status.reason);
      return;
    }
    // A marker still pending (macOS device switch, failed restore) comes first,
    // so its prior level is never mistaken for the user's.
    if (loadMarker()) await recoverMarker();
    if (loadMarker()) {
      skip("an earlier lowering is still waiting to be restored");
      return;
    }
    let cur;
    try {
      cur = await b.read();
    } catch (err) {
      skip("could not read the output volume");
      return fail("could not read the output volume", err);
    }
    if (cur.volume === null) {
      skip("the output device has no volume control");
      return;
    }
    if (cur.muted || cur.volume <= 0) {
      skip("output is muted, left as is");
      return;
    }
    const targetRaw = b.scale(cur.raw, config().fraction);
    if (b.same(targetRaw, cur.raw)) {
      skip("output already at or below the lowered level");
      return;
    }
    // The marker lands before the volume moves: a crash in between restores
    // (or, the write never having landed, finds the volume changed and leaves it).
    // No marker, no lowering: a crash would leave nothing to restore from.
    if (!saveMarker({ device: cur.device, prior: cur.raw, target: targetRaw })) {
      return skip("could not save the restore marker");
    }
    let after;
    try {
      after = await b.write(cur.device, targetRaw);
    } catch (err) {
      fail("could not lower the output volume", err);
      // The write may have landed (a timeout) or not: look. Still the prior
      // level → nothing is held. What was asked for → hold that readback.
      // Unreadable, or (macOS) another device is the default now → hold the
      // asked-for level and keep the marker (the restore's exact check writes
      // only if that is what reads back; a switched device is recovered when
      // it is back). Anything else on this device is someone else's change:
      // leave it, and hold nothing.
      let seen = null;
      try {
        seen = await b.read(cur.device);
      } catch {}
      const mine = seen && seen.device === cur.device;
      if (mine && b.same(seen.raw, cur.raw)) {
        clearMarker();
        return skip("could not lower the output volume");
      }
      if (mine && !b.matches(seen.raw, targetRaw)) {
        clearMarker();
        return skip("the volume changed while it was being lowered");
      }
      held = { device: cur.device, prior: cur.raw, target: mine ? seen.raw : targetRaw };
      saveMarker(held);
      // The set landed after all: the output IS lowered, so Settings must not
      // lead with the timeout (it is in the log).
      status.state = "lowered";
      status.detail = "";
      status.lastError = "";
      return;
    }
    if (!after) {
      // Nothing was written: the device is gone, or (macOS) another device
      // became the default before the set.
      clearMarker();
      return skip("the output device changed");
    }
    if (after.device !== cur.device) {
      // The set landed, then the default moved on before the readback
      // (macOS). Hold what was asked for and keep the marker: the restore
      // finds the device "elsewhere" and leaves it to be recovered when back.
      held = { device: cur.device, prior: cur.raw, target: targetRaw };
      status.state = "lowered";
      status.detail = "";
      status.lastError = "";
      return;
    }
    if (!b.matches(after.raw, targetRaw)) {
      // Someone else moved the volume between the set and the readback: it
      // is theirs now, so nothing is held and the restore will not touch it.
      clearMarker();
      return skip("the volume changed while it was being lowered");
    }
    held = { device: cur.device, prior: cur.raw, target: after.raw };
    saveMarker(held);
    status.state = "lowered";
    status.detail = "";
    status.lastError = "";
  }

  async function restore() {
    const h = held;
    held = null;
    status.state = "idle";
    try {
      const result = await settle(h);
      if (result === "elsewhere") {
        logger.info?.("audio ducking: output device switched; the lowered device is restored when it is back");
        // Marker kept; say so now rather than at the next take.
        status.state = "pending";
        status.detail = "the output that was lowered is restored once it is the default again";
        return;
      }
      if (result !== "restored") logger.info?.(`audio ducking: left the volume as is (${result})`);
      clearMarker();
    } catch (err) {
      // Marker kept: the next lowering or launch tries again.
      fail("could not restore the output volume", err);
    }
  }

  async function reconcile() {
    for (;;) {
      if (wanted()) {
        if (held || skipped) return;
        await lower();
      } else {
        skipped = false;
        if (status.state === "skipped") {
          // A restore still waiting for its device stays visible between takes.
          const waiting = backend && !backend.addressable && loadMarker();
          status.state = waiting ? "pending" : "idle";
          if (waiting) status.detail = "the output that was lowered is restored once it is the default again";
        }
        if (!held) return;
        await restore();
      }
    }
  }

  function kick() {
    pending++;
    chain = chain
      .then(reconcile)
      .catch((err) => fail("unexpected", err))
      .finally(() => pending--);
    return chain;
  }

  // Off with nothing left to restore: let a long-lived tool go (Windows).
  function release() {
    if (!wanted() && !held && !config().enabled) backend?.close?.();
  }

  // Have the tool ready before the first take (#369). Off: let it go once
  // whatever is queued has settled.
  function prepare() {
    if (closed) return chain;
    if (!config().enabled) {
      chain = chain.then(release);
      return chain;
    }
    return pick()
      .then((b) => b?.warm?.())
      .catch((err) => logger.info?.(`audio ducking: could not start ${backend?.name || "the volume tool"} ahead of time: ${err?.message || err}`));
  }

  return {
    // Synchronous for the caller; returns the settled work for tests.
    setCapturing(owner, live) {
      if (closed) return chain;
      if (live) owners.add(owner);
      else owners.delete(owner);
      return kick();
    },
    // Settings changed (turned off mid-take restores; on mid-take lowers).
    refresh: () => Promise.all([kick(), prepare()]),
    // Launch: start the tool now, when the feature is on.
    prepare,
    // Launch: settle what a crash or a failed restore left behind.
    recover() {
      pending++;
      chain = chain.then(recoverMarker).catch((err) => fail("unexpected", err)).finally(() => pending--);
      return chain;
    },
    // Quit: release everything and wait (bounded) for the restore.
    shutdown(timeoutMs = 2000) {
      owners.clear();
      const done = kick().finally(() => backend?.close?.());
      closed = true;
      let timer;
      return Promise.race([done, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]).finally(() => clearTimeout(timer));
    },
    // Exit: stop a long-lived tool (the Windows helper) now.
    close: () => backend?.close?.(),
    // Whether quitting now would leave the output lowered.
    holding: () => !closed && (!!held || pending > 0),
    async getStatus() {
      await pick();
      return { ...status, enabled: config().enabled };
    },
    _state: () => ({ owners: [...owners], held, skipped, closed }),
  };
}

// A JSON file written atomically (temp + rename), for the restore marker.
function createFileStore(file, fs = require("node:fs")) {
  return {
    load() {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return data && typeof data === "object" ? data : null;
      } catch (err) {
        if (err.code === "ENOENT") return null;
        return null;
      }
    },
    save(entry) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

module.exports = { createDucker, createFileStore, MARKER_MAX_AGE_MS, PROBE_RETRY_MS };
