const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const spelling = $("spelling");
let selection = null;
let busy = false;
let ready = false;
let original = "";
let lastDirty = null;
let composing = false;
const replacements = [];

function pendingSpelling() {
  return selection && selection.text === transcript.value && spelling.value.trim() &&
    spelling.value.trim() !== selection.text.slice(selection.start, selection.end);
}

function compositionEvent(event) {
  return composing || event.isComposing || event.keyCode === 229;
}
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => { composing = false; });

function updateActions() {
  const selected = selection && selection.text === transcript.value && selection.end > selection.start;
  $("selection-hint").textContent = selected
    ? `Selected: “${selection.text.slice(selection.start, selection.end).slice(0, 120)}${selection.end - selection.start > 120 ? "…" : ""}”. Press Tab to correct its spelling.`
    : "Select text, then press Tab to correct it. You can also edit the transcript directly.";
  $("replace").disabled = busy || !selected || !spelling.value.trim();
  $("remember").disabled = $("replace").disabled;
  $("copy").disabled = busy || !ready || !transcript.value.trim();
  $("undo").disabled = busy || !replacements.length;
  transcript.readOnly = busy || !ready;
  spelling.disabled = busy || !ready;
  $("cancel").disabled = busy;
  if (ready) {
    const dirty = transcript.value !== original || Boolean(pendingSpelling());
    if (dirty !== lastDirty) {
      earheart.send("correction:dirty", dirty);
      lastDirty = dirty;
    }
  }
}

function captureSelection() {
  if (document.activeElement !== transcript) return;
  // Word-wise keyboard selections often include a space or newline. Keep
  // those boundaries in the draft, replacing only the selected phrase itself.
  const selected = transcript.value.slice(transcript.selectionStart, transcript.selectionEnd);
  const start = transcript.selectionStart + selected.length - selected.trimStart().length;
  const end = transcript.selectionEnd - selected.length + selected.trimEnd().length;
  // Focus changes can emit select/keyup again without a new selection. Keep
  // a typed spelling until the user chooses another phrase or edits the text.
  if (selection?.text === transcript.value &&
      ((selection.start === start && selection.end === end) || (end <= start && pendingSpelling()))) return;
  selection = end > start ? { start, end, text: transcript.value } : null;
  spelling.value = selection ? transcript.value.slice(start, end) : "";
  updateActions();
}
transcript.addEventListener("select", captureSelection);
transcript.addEventListener("keyup", (event) => { if (!compositionEvent(event)) captureSelection(); });
transcript.addEventListener("mouseup", captureSelection);
transcript.addEventListener("input", () => {
  selection = null;
  spelling.value = "";
  // A direct edit begins a new undo history: old snapshots must never erase it.
  replacements.length = 0;
  updateActions();
});
spelling.addEventListener("input", updateActions);

async function replace(remember) {
  if ($("replace").disabled) return;
  const chosen = { ...selection };
  const replacement = spelling.value.trim();
  busy = true;
  updateActions();
  try {
    if (remember) {
      const result = await earheart.invoke("correction:remember", replacement);
      if (!result.ok) throw new Error(result.error);
      $("dictionary-note").textContent = result.cleanupEnabled
        ? "Remembered spellings guide future cleanup. Manage them in Settings → Dictionary."
        : "Cleanup is off. This spelling is saved, but will only guide future dictations when cleanup is enabled.";
    }
    transcript.value = chosen.text.slice(0, chosen.start) + replacement + chosen.text.slice(chosen.end);
    if (transcript.value !== chosen.text) replacements.push({ before: chosen.text, after: transcript.value, start: chosen.start, end: chosen.end });
    selection = null;
    spelling.value = "";
    $("status").textContent = remember ? `Replaced and remembered “${replacement}”.` : "Replaced this occurrence.";
    transcript.focus();
    transcript.setSelectionRange(chosen.start + replacement.length, chosen.start + replacement.length);
  } catch (err) {
    $("status").textContent = `${err.message} Your draft is still here; you can use Replace only.`;
  } finally {
    busy = false;
    updateActions();
  }
}
$("replace").addEventListener("click", () => replace(false));
$("remember").addEventListener("click", () => replace(true));
$("undo").addEventListener("click", () => {
  if ($("undo").disabled) return;
  const previous = replacements.pop();
  if (transcript.value !== previous.after) {
    replacements.length = 0;
    updateActions();
    return;
  }
  transcript.value = previous.before;
  selection = null;
  spelling.value = "";
  $("status").textContent = "Replacement undone. Already remembered spellings stay in your dictionary.";
  transcript.focus();
  transcript.setSelectionRange(previous.start, previous.end);
  updateActions();
});
spelling.addEventListener("keydown", (event) => {
  if (compositionEvent(event)) return;
  if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); replace(true); }
});

async function copy() {
  if ($("copy").disabled) return;
  if (pendingSpelling()) {
    $("status").textContent = "Apply your spelling with Replace & remember or Replace only before copying.";
    $("remember").focus();
    return;
  }
  busy = true;
  updateActions();
  try {
    const result = await earheart.invoke("transcript:copy", transcript.value);
    if (!result.ok) throw new Error(result.error);
    const closed = await earheart.invoke("correction:close", { copied: true });
    if (closed?.ok === false) throw new Error(closed.error || "Could not close the editor");
  } catch (err) {
    $("status").textContent = `Could not copy: ${err.message}. Your draft is still here.`;
  } finally {
    busy = false;
    updateActions();
  }
}
$("copy").addEventListener("click", copy);
$("cancel").addEventListener("click", () => earheart.invoke("correction:close"));
document.addEventListener("keydown", (event) => {
  if (compositionEvent(event)) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); copy(); }
  if (event.key === "Escape" && !busy) {
    event.preventDefault();
    if (document.activeElement === spelling) {
      const start = selection?.start ?? transcript.selectionStart;
      selection = null;
      spelling.value = "";
      transcript.focus();
      transcript.setSelectionRange(start, start);
      $("status").textContent = "Pending replacement cancelled.";
      updateActions();
    } else earheart.invoke("correction:close");
  }
});
earheart.on("correction:notice", (notice) => {
  const message = typeof notice === "string" ? notice : notice?.message;
  $("status").textContent = typeof message === "string" ? message : "Another transcript cannot replace your active correction draft. Copy or close this draft first.";
});
updateActions();
(async () => {
  try {
    const data = await earheart.invoke("correction:get");
    transcript.value = data.text || "";
    original = transcript.value;
    ready = true;
    $("dictionary-note").textContent = data.cleanupEnabled
      ? "Remember spellings to guide future cleanup. No automatic replacements or model retraining."
      : "Cleanup is off. Remembered spellings take effect when cleanup is enabled.";
    if (!data.text) $("status").textContent = "No saved transcript yet. Enable History and finish a dictation first.";
    updateActions();
    transcript.focus();
    transcript.setSelectionRange(0, 0);
  } catch (err) { $("status").textContent = `Could not open transcript: ${err.message}`; }
})();
