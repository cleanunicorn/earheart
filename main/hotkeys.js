// Global hotkey registration.
//
// Electron's globalShortcut works on Windows, macOS and Linux/X11. On some
// Wayland desktops (notably GNOME) apps cannot grab global keys; for those,
// bind a system shortcut to `earheart --toggle` (and `earheart --pause`)
// instead — the second instance forwards the action to the running app and
// exits (see main.js).

const { globalShortcut } = require("electron");

// Named slots ("record", "pause"), each holding at most one accelerator and
// the callback needed to restore it if a pair update has to roll back.
const registered = new Map();

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
  const names = ["record", "pause"];
  const target = {
    record: { accelerator: next.record || "", onTrigger: next.onRecord },
    pause: { accelerator: next.pause || "", onTrigger: next.onPause },
  };
  const previous = new Map(names.map((name) => [name, registered.get(name)]));
  const changed = names.filter(
    (name) => (previous.get(name)?.accelerator || "") !== target[name].accelerator
  );
  const results = Object.fromEntries(
    names.map((name) => [
      name,
      target[name].accelerator ? { ok: true } : { ok: true, empty: true },
    ])
  );

  // Validate the requested final pair, rather than comparing one requested
  // slot with the other slot's current registration (which rejects swaps).
  if (target.record.accelerator && target.record.accelerator === target.pause.accelerator) {
    // Older versions could persist a rejected colliding pair. On a cold start,
    // preserve their record-first behavior so dictation still has its required
    // shortcut while Settings asks the user to choose a different pause key.
    if (names.every((name) => !previous.get(name))) {
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
    for (const name of changed) {
      const otherName = name === "record" ? "pause" : "record";
      results[name] = {
        ok: false,
        error: `"${target[name].accelerator}" is already used by the ${otherName} hotkey`,
      };
    }
    return results;
  }

  const currentAccelerators = new Set(
    names.map((name) => previous.get(name)?.accelerator).filter(Boolean)
  );
  const nonEmpty = changed.filter((name) => target[name].accelerator);
  const free = nonEmpty.filter((name) => !currentAccelerators.has(target[name].accelerator));
  const crossed = nonEmpty.filter((name) => currentAccelerators.has(target[name].accelerator));
  const added = [];
  const released = [];

  function tryRegister(name) {
    const { accelerator, onTrigger } = target[name];
    try {
      if (!globalShortcut.register(accelerator, onTrigger)) {
        return `Could not register "${accelerator}" (already in use, or your desktop blocks global shortcuts — see the Wayland note in Settings).`;
      }
      added.push(name);
      return null;
    } catch (err) {
      return `Invalid hotkey "${accelerator}": ${err.message}`;
    }
  }

  function rollBack(failedName, failure) {
    for (const name of added) {
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
    for (const [name, entry] of released) {
      let restoreError = null;
      try {
        if (!globalShortcut.register(entry.accelerator, entry.onTrigger)) {
          restoreError = `Could not restore "${entry.accelerator}" after rollback`;
        }
      } catch (err) {
        restoreError = `Could not restore "${entry.accelerator}" after rollback: ${err.message}`;
      }
      if (restoreError) {
        registered.delete(name);
        results[name] = {
          ok: false,
          error: `${results[name].error}; ${restoreError}`,
        };
      } else {
        registered.set(name, entry);
      }
    }
    return results;
  }

  // Preserve #132's no-drop behavior wherever the new accelerator is free.
  for (const name of free) {
    const failure = tryRegister(name);
    if (failure) return rollBack(name, failure);
  }

  // Only crossed targets require an early release (including a direct swap).
  const crossedTargets = new Set(crossed.map((name) => target[name].accelerator));
  for (const name of names) {
    const entry = previous.get(name);
    if (entry && crossedTargets.has(entry.accelerator)) {
      globalShortcut.unregister(entry.accelerator);
      released.push([name, entry]);
    }
  }
  for (const name of crossed) {
    const failure = tryRegister(name);
    if (failure) return rollBack(name, failure);
  }

  const releasedNames = new Set(released.map(([name]) => name));
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

module.exports = { applyPair, unregisterAll };
