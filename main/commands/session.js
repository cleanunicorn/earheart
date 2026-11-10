// The voice command state machine (#344), free of Electron so every race in it
// can be tested: capture the selection, record the spoken instruction (the
// dictation pipeline's recorder and STT, handed over before cleanup), run the
// transform, then show input and output for an explicit Apply or Copy.
//
//   idle ─begin─▶ capturing ─▶ recording ─▶ transcribing ─▶ transforming ─▶ ready ─apply─▶ applying ─▶ applied
//                    │            │              │               │            │ ▲             │
//                    └────────────┴──── cancel / failure ────────┴─▶ failed   └─┴ (retry)     └─▶ ready (+ note)
//
// Rules this file exists to keep:
//  * Every call from outside carries the command id; a new command bumps it,
//    so a stale window, a late transform result or a cancelled recording can
//    never act on the current one.
//  * The spoken instruction and the captured selection stay on screen through
//    any failure. Nothing is ever pasted except a validated, non-empty,
//    complete transform output, by an explicit Apply, over a target that is
//    still the one the selection was captured from.
//  * Content (selection, instruction, output) is never logged.

const {
  MAX_INSTRUCTION_CHARS,
  TRANSFORM_TRUNCATED_MESSAGE,
  TRANSFORM_EMPTY_MESSAGE,
} = require("../util/transform-turn");

const BUSY = new Set(["capturing", "recording", "transcribing", "transforming", "applying"]);

const isAbort = (err) =>
  err?.name === "AbortError" || err?.message === "aborted" || err?.message === "cleanup cancelled";

/** How a transform error is shown and whether another try could help. */
function classify(err, { timedOut, timeoutMs }) {
  if (timedOut) {
    return { kind: "timeout", message: `The command took longer than ${Math.round(timeoutMs / 1000)} s` };
  }
  if (isAbort(err)) {
    return { kind: "failed", message: "The command was interrupted. Retry when dictation has finished." };
  }
  const message = String(err?.message || "The command failed");
  if (message === TRANSFORM_TRUNCATED_MESSAGE) return { kind: "truncated", message };
  if (message === TRANSFORM_EMPTY_MESSAGE) return { kind: "empty", message: "The model returned no text" };
  if (err?.code === "SERVICE_TIMEOUT") return { kind: "timeout", message };
  return { kind: "failed", message };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig                    settings.commands (read per command)
 * @param {{capture(signal?: AbortSignal): Promise<object>}} deps.selection
 * @param {{captureSupport(): object, fingerprintSupport(): object, fingerprint(signal?: AbortSignal): Promise<{id: string, label?: string}|null>}} deps.platform
 * @param {(request: object, signal: AbortSignal) => Promise<string>} deps.transform
 * @param {(handlers: {onTranscript: Function, onEnd: Function}) => number|false} deps.startRecording  pipeline: returns the recording sid
 * @param {() => void} deps.stopRecording
 * @param {() => void} deps.cancelRecording
 * @param {(text: string) => void} deps.writeClipboard
 * @param {(text: string, signal: AbortSignal) => Promise<{method: string, note?: string}>} deps.paste  replaces the selection
 * @param {(view: object|null) => void} deps.onView
 * @param {{info(...a: any[]): void, warn(...a: any[]): void}} [deps.logger]
 */
function createCommandSession(deps) {
  const log = deps.logger || { info() {}, warn() {} };
  let id = 0;
  let cmd = null; // the current command's data; null when idle

  const view = () => {
    if (!cmd) return null;
    const apply = applyState();
    return {
      id: cmd.id,
      phase: cmd.phase,
      mode: cmd.selection ? "rewrite" : "draft",
      selection: cmd.selection,
      instruction: cmd.instruction,
      output: cmd.output,
      error: cmd.error,
      notice: cmd.notice,
      captureNote: cmd.captureNote,
      remote: cmd.remote,
      canApply: cmd.phase === "ready" && apply.ok,
      applyNote: cmd.phase === "ready" && !apply.ok ? apply.reason : null,
      canCopy: cmd.output !== null,
      canRetry: (cmd.phase === "failed" || cmd.phase === "ready") && cmd.instruction !== null && !cmd.recordingFailed,
    };
  };
  const push = () => deps.onView(view());

  function applyState() {
    if (!cmd || cmd.output === null) return { ok: false, reason: null };
    if (!cmd.config.allowApply) return { ok: false, reason: "Apply is turned off in Settings → Commands. Copy the result instead." };
    if (!cmd.target) return { ok: false, reason: cmd.targetNote || "This window can't be identified, so the result can only be copied." };
    return { ok: true };
  }

  function set(patch) {
    Object.assign(cmd, patch);
    push();
  }

  // The command everything below acts on, or null when `commandId` is stale.
  const current = (commandId) => (cmd && cmd.id === commandId ? cmd : null);

  function teardown(c) {
    c.abort?.abort();
  }

  /** Start a command. A command still running is cancelled first. */
  async function begin() {
    if (cmd && cmd.phase === "recording") {
      deps.stopRecording();
      set({ phase: "transcribing" });
      return { ok: true, stopped: true };
    }
    if (cmd && BUSY.has(cmd.phase)) return { ok: false, busy: true };
    if (cmd) teardown(cmd);
    const config = deps.getConfig();
    const c = (cmd = {
      id: ++id,
      phase: "capturing",
      config,
      remote: config.engine === "remote",
      selection: "",
      instruction: null,
      output: null,
      error: null,
      notice: null,
      captureNote: null,
      target: null,
      targetNote: null,
      recordingSid: null,
      abort: new AbortController(),
      run: 0,
    });
    push();
    const { signal } = c.abort;

    // 1. The selection. A failure is not fatal: it becomes a draft from the
    //    brief, said plainly on the card, unless the user cancels.
    const fp = deps.platform.fingerprintSupport();
    try {
      const captured = await deps.selection.capture(signal);
      if (cmd !== c || signal.aborted) return { ok: false, cancelled: true };
      if (captured.ok) c.selection = captured.text;
      else if (captured.reason === "cancelled") return { ok: false, cancelled: true };
      else {
        c.captureNote = captured.message;
        // Only a genuinely empty selection makes this a draft that may be
        // pasted. If the selection (or a secure field) exists but couldn't be
        // read, a draft pasted there would overwrite it: Copy only.
        if (captured.reason === "empty") c.draftAtCursor = true;
        else c.unreadable = captured.message;
      }
      log.info(`command ${c.id}: selection ${captured.ok ? "captured" : `unavailable (${captured.reason})`}`);

      // 2. Who is focused right now: the only place Apply may paste later.
      if (c.unreadable) {
        c.targetNote = `${c.unreadable}. The result can only be copied, not pasted over it.`;
      } else if (fp.ok) {
        const found = await deps.platform.fingerprint(signal);
        if (cmd !== c || signal.aborted) return { ok: false, cancelled: true };
        if (found) c.target = found;
        else c.targetNote = "Couldn't identify the focused window, so the result can only be copied.";
      } else {
        c.targetNote = fp.reason;
      }
    } catch (err) {
      if (cmd !== c || signal.aborted || isAbort(err)) return { ok: false, cancelled: true };
      c.captureNote = "Couldn't read the selection";
      log.warn(`command ${c.id}: capture failed: ${err.message}`);
    }

    // 3. Record the spoken instruction.
    const sid = deps.startRecording({
      onTranscript: (rsid, text) => onTranscript(c, rsid, text),
      onEnd: (rsid, reason, message) => onRecordingEnd(c, rsid, reason, message),
    });
    if (cmd !== c) return { ok: false, cancelled: true };
    if (sid === false) {
      // The pipeline is busy or the speech model isn't ready; it said why.
      set({ phase: "failed", error: { kind: "no-recording", message: "Couldn't start recording. Check that the speech model is ready and that no dictation is running." } });
      c.recordingFailed = true;
      push();
      return { ok: false };
    }
    c.recordingSid = sid;
    set({ phase: "recording" });
    return { ok: true, id: c.id };
  }

  function onRecordingEnd(c, rsid, reason, message) {
    if (cmd !== c || c.recordingSid !== rsid || c.phase === "ready") return;
    c.recordingSid = null;
    if (reason === "cancelled") {
      // The user cancelled the take from the overlay: the whole command ends.
      cancel(c.id, { fromRecording: true });
      return;
    }
    c.recordingFailed = true;
    set({
      phase: "failed",
      error: {
        kind: reason === "empty" ? "empty-speech" : "stt",
        message: reason === "empty" ? "No speech was heard. Try again." : message || "The recording couldn't be transcribed",
      },
    });
  }

  function onTranscript(c, rsid, text) {
    if (cmd !== c || c.recordingSid !== rsid) return;
    c.recordingSid = null;
    const instruction = String(text || "").trim().slice(0, MAX_INSTRUCTION_CHARS);
    if (!instruction) {
      onRecordingEnd(c, rsid, "empty");
      return;
    }
    c.instruction = instruction;
    c.phase = "transforming"; // set before the pipeline reports idle
    push();
    runTransform(c);
  }

  async function runTransform(c) {
    const token = ++c.run;
    const control = new AbortController();
    c.runAbort = control;
    const timeoutMs = c.config.timeoutMs || 120000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([c.abort.signal, control.signal, timeout]);
    c.error = null;
    c.output = null;
    c.notice = null;
    set({ phase: "transforming" });
    try {
      const text = await deps.transform({ instruction: c.instruction, selection: c.selection }, signal);
      // A cancel, a retry or a newer command got here first: this result is dead.
      if (cmd !== c || c.run !== token || signal.aborted) return;
      if (typeof text !== "string" || text.trim() === "") throw new Error(TRANSFORM_EMPTY_MESSAGE);
      log.info(`command ${c.id}: result ready`);
      set({ phase: "ready", output: text });
    } catch (err) {
      if (cmd !== c || c.run !== token) return;
      const timedOut = timeout.aborted && !c.abort.signal.aborted && !control.signal.aborted;
      // Only our own cancellation ends the command silently. Other work can
      // interrupt the shared worker while this command is still active.
      if (!timedOut && signal.aborted) return;
      const { kind, message } = classify(err, { timedOut, timeoutMs });
      log.warn(`command ${c.id}: transform failed (${kind})`);
      set({ phase: "failed", output: null, error: { kind, message } });
    }
  }

  /** Cancel at whatever stage the command is in. The selection is never touched. */
  function cancel(commandId, { fromRecording = false } = {}) {
    const c = current(commandId);
    if (!c) return { ok: false, stale: true };
    const wasRecording = c.phase === "recording" || c.phase === "transcribing";
    teardown(c);
    c.run++;
    c.runAbort?.abort();
    cmd = null;
    deps.onView(null);
    if (wasRecording && !fromRecording) deps.cancelRecording();
    log.info(`command ${c.id}: cancelled`);
    return { ok: true };
  }

  function stop(commandId) {
    const c = current(commandId);
    if (!c || c.phase !== "recording") return { ok: false, stale: !c };
    deps.stopRecording();
    set({ phase: "transcribing" });
    return { ok: true };
  }

  // The recording was stopped by another route (the dictation hotkey, the
  // overlay) and is now being transcribed.
  function markTranscribing() {
    if (cmd && cmd.phase === "recording") set({ phase: "transcribing" });
  }

  /** "Speak again" after a failure: a whole new command (new id, fresh capture). */
  function restart(commandId) {
    const c = current(commandId);
    if (!c) return Promise.resolve({ ok: false, stale: true });
    if (BUSY.has(c.phase)) return Promise.resolve({ ok: false, busy: true });
    return begin();
  }

  function retry(commandId) {
    const c = current(commandId);
    if (!c || c.instruction === null || (c.phase !== "failed" && c.phase !== "ready")) return { ok: false, stale: !c };
    runTransform(c);
    return { ok: true };
  }

  function copy(commandId) {
    const c = current(commandId);
    if (!c || c.output === null || (c.phase !== "ready" && c.phase !== "applied")) return { ok: false, stale: !c };
    deps.writeClipboard(c.output);
    set({ notice: "Copied to the clipboard" });
    return { ok: true };
  }

  /**
   * Replace the selection with the result, if and only if it is safe: the
   * output is complete, Apply is allowed, the focused window is still the one
   * the selection came from and (for a rewrite) the selection there is still
   * the text on the card. Anything else leaves the target alone and offers
   * Copy.
   */
  async function apply(commandId) {
    const c = current(commandId);
    if (!c || c.phase !== "ready" || c.output === null) return { ok: false, stale: !c };
    const state = applyState();
    if (!state.ok) return { ok: false, blocked: true, reason: state.reason };
    c.phase = "applying";
    push();
    const control = new AbortController();
    c.runAbort = control;
    const signal = AbortSignal.any([c.abort.signal, control.signal]);
    const blocked = (notice) => {
      if (cmd !== c) return { ok: false, stale: true };
      set({ phase: "ready", notice, target: null, targetNote: notice });
      log.warn(`command ${c.id}: apply blocked`);
      return { ok: false, blocked: true, reason: notice };
    };
    const DRIFT = "The window or selection changed since it was captured, so nothing was replaced. Copy the result instead.";
    try {
      const now = await deps.platform.fingerprint(signal);
      if (cmd !== c || signal.aborted) return { ok: false, cancelled: true };
      if (!now || now.id !== c.target.id) return blocked(DRIFT);
      if (c.selection) {
        const again = await deps.selection.capture(signal);
        if (cmd !== c || signal.aborted) return { ok: false, cancelled: true };
        if (!again.ok || again.text !== c.selection) return blocked(DRIFT);
      }
      if (c.draftAtCursor) {
        // A draft goes in at the cursor; make sure nothing has been selected
        // there since, which the paste would replace.
        const again = await deps.selection.capture(signal);
        if (cmd !== c || signal.aborted) return { ok: false, cancelled: true };
        if (again.ok || again.reason !== "empty") return blocked(DRIFT);
      }
      const result = await deps.paste(c.output, signal);
      if (cmd !== c || signal.aborted || result.method === "cancelled") return { ok: false, cancelled: true };
      if (result.method === "paste" || result.method === "paste-copy") {
        set({ phase: "applied", notice: "Replaced the selection" });
        log.info(`command ${c.id}: applied`);
        return { ok: true };
      }
      // The paste didn't happen. The text is on the clipboard unless another app
      // took it over; say which, and keep the result on screen.
      const copied = result.method !== "clipboard-changed";
      set({
        phase: "ready",
        notice: copied
          ? `Couldn't paste (${result.note || "paste failed"}); the result is on the clipboard.`
          : "Another app changed the clipboard, so nothing was pasted. Use Copy.",
      });
      return { ok: false, blocked: true };
    } catch (err) {
      if (cmd !== c || signal.aborted || isAbort(err)) return { ok: false, cancelled: true };
      log.warn(`command ${c.id}: apply failed: ${err.message}`);
      set({ phase: "ready", notice: "Couldn't apply the result. Use Copy instead." });
      return { ok: false };
    } finally {
      if (cmd === c && c.phase === "applying") set({ phase: "ready" });
    }
  }

  /** Window closed or app quitting: end whatever is running. */
  function dispose() {
    if (!cmd) return;
    const wasRecording = cmd.phase === "recording" || cmd.phase === "transcribing";
    teardown(cmd);
    cmd.run++;
    cmd.runAbort?.abort();
    cmd = null;
    if (wasRecording) deps.cancelRecording();
  }

  return {
    begin, restart, markTranscribing, cancel, stop, retry, copy, apply, dispose,
    get: (commandId) => (current(commandId) ? view() : null),
    peek: view,
    isActive: () => cmd !== null,
    isRecording: () => cmd?.phase === "recording",
  };
}

module.exports = { createCommandSession, classify, BUSY };
