// The Settings window asks yes/no questions with an in-page dialog
// (renderer/confirm-dialog.js), never window.confirm(): on Linux the native
// dialog left the window unable to open a <select>'s popup afterwards, so
// after removing a cleanup model its dropdown would not open again.
//
// The static checks keep the native dialog out of every script Settings loads;
// the behaviour checks drive confirmDialog against a minimal fake DOM.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(RENDERER, "settings.html"), "utf8");
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

test("no script the Settings window loads calls the native confirm or alert", () => {
  for (const src of scripts) {
    const code = fs.readFileSync(path.join(RENDERER, src), "utf8")
      // Comments may name the native dialog to explain why it isn't used.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /(^|[^.\w])(window\.)?(confirm|alert)\s*\(/m, `${src} uses a native dialog`);
  }
});

test("Settings loads confirm-dialog.js before every script that asks a question", () => {
  const at = scripts.indexOf("confirm-dialog.js");
  assert.ok(at >= 0, "settings.html loads confirm-dialog.js");
  for (const src of scripts) {
    const code = fs.readFileSync(path.join(RENDERER, src), "utf8");
    if (src !== "confirm-dialog.js" && code.includes("confirmDialog(")) {
      assert.ok(scripts.indexOf(src) > at, `${src} loads after confirm-dialog.js`);
    }
  }
});

// Just enough DOM for confirmDialog: elements with listeners, a <dialog> whose
// close() fires "close", and a document tracking focus and attachment.
function fakeDom() {
  const doc = { activeElement: null, body: null };
  const make = (tag) => {
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: null,
      attrs: {},
      textContent: "",
      className: "",
      open: false,
      get isConnected() {
        let node = el;
        while (node.parent) node = node.parent;
        return node === doc.body;
      },
      append(...kids) { for (const kid of kids) { kid.parent = el; el.children.push(kid); } },
      remove() {
        if (!el.parent) return;
        el.parent.children = el.parent.children.filter((c) => c !== el);
        el.parent = null;
      },
      setAttribute(name, value) { el.attrs[name] = value; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, event = {}) {
        for (const fn of [...(listeners[type] || [])]) fn({ target: el, ...event });
      },
      focus() { doc.activeElement = el; },
      // Bubbles to every ancestor with the clicked element as the target.
      click() { for (let node = el; node; node = node.parent) node.dispatch("click", { target: el }); },
      showModal() { el.open = true; },
      close() { if (!el.open) return; el.open = false; el.dispatch("close"); },
    };
    return el;
  };
  doc.createElement = make;
  doc.body = make("body");
  return doc;
}

function load() {
  const document = fakeDom();
  const window = { document };
  const i18n = { t: (key) => ({ "rt.cancel": "Cancel" })[key] || key };
  vm.runInNewContext(fs.readFileSync(path.join(RENDERER, "confirm-dialog.js"), "utf8"), { window, i18n });
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  return { window, document, opener };
}

const parts = (document) => {
  const dialog = document.body.children.find((c) => c.tagName === "DIALOG");
  const [text, row] = dialog.children[0].children;
  const [cancel, ok] = row.children;
  return { dialog, box: dialog.children[0], cancel, ok, text: text.textContent };
};

test("the confirm button resolves true, then the dialog goes and focus returns", async () => {
  const { window, document, opener } = load();
  const answer = window.confirmDialog("Remove Granite?", { confirmLabel: "Remove", danger: true });
  const { dialog, cancel, ok, text } = parts(document);
  assert.equal(dialog.open, true);
  assert.equal(text, "Remove Granite?");
  assert.equal(ok.textContent, "Remove");
  assert.equal(cancel.textContent, "Cancel");
  // A destructive question starts on Cancel, so Enter can't delete by accident.
  assert.equal(document.activeElement, cancel);
  ok.click();
  assert.equal(await answer, true);
  assert.ok(!dialog.isConnected, "the dialog is removed");
  assert.equal(document.activeElement, opener);
});

test("Cancel, Escape and a backdrop click resolve false", async () => {
  for (const dismiss of [
    ({ cancel }) => cancel.click(),
    ({ dialog }) => { dialog.dispatch("cancel"); dialog.close(); }, // Escape
    ({ dialog }) => dialog.click(),
  ]) {
    const { window, document } = load();
    const answer = window.confirmDialog("Delete?", { confirmLabel: "Delete", danger: true });
    dismiss(parts(document));
    assert.equal(await answer, false);
    assert.equal(document.body.children.some((c) => c.tagName === "DIALOG"), false);
  }
});

test("a click inside the box, off the buttons, keeps the question open", async () => {
  const { window, document } = load();
  const answer = window.confirmDialog("Delete?", { confirmLabel: "Delete", danger: true });
  const { dialog, box, ok } = parts(document);
  box.click();
  assert.equal(dialog.open, true);
  ok.click();
  assert.equal(await answer, true);
});

test("a question that isn't destructive starts on its confirm button", () => {
  const { window, document } = load();
  window.confirmDialog("Continue?", { confirmLabel: "Continue" });
  assert.equal(document.activeElement, parts(document).ok);
});
