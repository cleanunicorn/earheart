// The voice command card (#344). It only renders the session main sends and
// reports button presses back; every rule (what may be applied, to which
// window) is enforced in main/commands/session.js. All text from the app, the
// speech engine and the model is shown with textContent, never as markup.

const $ = (id) => document.getElementById(id);

const PHASES = {
  capturing: "Reading the selection…",
  recording: "Listening: say what to write or how to change the selection",
  transcribing: "Transcribing what you said…",
  transforming: "Working on it…",
  ready: "Review the result before using it",
  failed: "Couldn't finish",
  applying: "Replacing the selection…",
  applied: "Done",
};

const BUSY = ["capturing", "recording", "transcribing", "transforming", "applying"];
let view = null;
let pending = false;

function show(id, visible) {
  $(id).hidden = !visible;
}

function render(next) {
  view = next;
  if (!view) return;
  const busy = BUSY.includes(view.phase);
  $("title").textContent = view.mode === "rewrite" ? "Rewrite selection" : "Write from your description";
  $("phase").textContent = view.phase === "transcribing" && view.instruction !== null && view.selectionPending
    ? PHASES.capturing : PHASES[view.phase] || "";
  show("remote-note", view.remote);
  $("capture-note").textContent = view.captureNote ? `${view.captureNote}. Writing a new text from what you say instead.` : "";
  show("capture-note", Boolean(view.captureNote));

  $("selection").textContent = view.selection;
  show("selection-box", Boolean(view.selection));
  $("instruction").textContent = view.instruction ?? "";
  show("instruction-box", view.instruction !== null);
  $("output").textContent = view.output ?? "";
  show("output-box", view.output !== null);

  $("error").textContent = view.error ? view.error.message : "";
  show("error", Boolean(view.error));
  const note = view.notice || view.applyNote || "";
  $("notice").textContent = note;
  show("notice", Boolean(note));

  show("finish", view.phase === "recording");
  show("again", view.phase === "failed" && !view.canRetry);
  show("retry", view.canRetry);
  show("copy", view.canCopy);
  show("apply", view.canApply || (view.phase === "ready" && view.output !== null));
  $("apply").disabled = pending || !view.canApply;
  $("copy").disabled = pending;
  $("retry").disabled = pending || busy;
  $("cancel").textContent = busy ? "Cancel" : "Close";
}

// Serialize ordinary actions so a double click cannot apply twice. Stop and
// Cancel must work even while Speak again is waiting for selection capture;
// those interrupts neither take nor release the ordinary action's guard.
async function act(call, { interrupt = false } = {}) {
  if (!view || (pending && !interrupt)) return;
  if (!interrupt) pending = true;
  render(view);
  try {
    const result = await call({ id: view.id });
    if (result && result.ok === false && result.reason) {
      $("notice").textContent = result.reason;
      show("notice", true);
    }
  } catch {
    $("notice").textContent = "That didn't work. Try again.";
    show("notice", true);
  } finally {
    if (!interrupt) pending = false;
    if (view) render(view);
  }
}

$("cancel").addEventListener("click", () => {
  if (!view) return earheart.invoke("command:close", {});
  return act(BUSY.includes(view.phase)
    ? (payload) => earheart.invoke("command:cancel", payload)
    : (payload) => earheart.invoke("command:close", payload), { interrupt: true });
});
$("finish").addEventListener("click", () => act((payload) => earheart.invoke("command:stop", payload), { interrupt: true }));
$("again").addEventListener("click", () => act((payload) => earheart.invoke("command:restart", payload)));
$("retry").addEventListener("click", () => act((payload) => earheart.invoke("command:retry", payload)));
$("copy").addEventListener("click", () => act((payload) => earheart.invoke("command:copy", payload)));
$("apply").addEventListener("click", () => act((payload) => earheart.invoke("command:apply", payload)));

earheart.on("command:state", render);
earheart.invoke("command:get", {}).then((reply) => {
  if (reply && reply.ok && reply.view && !view) render(reply.view);
});
