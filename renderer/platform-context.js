// Platform-specific copy for the settings window and the setup wizard (both
// load this as a classic script before their own). A sentence that only holds
// on one system carries `data-os` and starts `hidden`; showForPlatform reveals
// it where it applies, so nobody reads a Wayland workaround on macOS or a
// Windows .exe note on Linux.
//
//   data-os="wayland"     Linux in a Wayland session (where apps can't grab
//                         global keys, so a desktop shortcut is the way)
//   data-os="darwin"      macOS          data-os="not-darwin"  everything else
//   data-os="win32"       Windows        data-os="linux"       any Linux session
//
// Several space-separated values mean "any of these".

function platformMatches(token, { platform, wayland }) {
  if (token === "wayland") return platform === "linux" && wayland === true;
  if (token === "not-darwin") return platform !== "darwin";
  return token === platform;
}

function showForPlatform(root, context) {
  for (const el of root.querySelectorAll("[data-os]")) {
    el.hidden = !el.dataset.os.split(/\s+/).some((token) => platformMatches(token, context));
  }
}
