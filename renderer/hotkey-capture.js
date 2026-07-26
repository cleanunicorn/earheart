// Shared hotkey-capture machinery for the settings window and the setup
// wizard (both load this as a classic script before their own; each page's
// own top-level `let platform = ...` is what acceleratorFromEvent reads at
// keydown time — classic scripts share one global lexical environment, the
// same arrangement overlay.html uses for transcript.js).

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function acceleratorFromEvent(event) {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts = [];
  // On macOS, physical Ctrl must stay Ctrl — CommandOrControl would register Cmd.
  if (event.ctrlKey) parts.push(platform === "darwin" ? "Control" : "CommandOrControl");
  if (event.metaKey) parts.push(platform === "darwin" ? "Command" : "Super");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null; // require at least one modifier

  let key = event.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith("Arrow")) key = key.slice(5);
  parts.push(key);
  return parts.join("+");
}

// One capture wiring for a click-to-capture hotkey field: `apply` stores a
// captured accelerator, `restore` yields what blur should show.
function wireHotkeyCapture(input, { apply, restore }) {
  function startCapture() {
    input.classList.add("capturing");
    input.value = "Press keys…";
  }
  input.addEventListener("click", startCapture);
  input.addEventListener("blur", () => {
    input.classList.remove("capturing");
    input.value = restore();
  });
  input.addEventListener("keydown", (event) => {
    // Keyboard users can't click, so Enter/Space on the focused field arms
    // capture — matching what a mouse click does.
    if (!input.classList.contains("capturing")) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        startCapture();
      }
      return;
    }
    // Tab is never a hotkey and must keep working while capturing, or a
    // keyboard user is trapped in the field: let it move focus (the blur
    // handler ends capture and restores the value).
    if (event.key === "Tab") return;
    event.preventDefault();
    // Ending capture keeps focus in the field (blur() would strand a
    // keyboard user's Tab position at <body>); the blur listener still
    // handles click-away.
    if (event.key === "Escape") {
      // Leave capture without changing the binding.
      input.classList.remove("capturing");
      input.value = restore();
      return;
    }
    const accelerator = acceleratorFromEvent(event);
    if (accelerator) {
      apply(accelerator);
      input.classList.remove("capturing");
      input.value = restore();
    }
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MODIFIER_KEYS, acceleratorFromEvent, wireHotkeyCapture };
}
