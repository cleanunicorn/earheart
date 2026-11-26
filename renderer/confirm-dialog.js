// An in-page yes/no question for the Settings window, used in place of
// window.confirm(). Electron's native confirm can leave the window unable to
// open a <select>'s popup afterwards until the window is refocused (seen on
// Windows, reproduced on Linux/X11: the model dropdown stayed shut after
// removing a model). The in-page dialog opens no OS window, so it behaves the
// same everywhere. Nothing in Settings may call the native one;
// test/confirm-dialog.test.js holds that.
//
// confirmDialog(message, { confirmLabel, danger }) resolves true only when the
// user picks the confirm button; Cancel, Escape and a click outside resolve
// false. It is a window property, not a const, so the smoke scripts can stub
// it the way they used to stub window.confirm.
(function (root) {
  const label = (key, fallback) =>
    (typeof i18n !== "undefined" && i18n.t ? i18n.t(key) : fallback);

  root.confirmDialog = function confirmDialog(message, { confirmLabel, danger = false } = {}) {
    const doc = root.document;
    const dialog = doc.createElement("dialog");
    dialog.className = "confirm-dialog";
    const text = doc.createElement("p");
    text.textContent = message;
    const row = doc.createElement("div");
    row.className = "row";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = label("rt.cancel", "Cancel");
    const ok = doc.createElement("button");
    ok.type = "button";
    ok.className = danger ? "danger" : "";
    ok.textContent = confirmLabel || "OK";
    row.append(cancel, ok);
    // The padding lives on this box, not the <dialog>, so a click that lands
    // on the <dialog> itself is always on the backdrop.
    const box = doc.createElement("div");
    box.className = "confirm-dialog-box";
    box.append(text, row);
    dialog.append(box);
    dialog.setAttribute("aria-label", message);
    // Return focus where it was, like the native dialog did.
    const opener = doc.activeElement;
    doc.body.append(dialog);

    return new Promise((resolve) => {
      let answer = false;
      cancel.addEventListener("click", () => dialog.close());
      ok.addEventListener("click", () => { answer = true; dialog.close(); });
      // A click on the backdrop lands on the <dialog> itself.
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
      // Escape fires "cancel" and then "close", so it resolves false too.
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (opener && opener.isConnected && typeof opener.focus === "function") {
          opener.focus({ preventScroll: true });
        }
        resolve(answer);
      }, { once: true });
      dialog.showModal();
      // Destructive questions start on Cancel, so Enter can't delete by accident.
      (danger ? cancel : ok).focus();
    });
  };
})(typeof window !== "undefined" ? window : globalThis);
