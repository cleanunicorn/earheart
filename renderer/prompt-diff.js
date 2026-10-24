// Line diff for the new-default-prompt offer (Settings → Cleanup): what the
// new default changes relative to the user's own prompt. Prompts are a few
// dozen lines, one rule per line, so a plain LCS table over lines is enough.
// Pure, so it is unit-tested directly (test/unit.test.js).

/**
 * @param {string} from  the user's prompt
 * @param {string} to    the new default
 * @returns {{ op: "same" | "del" | "add", line: string }[]}
 */
function diffLines(from, to) {
  const a = String(from).split("\n");
  const b = String(to).split("\n");
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "del", line: a[i++] });
    } else {
      out.push({ op: "add", line: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: "del", line: a[i++] });
  while (j < b.length) out.push({ op: "add", line: b[j++] });
  return out;
}

/**
 * The diff as shown: each change keeps `context` unchanged lines on either
 * side, and a longer unchanged stretch folds into one { op: "skip", count }
 * entry, so the changes are on screen without scrolling past the whole prompt.
 * @param {{ op: string, line: string }[]} diff  from diffLines
 * @param {number} [context]
 */
function foldUnchanged(diff, context = 1) {
  const near = diff.map((_, i) =>
    diff.slice(Math.max(0, i - context), i + context + 1).some((d) => d.op !== "same")
  );
  const out = [];
  for (const [i, d] of diff.entries()) {
    if (d.op !== "same" || near[i]) out.push(d);
    else if (out.length && out[out.length - 1].op === "skip") out[out.length - 1].count++;
    else out.push({ op: "skip", count: 1 });
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { diffLines, foldUnchanged };
}
