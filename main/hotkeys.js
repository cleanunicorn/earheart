// Global hotkey registration.
//
// Electron's globalShortcut works on Windows, macOS and Linux/X11. On some
// Wayland desktops (notably GNOME) apps cannot grab global keys; for those,
// bind a system shortcut to `earheart --toggle` (and `earheart --pause`)
// instead — the second instance forwards the action to the running app and
// exits (see main.js).

const { globalShortcut } = require("electron");
const logger = require("./util/logger");
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
      error: `"${target[name].accelerator}" is already used by the ${otherName} hotkey`,
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
            error: `"${target.pause.accelerator}" is already used by the record hotkey`,
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
        ? `Invalid hotkey "${accelerator}": ${attempt.error.message}`
        : `Could not register "${accelerator}" (already in use, or your desktop blocks global shortcuts — see the Wayland note in Settings).`;
    }
    addedNames.push(name);
    return null;
  }

  function rollBack(failedName, failure) {
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
        : `Could not restore "${entry.accelerator}" after rollback${
            attempt.error ? `: ${attempt.error.message}` : ""
          }`;
      if (restoreError) {
        registered.delete(name);
        const unboundError = `${restoreError}. The ${name} hotkey is now unbound until you save again or restart.`;
        logger.warn(unboundError);
        results[name] = {
          ok: false,
          error: `${results[name].error}\n${unboundError}`,
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

function unregisterAll() {
  globalShortcut.unregisterAll();
  registered.clear();
}

// The pair layer treats either empty slot as a valid unbound state. Adapt that
// result to the app contract, where record is required but pause is optional.
function toHotkeyResults(pair) {
  return {
    hotkey: pair.record.empty
      ? { ok: false, empty: true, error: "No hotkey configured" }
      : pair.record,
    pauseHotkey: pair.pause,
  };
}

module.exports = { applyPair, toHotkeyResults, unregisterAll };
