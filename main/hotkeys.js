// Global hotkey registration.
//
// Electron's globalShortcut works on Windows, macOS and Linux/X11. On some
// Wayland desktops (notably GNOME) apps cannot grab global keys; for those,
// bind a system shortcut to `earheart --toggle` (and `earheart --pause`,
// `earheart --discard`) instead — the second instance forwards the action to the running app and
// exits (see main.js).

const { globalShortcut } = require("electron");
const logger = require("./util/logger");
const { prettyHotkey, registrationHint } = require("./util/hotkey-label");
const NAMES = ["record", "pause"];

// Named slots ("record", "pause"), each holding at most one accelerator and
// the callback needed to restore it if a pair update has to roll back.
const registered = new Map();

function attemptRegister(accelerator, onTrigger) {
  try {
    return globalShortcut.register(accelerator, onTrigger) ? { ok: true } : { ok: false };
  } catch (error) {
    return { ok: false, error };
  }
}

function collisionPlan(target, previous, changed, results) {
  if (!target.record.accelerator || target.record.accelerator !== target.pause.accelerator) {
    return null;
  }
  if (NAMES.every((name) => !previous.get(name))) {
    return { registerRecordOnly: true };
  }
  const collisionResults = { ...results };
  for (const name of changed) {
    const otherName = name === "record" ? "pause" : "record";
    collisionResults[name] = {
      ok: false,
      error: `"${prettyHotkey(target[name].accelerator)}" is already used by the ${otherName} hotkey`,
    };
  }
  return { results: collisionResults };
}

/**
 * Apply the record and pause hotkeys as one transaction.
 *
 * Free replacements are registered before their old shortcuts are released,
 * preserving the previous binding if Electron rejects the new one. A swap is
 * the exception: both shortcuts being exchanged must first be released. If
 * either new registration then fails, the complete previous pair is restored.
 *
 * @param {{record?: string, pause?: string, onRecord: () => void, onPause: () => void}} next
 * @returns {{record: {ok: boolean, empty?: boolean, error?: string}, pause: {ok: boolean, empty?: boolean, error?: string}}}
 */
function applyPair(next) {
  const target = {
    record: { accelerator: next.record || "", onTrigger: next.onRecord },
    pause: { accelerator: next.pause || "", onTrigger: next.onPause },
  };
  const previous = new Map(NAMES.map((name) => [name, registered.get(name)]));
  const changed = NAMES.filter(
    (name) => (previous.get(name)?.accelerator || "") !== target[name].accelerator
  );
  const results = Object.fromEntries(
    NAMES.map((name) => [
      name,
      target[name].accelerator ? { ok: true } : { ok: true, empty: true },
    ])
  );

  // Validate the requested final pair, rather than comparing one requested
  // slot with the other slot's current registration (which rejects swaps).
  const collision = collisionPlan(target, previous, changed, results);
  if (collision?.registerRecordOnly) {
    // Older versions could persist a rejected colliding pair. On a cold start,
    // preserve their record-first behavior so dictation still has its required
    // shortcut while Settings asks the user to choose a different pause key.
    const recordOnly = applyPair({ ...next, pause: "" });
    return {
      record: recordOnly.record,
      pause: recordOnly.record.ok
        ? {
            ok: false,
            error: `"${prettyHotkey(target.pause.accelerator)}" is already used by the record hotkey`,
          }
        : {
            ok: false,
            error: "Not changed: the record hotkey could not be registered",
          },
    };
  }
  if (collision) return collision.results;

  const currentAccelerators = new Set(
    NAMES.map((name) => previous.get(name)?.accelerator).filter(Boolean)
  );
  const nonEmpty = changed.filter((name) => target[name].accelerator);
  const freeNames = nonEmpty.filter((name) => !currentAccelerators.has(target[name].accelerator));
  const crossedNames = nonEmpty.filter((name) => currentAccelerators.has(target[name].accelerator));
  const addedNames = [];
  const releasedEntries = [];

  function tryRegister(name) {
    const { accelerator, onTrigger } = target[name];
    const attempt = attemptRegister(accelerator, onTrigger);
    if (!attempt.ok) {
      return attempt.error
        ? `Invalid hotkey "${prettyHotkey(accelerator)}": ${attempt.error.message}`
        : `Could not register "${prettyHotkey(accelerator)}" (${registrationHint()}).`;
    }
    addedNames.push(name);
    return null;
  }

  function rollBack(failedName, failure) {
    const retainColdStartRecord =
      !previous.get("record") &&
      !previous.get("pause") &&
      failedName === "pause" &&
      addedNames.length === 1 &&
      addedNames[0] === "record" &&
      releasedEntries.length === 0;
    if (retainColdStartRecord) {
      registered.set("record", target.record);
      results.pause = { ok: false, error: failure };
      return results;
    }
    for (const name of addedNames) {
      globalShortcut.unregister(target[name].accelerator);
    }
    for (const name of changed) {
      results[name] =
        name === failedName
          ? { ok: false, error: failure }
          : {
              ok: false,
              error: `Not changed: the ${failedName} hotkey could not be registered`,
            };
    }
    for (const [name, entry] of releasedEntries) {
      const attempt = attemptRegister(entry.accelerator, entry.onTrigger);
      const restoreError = attempt.ok
        ? null
        : `Could not restore "${prettyHotkey(entry.accelerator)}" after rollback${
            attempt.error ? `: ${attempt.error.message}` : ""
          }`;
      if (restoreError) {
        registered.delete(name);
        const unboundError = `${restoreError}. The ${name} hotkey is now unbound until you save again or restart.`;
        logger.warn(unboundError);
        const priorError = results[name].error.replace(/^Not changed: the /, "The ");
        const separator = /[.!?]$/.test(priorError) ? " " : ". ";
        // `unbound`: this result is about the slot itself — its saved hotkey
        // is gone — not only about the accelerator that was attempted.
        results[name] = {
          ok: false,
          unbound: true,
          error: `${priorError}${separator}${unboundError}`,
        };
      } else {
        registered.set(name, entry);
      }
    }
    return results;
  }

  // Preserve #132's no-drop behavior wherever the new accelerator is free.
  for (const name of freeNames) {
    const failure = tryRegister(name);
    if (failure) return rollBack(name, failure);
  }

  // Only crossed targets require an early release (including a direct swap).
  const crossedTargets = new Set(crossedNames.map((name) => target[name].accelerator));
  for (const name of NAMES) {
    const entry = previous.get(name);
    if (entry && crossedTargets.has(entry.accelerator)) {
      globalShortcut.unregister(entry.accelerator);
      releasedEntries.push([name, entry]);
    }
  }
  for (const name of crossedNames) {
    const failure = tryRegister(name);
    if (failure) return rollBack(name, failure);
  }

  const releasedNames = new Set(releasedEntries.map(([name]) => name));
  for (const name of changed) {
    const entry = previous.get(name);
    if (entry && !releasedNames.has(name)) globalShortcut.unregister(entry.accelerator);
    if (target[name].accelerator) registered.set(name, target[name]);
    else registered.delete(name);
  }
  return results;
}

// The discard slot. Unlike record and pause it is armed (registered with the
// OS) only while a dictation is live — a third global grab held all day would
// shadow some app's shortcut for nothing — so it lives outside the pair
// transaction: `accelerator` is the configured binding, `armed` whether the
// OS currently holds it for us.
const discard = { accelerator: "", onTrigger: null, armed: false, live: false };

function registrationFailure(accelerator, attempt) {
  return attempt.error
    ? `Invalid hotkey "${prettyHotkey(accelerator)}": ${attempt.error.message}`
    : `Could not register "${prettyHotkey(accelerator)}" (${registrationHint()}).`;
}

function usedBy(name, accelerator) {
  return `"${prettyHotkey(accelerator)}" is already used by the ${name} hotkey`;
}

// Take a new discard binding, or keep the old one and say why not. A changed
// accelerator is registered once on the spot, so a combination Electron
// rejects or another app holds fails at Save instead of silently mid-dictation;
// unless a dictation is live it is released straight away.
function setDiscard(accelerator, onTrigger) {
  discard.onTrigger = onTrigger;
  if (accelerator === discard.accelerator) {
    return accelerator ? { ok: true } : { ok: true, empty: true };
  }
  if (!accelerator) {
    if (discard.armed) globalShortcut.unregister(discard.accelerator);
    discard.armed = false;
    discard.accelerator = "";
    return { ok: true, empty: true };
  }
  const attempt = attemptRegister(accelerator, () => discard.onTrigger?.());
  if (!attempt.ok) return { ok: false, error: registrationFailure(accelerator, attempt) };
  if (discard.armed) globalShortcut.unregister(discard.accelerator);
  discard.accelerator = accelerator;
  // Keep the new binding held whenever a dictation is live — including one
  // whose old binding failed to arm — not only when the old one was held.
  discard.armed = discard.live && !suspended;
  if (!discard.armed) globalShortcut.unregister(accelerator);
  return { ok: true };
}

/**
 * Apply all three hotkeys: the record/pause pair as one transaction (see
 * applyPair), then the optional discard hotkey, which is armed only while a
 * dictation is live (see armDiscard).
 *
 * The three must differ. As in the pair, a collision is charged to the slot
 * that changed into it, and the other keeps working. When neither changed (a
 * hand-edited file at launch), discard — the optional, newest slot — yields
 * and stays unbound.
 *
 * @param {{record?: string, pause?: string, discard?: string,
 *   onRecord: () => void, onPause: () => void, onDiscard: () => void}} next
 * @returns {{record: object, pause: object, discard: object}}
 */
function applyAll(next) {
  // A save lands on live shortcuts, so every registration is really checked
  // against the OS; if a field is still capturing (another window's), the
  // hotkeys stand down again afterwards.
  const wasSuspended = suspended;
  suspend(false);
  try {
    return applyWithCorrection(next);
  } finally {
    if (wasSuspended) suspend(true);
  }
}

// The correction shortcut is always available, unlike the live-only discard
// shortcut, so it takes part in the dictation slots' transaction: a clash is
// charged to the slot that changed into it, and a swap or transfer with a
// dictation slot either completes or leaves both bindings as they were.
const DICTATION = ["record", "pause", "discard"];

// The accelerator each dictation slot holds now. Discard counts while idle
// (configured, not armed): it re-grabs that key at the next dictation.
function dictationAccelerators() {
  return {
    record: registered.get("record")?.accelerator || "",
    pause: registered.get("pause")?.accelerator || "",
    discard: discard.accelerator,
  };
}

function setCorrect(accelerator, onTrigger) {
  if (accelerator) registered.set("correct", { accelerator, onTrigger });
  else registered.delete("correct");
}

function applyWithCorrection(next) {
  if (next.correct === undefined && next.onCorrect === undefined) return applyLive(next);
  const desired = next.correct || "";
  const previous = registered.get("correct");
  const held = previous?.accelerator || "";
  const before = dictationAccelerators();
  const target = Object.fromEntries(DICTATION.map((name) => [name, next[name] || ""]));
  const dictation = { ...next };
  const charged = {};
  const keep = (name, error) => {
    dictation[name] = before[name];
    charged[name] = error;
  };
  const holderOf = (accelerator) => {
    const now = dictationAccelerators();
    return DICTATION.find((name) => accelerator && now[name] === accelerator);
  };
  const finish = (applied, correct) => {
    const out = { ...applied, correct };
    for (const name of Object.keys(charged)) out[name] = { ok: false, error: charged[name] };
    return out;
  };

  // A clash in the requested settings goes to the slot that changed into it.
  // When both changed — or on a cold start, where nothing is held yet — the
  // optional correction key yields, so dictation keeps its shortcut.
  let correctError = null;
  for (const name of DICTATION) {
    if (!desired || target[name] !== desired) continue;
    if (desired === held && target[name] !== before[name]) keep(name, usedBy("correction", desired));
    else correctError ??= usedBy(name, desired);
  }
  const goal = correctError ? held : desired;
  const ok = (accelerator) => (accelerator ? { ok: true } : { ok: true, empty: true });
  const notChanged = "Not changed: the correction hotkey could not be registered";

  if (goal === held) {
    // The correction key stays put: no dictation slot may take it.
    for (const name of DICTATION) {
      if (held && target[name] === held && !charged[name]) keep(name, usedBy("correction", held));
    }
    return finish(applyLive(dictation), correctError ? { ok: false, error: correctError } : ok(held));
  }

  // Dictation slots asking for the key the correction shortcut is leaving.
  const takers = DICTATION.filter((name) => held && target[name] === held && !charged[name]);

  if (!holderOf(goal)) {
    // The new key is free: grab it before releasing the old one.
    const attempt = goal ? attemptRegister(goal, next.onCorrect) : { ok: true };
    if (!attempt.ok) {
      for (const name of takers) keep(name, notChanged);
      return finish(applyLive(dictation), { ok: false, error: registrationFailure(goal, attempt) });
    }
    if (held) globalShortcut.unregister(held);
    setCorrect(goal, next.onCorrect);
    return finish(applyLive(dictation), ok(goal));
  }

  // A dictation slot holds the new key and should be moving off it. In a swap
  // it moves onto the correction key, which must be released first.
  const releasedEarly = takers.length > 0;
  if (releasedEarly) globalShortcut.unregister(held);
  let applied = applyLive(dictation);
  const blocker = holderOf(goal);
  const attempt = blocker ? null : attemptRegister(goal, next.onCorrect);
  if (attempt?.ok) {
    if (!releasedEarly) globalShortcut.unregister(held);
    setCorrect(goal, next.onCorrect);
    return finish(applied, ok(goal));
  }

  const error = blocker
    ? applied[blocker]?.ok === false
      ? `Not changed: the ${blocker} hotkey could not be registered`
      : usedBy(blocker, goal)
    : registrationFailure(goal, attempt);
  if (!releasedEarly) return finish(applied, { ok: false, error });

  // The swap failed halfway: a dictation slot may already hold the old
  // correction key. Put every dictation slot back, then retake that key.
  if (holderOf(held)) {
    // A combined transfer may have armed discard on an old record/pause key.
    // Release that grab before restoring the pair, otherwise rollback rejects
    // our own binding. Keep its configured value so applyLive still restores
    // discard to its original key and reports a real OS failure if it cannot.
    if (discard.armed && [before.record, before.pause].includes(discard.accelerator)) {
      globalShortcut.unregister(discard.accelerator);
      discard.armed = false;
    }
    const reverted = applyLive({ ...next, ...before });
    // If restoring discard itself fails, drop its temporary binding. Keeping
    // it could shadow the old correction key or re-arm a rejected setting.
    if (!reverted.discard.ok && discard.accelerator !== before.discard) {
      setDiscard("", next.onDiscard);
    }
    const restored = dictationAccelerators();
    applied = { ...reverted };
    for (const name of DICTATION) {
      if (restored[name] !== before[name]) {
        // applyPair preserves its current pair when a restore is refused.
        // Those are temporary settings here: release them rather than leaving
        // a rejected callback armed (possibly on the old correction key).
        if (name === "discard") setDiscard("", next.onDiscard);
        else {
          const temporary = registered.get(name);
          if (temporary) globalShortcut.unregister(temporary.accelerator);
          registered.delete(name);
        }
        if (before[name]) {
          const restoreError = `Could not restore "${prettyHotkey(before[name])}" after rollback. The saved ${name} hotkey is now unbound until you save again or restart.`;
          logger.warn(restoreError);
          applied[name] = { ok: false, unbound: true, error: restoreError };
        } else applied[name] = { ok: false, error: notChanged };
        continue;
      }
      if (target[name] !== before[name] && !charged[name]) {
        applied[name] = reverted[name].ok ? { ok: false, error: notChanged } : reverted[name];
      }
    }
  } else {
    for (const name of takers) {
      if (applied[name]?.ok !== false) applied[name] = { ok: false, error: notChanged };
    }
  }
  const back = attemptRegister(held, previous.onTrigger);
  if (!back.ok) {
    registered.delete("correct");
    const unbound = `Could not restore "${prettyHotkey(held)}" after rollback. The correction hotkey is now unbound until you save again or restart.`;
    logger.warn(unbound);
    const separator = /[.!?]$/.test(error) ? " " : ". ";
    return finish(applied, { ok: false, unbound: true, error: `${error}${separator}${unbound}` });
  }
  return finish(applied, { ok: false, error });
}

function applyLive(next) {
  const target = { record: next.record || "", pause: next.pause || "", discard: next.discard || "" };
  const previous = {
    record: registered.get("record")?.accelerator || "",
    pause: registered.get("pause")?.accelerator || "",
    discard: discard.accelerator,
  };
  const charged = {};
  if (target.discard) {
    for (const name of ["record", "pause"]) {
      if (target[name] !== target.discard) continue;
      const discardChanged = target.discard !== previous.discard;
      const otherChanged = target[name] !== previous[name];
      if (otherChanged && !discardChanged) charged[name] = usedBy("discard", target[name]);
      else charged.discard = usedBy(name, target.discard);
    }
  }
  const pairNext = { ...next };
  for (const name of ["record", "pause"]) {
    if (charged[name]) pairNext[name] = previous[name];
  }
  const pair = applyPair(pairNext);
  for (const name of ["record", "pause"]) {
    if (charged[name]) pair[name] = { ok: false, error: charged[name] };
  }

  // A pair slot that failed keeps its old binding, which can be the very key
  // discard asked for; that is a collision too, not a registration failure.
  const holder = ["record", "pause"].find(
    (name) => target.discard && registered.get(name)?.accelerator === target.discard
  );
  const discardError = charged.discard || (holder && usedBy(holder, target.discard));
  if (!discardError) return { ...pair, discard: setDiscard(target.discard, next.onDiscard) };
  discard.onTrigger = next.onDiscard;
  // Keep the old binding unless the pair now holds it (a cold start's file).
  const pairHeld = ["record", "pause"].some(
    (name) => registered.get(name)?.accelerator === discard.accelerator
  );
  if (discard.accelerator && pairHeld) setDiscard("", next.onDiscard);
  return { ...pair, discard: { ok: false, error: discardError } };
}

/**
 * Register the discard hotkey while a dictation is live, release it otherwise.
 * Idempotent. A failure is logged, not thrown: the overlay's ✕ and the tray's
 * Cancel still work, and Settings showed the binding working when it was saved.
 *
 * @param {boolean} live
 */
function armDiscard(live) {
  discard.live = live;
  // Suspended, the OS holds nothing; suspend(false) arms it if still live.
  if (suspended) return;
  if (live && !discard.armed && discard.accelerator) {
    const attempt = attemptRegister(discard.accelerator, () => discard.onTrigger?.());
    if (attempt.ok) discard.armed = true;
    else logger.warn(`discard hotkey: ${registrationFailure(discard.accelerator, attempt)}`);
  } else if (!live && discard.armed) {
    globalShortcut.unregister(discard.accelerator);
    discard.armed = false;
  }
}

// While Settings or the wizard captures a new combination, the global
// shortcuts must not hold the keys: the OS would swallow the press — the
// field never sees it, and the record hotkey starts a dictation instead of
// being typed back in. Suspending releases the OS grabs but keeps every
// binding, so resuming restores exactly what was registered.
let suspended = false;

/**
 * Release (true) or restore (false) every registered global hotkey without
 * changing the configured bindings. Idempotent. A binding that cannot be
 * restored is logged, left unbound, and named in the result so the caller
 * can re-apply and report it.
 *
 * @param {boolean} on
 * @returns {string[]} the slots ("record", "pause") that could not be restored
 */
function suspend(on) {
  if (on === suspended) return [];
  suspended = on;
  if (on) {
    for (const entry of registered.values()) globalShortcut.unregister(entry.accelerator);
    if (discard.armed) globalShortcut.unregister(discard.accelerator);
    discard.armed = false;
    return [];
  }
  const lost = [];
  for (const [name, entry] of [...registered]) {
    const attempt = attemptRegister(entry.accelerator, entry.onTrigger);
    if (!attempt.ok) {
      registered.delete(name);
      lost.push(name);
      logger.warn(`${name} hotkey: ${registrationFailure(entry.accelerator, attempt)} after capture`);
    }
  }
  armDiscard(discard.live);
  return lost;
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  registered.clear();
  discard.armed = false;
  suspended = false;
}

// The pair layer treats either empty slot as a valid unbound state. Adapt that
// result to the app contract, where record is required but pause is optional.
// Given the accelerators that were applied, each result also records its own,
// so a later reader (Settings, on open) can tell whether a failure still
// describes the value in the field.
function toHotkeyResults(pair, accelerators) {
  const results = {
    hotkey: pair.record.empty
      ? { ok: false, empty: true, error: "No hotkey configured" }
      : pair.record,
    pauseHotkey: pair.pause,
  };
  // Only applyAll reports a discard slot; a bare pair result keeps two keys.
  if (pair.discard) results.discardHotkey = pair.discard;
  if (pair.correct) results.correctHotkey = pair.correct;
  if (!accelerators) return results;
  const withAccelerators = {
    hotkey: { ...results.hotkey, accelerator: accelerators.hotkey || "" },
    pauseHotkey: { ...results.pauseHotkey, accelerator: accelerators.pauseHotkey || "" },
  };
  if (results.discardHotkey) {
    withAccelerators.discardHotkey = {
      ...results.discardHotkey,
      accelerator: accelerators.discardHotkey || "",
    };
  }
  if (results.correctHotkey) {
    withAccelerators.correctHotkey = {
      ...results.correctHotkey, accelerator: accelerators.correctHotkey || "",
    };
  }
  return withAccelerators;
}

module.exports = { applyPair, applyAll, armDiscard, suspend, toHotkeyResults, unregisterAll };
