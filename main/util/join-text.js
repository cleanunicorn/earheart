// Join two transcript fragments with a space; either side may be empty. The
// one rule the live preview's running transcript and the piecewise decode
// (main/chunked-decode.js) both assemble text with, so they can't drift apart.
function joinText(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return `${a} ${b}`;
}

module.exports = { joinText };
