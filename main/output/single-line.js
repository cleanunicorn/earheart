// Join a multi-line transcript into one line for delivery (#68).
//
// A coding agent running in a terminal (Claude Code, Codex CLI) can take a
// pasted newline as "submit": a three-paragraph prompt goes out as its first
// paragraph while the rest lands in the next turn. With the output setting on,
// every line break — and the spaces around it — becomes one space. Only
// whitespace changes: no word is ever dropped, and History keeps the original.

/**
 * @param {string} text
 * @returns {string}
 */
function joinLines(text) {
  if (typeof text !== "string" || !/[\r\n\u2028\u2029]/.test(text)) return text;
  return text
    .split(/[^\S\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])\s*/)
    .filter((line) => line !== "")
    .join(" ")
    .trim();
}

// The text Earheart hands over — pasted or copied — under the user's output
// settings. Only an explicit `true` turns it on, as the Settings switch shows.
// (U+0085, \v and \f are left alone: STT doesn't emit them and terminals
// don't submit on them.)
function deliverText(text, output) {
  return output?.singleLine === true ? joinLines(text) : text;
}

module.exports = { joinLines, deliverText };
