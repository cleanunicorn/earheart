const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const spelling = $("spelling");
let selection = null;
let busy = false;
let ready = false;

function updateActions() {
  const selected = selection && selection.text === transcript.value && selection.end > selection.start;
  $("selection-hint").textContent = selected
    ? `Selected: “${selection.text.slice(selection.start, selection.end).slice(0, 120)}${selection.end - selection.start > 120 ? "…" : ""}”. Press Tab to correct its spelling.`
    : "Select text, then press Tab to correct it. You can also edit the transcript directly.";
  $("replace").disabled = busy || !selected || !spelling.value.trim();
  $("remember").disabled = $("replace").disabled;
  $("copy").disabled = busy || !ready || !transcript.value.trim();
  transcript.readOnly = busy;
  spelling.disabled = busy;
  $("cancel").disabled = busy;
}

function captureSelection() {
  if (document.activeElement !== transcript) return;
  const start = transcript.selectionStart;
  const end = transcript.selectionEnd;
  selection = end > start ? { start, end, text: transcript.value } : null;
  if (selection) spelling.value = transcript.value.slice(start, end);
  updateActions();
}
transcript.addEventListener("select", captureSelection);
transcript.addEventListener("keyup", captureSelection);
transcript.addEventListener("mouseup", captureSelection);
transcript.addEventListener("input", () => { selection = null; updateActions(); });
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
spelling.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); replace(true); }
});

async function copy() {
  if ($("copy").disabled) return;
  if (selection && spelling.value.trim() !== selection.text.slice(selection.start, selection.end)) {
    $("status").textContent = "Apply your spelling with Replace & remember or Replace only before copying.";
    $("remember").focus();
    return;
  }
  busy = true;
  updateActions();
  try {
    const result = await earheart.invoke("transcript:copy", transcript.value);
    if (!result.ok) throw new Error(result.error);
    await earheart.invoke("correction:close");
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
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); copy(); }
  if (event.key === "Escape" && !busy) earheart.invoke("correction:close");
});
(async () => {
  try {
    const data = await earheart.invoke("correction:get");
    transcript.value = data.text || "";
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
