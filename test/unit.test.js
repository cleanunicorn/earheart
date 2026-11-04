// Unit tests for the pure (non-Electron) parts of the main process.
// Run with: npm test

const { test } = require("node:test");
const assert = require("node:assert");

const { withStubs } = require("./helpers/stub-modules");
const path = require("node:path");

const { encodeWav, encodeSilenceWav, wavToFloat32, wavDurationSec } = require("../main/util/wav");
const { deepMerge, DEFAULTS, cleanupPromptOffer, promptFingerprint, PREVIOUS_DEFAULT_PROMPTS } = require("../main/settings");
const { diffLines, foldUnchanged } = require("../renderer/prompt-diff");
const { resolveCleanup } = require("../main/cleanup-styles");
const {
  stripFillers,
  collapseRepeats,
  stripStumbles,
} = require("../main/util/stumble-strip");
const { FLUENT, TECHNICAL, TECHNICAL_HELDOUT } = require("../scripts/dictation-corpus");
const autostart = require("../main/autostart");
const { reconcileTranscript } = require("../renderer/transcript");
const {
  microphoneConstraints,
  isMissingMicrophone,
  microphoneErrorMessage,
} = require("../renderer/microphone");

test("microphone fallback only retries a missing saved device", () => {
  assert.deepStrictEqual(microphoneConstraints("saved-device").deviceId, {
    exact: "saved-device",
  });
  assert.strictEqual(microphoneConstraints().deviceId, undefined);
  assert.strictEqual(
    isMissingMicrophone({ name: "OverconstrainedError", constraint: "deviceId" }),
    true
  );
  assert.strictEqual(
    isMissingMicrophone({ name: "NotAllowedError", constraint: "deviceId" }),
    false
  );
  assert.strictEqual(
    isMissingMicrophone({ name: "OverconstrainedError", constraint: "facingMode" }),
    false
  );
});

test("microphone errors use the error name when the browser message is blank", () => {
  assert.strictEqual(
    microphoneErrorMessage({ name: "OverconstrainedError", message: "" }),
    "Microphone unavailable: OverconstrainedError"
  );
  assert.strictEqual(
    microphoneErrorMessage({ name: "NotAllowedError", message: "Permission denied" }),
    "Microphone unavailable: Permission denied"
  );
});

test("encodeWav produces a valid RIFF header", () => {
  const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(samples, 16000);
  assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
  assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
  assert.strictEqual(wav.readUInt32LE(24), 16000); // sample rate
  assert.strictEqual(wav.readUInt16LE(22), 1); // mono
  assert.strictEqual(wav.readUInt32LE(40), samples.length * 2); // data size
  assert.strictEqual(wav.length, 44 + samples.length * 2);
  assert.strictEqual(wav.readInt16LE(44 + 2), 1000);
});

test("encodeSilenceWav has the requested duration", () => {
  const wav = encodeSilenceWav(0.5);
  assert.strictEqual(wav.readUInt32LE(40), 16000 * 0.5 * 2);
});

test("wavDurationSec reads the duration from the chunk list", () => {
  assert.strictEqual(wavDurationSec(encodeSilenceWav(0.5)), 0.5);
  assert.strictEqual(wavDurationSec(encodeSilenceWav(3)), 3);
  // Degenerate/malformed buffers floor at 0.01s instead of throwing — the
  // value feeds progress estimates, so best-effort beats an error.
  assert.strictEqual(wavDurationSec(Buffer.alloc(0)), 0.01);
  assert.strictEqual(wavDurationSec(Buffer.from("not a wav at all")), 0.01);
});

test("wavDurationSec genuinely walks chunks: junk chunk, stereo, non-16k, pad byte", () => {
  // Hand-built WAV that breaks every fixed-44-byte-header assumption: an
  // odd-sized LIST chunk (so the word-alignment pad byte matters) sits between
  // fmt and data, and the audio is stereo 44.1kHz — exactly 1s of frames.
  const sr = 44100;
  const channels = 2;
  const dataSize = sr * 2 * channels; // 1 second of PCM16 stereo
  const junk = 7; // odd on purpose: chunk must be followed by a pad byte
  const buf = Buffer.alloc(12 + (8 + 16) + (8 + junk + 1) + 8 + dataSize);
  let p = 0;
  buf.write("RIFF", p);
  buf.writeUInt32LE(buf.length - 8, p + 4);
  buf.write("WAVE", p + 8);
  p += 12;
  buf.write("fmt ", p);
  buf.writeUInt32LE(16, p + 4);
  p += 8;
  buf.writeUInt16LE(1, p); // PCM
  buf.writeUInt16LE(channels, p + 2);
  buf.writeUInt32LE(sr, p + 4);
  buf.writeUInt32LE(sr * 2 * channels, p + 8);
  buf.writeUInt16LE(2 * channels, p + 12);
  buf.writeUInt16LE(16, p + 14);
  p += 16;
  buf.write("LIST", p);
  buf.writeUInt32LE(junk, p + 4);
  p += 8 + junk + 1; // skip the junk body plus its alignment pad
  buf.write("data", p);
  buf.writeUInt32LE(dataSize, p + 4);

  assert.strictEqual(wavDurationSec(buf), 1);
});

test("wavToFloat32 round-trips PCM16 samples to [-1, 1]", () => {
  const wav = encodeWav(new Int16Array([0, 16384, -16384, 32767, -32768]));
  const { samples, sampleRate } = wavToFloat32(wav);
  assert.strictEqual(sampleRate, 16000);
  assert.strictEqual(samples.length, 5);
  assert.strictEqual(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(samples[2] + 0.5) < 1e-4);
  assert.ok(samples[3] <= 1 && samples[3] > 0.99);
  assert.strictEqual(samples[4], -1);
});

test("wavToFloat32 rejects non-WAV input", () => {
  assert.throws(() => wavToFloat32(Buffer.from("not a wav at all!!")));
});

test("wavToFloat32 rejects an unsupported format", () => {
  // A valid mono PCM16 WAV with the audioFormat field flipped to IEEE float (3)
  // must be rejected, so the engine never feeds garbage to Parakeet (callers
  // fall back to the HTTP STT path).
  const wav = encodeWav(new Int16Array([1, 2, 3]));
  wav.writeUInt16LE(3, 20); // audioFormat: 3 = IEEE float, not PCM
  assert.throws(() => wavToFloat32(wav), /Unsupported WAV format/);

  // 8-bit PCM is likewise unsupported.
  const wav8 = encodeWav(new Int16Array([1, 2, 3]));
  wav8.writeUInt16LE(8, 34); // bitsPerSample: 8
  assert.throws(() => wavToFloat32(wav8), /Unsupported WAV format/);
});

test("wavToFloat32 rejects a WAV with no data chunk", () => {
  // RIFF/WAVE header + a fmt chunk, but no data chunk at all.
  const buf = Buffer.alloc(36);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(28, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  assert.throws(() => wavToFloat32(buf), /no data chunk/);
});

test("wavToFloat32 averages stereo channels to mono", () => {
  // Hand-build a 2-channel PCM16 WAV: L/R interleaved. Each output sample is
  // the average of its L/R pair, so a stride/divide regression would corrupt it.
  const pairs = [
    [16384, 16384], // both 0.5 -> 0.5
    [16384, -16384], // +0.5, -0.5 -> 0
    [-32768, -32768], // both -1 -> -1
  ];
  const frames = pairs.length;
  const dataSize = frames * 2 * 2; // frames * channels * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(16000 * 4, 28);
  buf.writeUInt16LE(4, 32); // block align = channels * 2
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (const [l, r] of pairs) {
    buf.writeInt16LE(l, off);
    buf.writeInt16LE(r, off + 2);
    off += 4;
  }
  const { samples } = wavToFloat32(buf);
  assert.strictEqual(samples.length, frames);
  assert.ok(Math.abs(samples[0] - 0.5) < 1e-4);
  assert.ok(Math.abs(samples[1]) < 1e-4);
  assert.strictEqual(samples[2], -1);
});

test("wavToFloat32 tolerates an extra chunk before data", () => {
  // A LIST chunk with an odd size (3 bytes -> 1 pad byte) sits between fmt and
  // data; the parser must word-align past it and still find data correctly.
  const samples = new Int16Array([1000, -1000, 500]);
  const base = encodeWav(samples); // RIFF|fmt(24..)|data(36..)
  const fmtEnd = 36; // where "data" starts in the base buffer
  const listSize = 3;
  const listChunk = Buffer.alloc(8 + listSize + 1); // header + body + pad byte
  listChunk.write("LIST", 0);
  listChunk.writeUInt32LE(listSize, 4);
  listChunk.write("abc", 8);
  const buf = Buffer.concat([
    base.subarray(0, fmtEnd),
    listChunk,
    base.subarray(fmtEnd),
  ]);
  buf.writeUInt32LE(buf.length - 8, 4); // fix RIFF size
  const out = wavToFloat32(buf);
  assert.strictEqual(out.sampleRate, 16000);
  assert.strictEqual(out.samples.length, samples.length);
  assert.ok(Math.abs(out.samples[0] - 1000 / 32768) < 1e-4);
});

/* ---------------- new default prompt offer ---------------- */

// Changing the default prompt breaks this pin on purpose: append the outgoing
// default's fingerprint to PREVIOUS_DEFAULT_PROMPTS (main/settings.js) so its
// users are offered the new one as a plain switch, then update the pin.
test("the default prompt's fingerprint is pinned, and only the outgoing ones are 'previous'", () => {
  assert.strictEqual(
    promptFingerprint(DEFAULTS.cleanup.systemPrompt),
    "86ffc59b306bbb6cfdfde09f4caf5c16bb670c594cff9c4c0c8778f531239013"
  );
  for (const h of PREVIOUS_DEFAULT_PROMPTS) assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!PREVIOUS_DEFAULT_PROMPTS.has(promptFingerprint(DEFAULTS.cleanup.systemPrompt)));
});

test("cleanupPromptOffer stays quiet for the current default and a decided offer", () => {
  const cfg = (cleanup) => ({ cleanup: { ...DEFAULTS.cleanup, ...cleanup } });
  assert.strictEqual(cleanupPromptOffer(cfg({})), null);
  // Trailing whitespace or a hard wrap is not an edit.
  assert.strictEqual(cleanupPromptOffer(cfg({ systemPrompt: `${DEFAULTS.cleanup.systemPrompt}\n` })), null);

  const custom = cleanupPromptOffer(cfg({ systemPrompt: "My own rules." }));
  assert.strictEqual(custom.kind, "custom");
  assert.match(custom.id, /^[0-9a-f]{16}$/);
  assert.strictEqual(cleanupPromptOffer(cfg({ systemPrompt: "My own rules.", promptOfferDecided: custom.id })), null);
  // A decision on an older default doesn't answer this one.
  assert.strictEqual(cleanupPromptOffer(cfg({ systemPrompt: "My own rules.", promptOfferDecided: "0123456789abcdef" })).kind, "custom");
  assert.strictEqual(cleanupPromptOffer({}), null);
});

test("cleanupPromptOffer offers the v0.43 default as a plain switch", () => {
  // The default up to v0.43, before the doubled-symbol sentence.
  const previous = DEFAULTS.cleanup.systemPrompt.replace(
    ' A symbol word said twice is two symbols, not a stutter ("dot dot slash" -> ../).',
    ""
  );
  assert.notStrictEqual(previous, DEFAULTS.cleanup.systemPrompt);
  assert.strictEqual(cleanupPromptOffer({ cleanup: { ...DEFAULTS.cleanup, systemPrompt: previous } }).kind, "previous-default");
});

test("cleanupPromptOffer recognises an untouched earlier default", () => {
  // A stand-in for an earlier default: any text whose fingerprint is listed.
  const first = [
    "You clean up raw speech-to-text transcriptions.",
    "",
    "Rules:",
  ].join("\n");
  PREVIOUS_DEFAULT_PROMPTS.add(promptFingerprint(first));
  try {
    const offer = cleanupPromptOffer({ cleanup: { ...DEFAULTS.cleanup, systemPrompt: first } });
    assert.strictEqual(offer.kind, "previous-default");
  } finally {
    PREVIOUS_DEFAULT_PROMPTS.delete(promptFingerprint(first));
  }
});

test("foldUnchanged keeps one line of context around each change and folds the rest", () => {
  const diff = diffLines("a\nb\nc\nd\ne\nf", "a\nb\nc\nD\ne\nf");
  assert.deepStrictEqual(foldUnchanged(diff), [
    { op: "skip", count: 2 },
    { op: "same", line: "c" },
    { op: "del", line: "d" },
    { op: "add", line: "D" },
    { op: "same", line: "e" },
    { op: "skip", count: 1 },
  ]);
  // Nothing changed: everything folds.
  assert.deepStrictEqual(foldUnchanged(diffLines("x\ny", "x\ny")), [{ op: "skip", count: 2 }]);
});

test("diffLines marks what the new default removes and adds, in order", () => {
  assert.deepStrictEqual(diffLines("a\nb\nc", "a\nB\nc\nd"), [
    { op: "same", line: "a" },
    { op: "del", line: "b" },
    { op: "add", line: "B" },
    { op: "same", line: "c" },
    { op: "add", line: "d" },
  ]);
  assert.deepStrictEqual(diffLines("x", "x"), [{ op: "same", line: "x" }]);
  assert.deepStrictEqual(diffLines("", "y"), [{ op: "del", line: "" }, { op: "add", line: "y" }]);
});

/* ---------------- stumble stripping ---------------- */

test("stripFillers removes um/uh fillers and the punctuation fencing them", () => {
  // The model's job, done unreliably by small models: what survives its output.
  assert.strictEqual(
    stripFillers("the connectors page is uh, for admins"),
    "the connectors page is for admins"
  );
  // A comma before the filler belongs to the preceding clause and stays.
  assert.strictEqual(stripFillers("So, um, we should ship it."), "So, we should ship it.");
  // A sentence that loses its opening filler hands the capital to the next word.
  assert.strictEqual(stripFillers("Um, I think so."), "I think so.");
  assert.strictEqual(stripFillers("Well. Uh, so we go."), "Well. So we go.");
  // Repeated/elongated spellings STT produces.
  assert.strictEqual(stripFillers("it is ummm here uhh now"), "it is here now");
  // A filler that trails its clause leaves no orphaned punctuation behind:
  // the comma that fenced it goes with it, the sentence keeps its own end.
  assert.strictEqual(stripFillers("I think that is it, um."), "I think that is it.");
  assert.strictEqual(stripFillers("Wait, um!"), "Wait!");
  assert.strictEqual(stripFillers("It is uh..."), "It is...");
  // A "sentence" that was only a filler takes its punctuation with it.
  assert.strictEqual(stripFillers("Do it. Um! Really?"), "Do it. Really?");
  // ":" and ";" continue a sentence — the next word keeps its lower case.
  assert.strictEqual(stripFillers("the plan: um, we ship it"), "the plan: we ship it");
  // A line that opens with a filler does not inherit its space.
  assert.strictEqual(stripFillers("para one.\n\nUm, para two."), "para one.\n\nPara two.");
});

test("stripFillers leaves real words, acronyms and text without fillers alone", () => {
  const clean = "no fillers here at all";
  assert.strictEqual(stripFillers(clean), clean);
  // Substrings are not fillers.
  assert.strictEqual(stripFillers("Umbrella umbrellas hummus"), "Umbrella umbrellas hummus");
  // Caps read as an acronym, not a stumble.
  assert.strictEqual(stripFillers("The UM report is done."), "The UM report is done.");
  // Hyphenated interjections carry meaning.
  assert.strictEqual(stripFillers("uh-huh, that works"), "uh-huh, that works");
  assert.strictEqual(stripFillers("To umí."), "To umí.");
  // Dictated line breaks survive, without trailing whitespace.
  assert.strictEqual(stripFillers("line one um\nline two"), "line one\nline two");
  // Never lose the user's words: an all-filler transcript stays as it was.
  assert.strictEqual(stripFillers("um"), "um");
  assert.strictEqual(stripFillers(""), "");
  assert.strictEqual(stripFillers("Das wird es ermöglichen."), "Das wird es ermöglichen.");
  assert.strictEqual(stripFillers("Ich bin ermüdet."), "Ich bin ermüdet.");
});

test("stripFillers repairs the seam only, leaving the rest of the spacing alone", () => {
  // Cutting a filler used to reflow the whole transcript: indentation, aligned
  // columns and the trailing newline are the user's, not the filler's.
  assert.strictEqual(
    stripFillers("um, hello\n  step one\n  step two"),
    "Hello\n  step one\n  step two"
  );
  assert.strictEqual(stripFillers("uh okay\nfoo    bar"), "Okay\nfoo    bar");
  assert.strictEqual(stripFillers("um, hello\n"), "Hello\n");
  assert.strictEqual(stripFillers("a  b um c"), "a  b c");
  // A line break the filler did not own survives the comma that fenced it.
  assert.strictEqual(stripFillers("foo\n, um bar"), "foo\nbar");
  // A run of fillers is one cut, so the next word still takes the capital.
  assert.strictEqual(stripFillers("um um hello"), "Hello");
  assert.strictEqual(stripFillers("um, uh, hello"), "Hello");
  assert.strictEqual(stripFillers("um... okay"), "Okay");
});

test("collapseRepeats collapses a re-spoken word but not a deliberate one", () => {
  assert.strictEqual(
    collapseRepeats("The the admin will add it."),
    "The admin will add it."
  );
  assert.strictEqual(collapseRepeats("I I wanted to to send it"), "I wanted to send it");
  assert.strictEqual(collapseRepeats("the the the file"), "the file");
  // Deliberate doublings, numbers and proper names keep both words.
  assert.strictEqual(collapseRepeats("He had had enough"), "He had had enough");
  assert.strictEqual(collapseRepeats("it was very very late"), "it was very very late");
  assert.strictEqual(collapseRepeats("call two two three"), "call two two three");
  assert.strictEqual(collapseRepeats("port 3000 3000"), "port 3000 3000");
  assert.strictEqual(collapseRepeats("I went to Walla Walla"), "I went to Walla Walla");
  // Punctuation between them means the repetition was meant.
  assert.strictEqual(collapseRepeats("No, no that is wrong"), "No, no that is wrong");
  // Spelled-out letters are data, not a stutter.
  assert.strictEqual(collapseRepeats("serial V V 7"), "serial V V 7");
  assert.strictEqual(collapseRepeats("Nous nous sommes rencontrés hier."), "Nous nous sommes rencontrés hier.");
  assert.strictEqual(collapseRepeats("Ik denk dat dat klopt."), "Ik denk dat dat klopt.");
  assert.strictEqual(collapseRepeats("Die die Frage beantwortet er."), "Die die Frage beantwortet er.");
});

test("stripStumbles removes fillers first, so the repeat they hid collapses too", () => {
  assert.strictEqual(stripStumbles("how can we move the um the file"), "how can we move the file");
  const untouched = "nothing to fix here";
  assert.strictEqual(stripStumbles(untouched), untouched);
});

// The regression this whole backstop exists for, pinned with the real thing:
// FLUENT.modelOutput is what the built-in Gemma 3 4B actually returned for a
// long, fluent dictation on the Polished style — the transcript tidied and all
// six fillers left in. A directive-only cleanup ships that text to the user.
test("the reported fluent dictation comes out filler-free", () => {
  const out = stripStumbles(FLUENT.modelOutput);
  assert.deepStrictEqual(out.match(/(?<![\w-])(?:u[mh]+|erm+)(?![\w-])/gi), null);
  // Only the stumbles go: the words around them are untouched, including the
  // opening sentence the small models like to rewrite.
  assert.match(out, /^I want to change how the contact form works\./);
  assert.match(out, /and all the other fields\.$/);
  assert.match(out, /let's see if we can simplify the process\./);
});

/* ---------------- cleanup styles ---------------- */

// The directive is the first lever, and it is not enough on its own (see the
// FLUENT corpus in scripts/dictation-corpus.js), but a style that promises a
// tidy result still has to ask for one. Keep the promises explicit.
test("cleanup styles that promise a tidy result actually deliver it", () => {
  for (const id of ["clean", "polished"]) {
    const { systemPrompt } = resolveCleanup({ systemPrompt: "Base.", style: id });
    assert.match(systemPrompt, /filler word/i);
    assert.match(systemPrompt, /collapse repeated words/i);
  }
  // Verbatim promises the opposite, so the backstop must not apply to it.
  const verbatim = resolveCleanup({ systemPrompt: "Base.", style: "verbatim" });
  assert.match(verbatim.systemPrompt, /do not remove fillers/i);
  assert.match(verbatim.systemPrompt, /or repetition/i);
});

// #290: the backstop runs after the model was told to reproduce commands,
// paths and strings exactly, so it must never edit them itself.
test("stripStumbles leaves code, paths and quoted strings exactly as they are", () => {
  const kept = [
    "Run `echo echo`.",
    "Open src/um/parser.js.",
    'Set the string to "um".',
    "Set the string to “um”.",
    "Set it to 'um' now.",
    "Set it to ‘um’ now.",
    "```\nfor x in x x; do echo um; done\n```",
    "Pass --um to the uh_handler and read ./um/notes.",
    "Call fooBar fooBar on the parser.",
  ];
  for (const text of kept) {
    const out = stripStumbles(text);
    for (const literal of text.match(/`[^`]+`|```[\s\S]+```|"[^"]*"|“[^”]*”|'um'|‘um’|src\/um\/parser\.js|--um|uh_handler|\.\/um\/notes|fooBar fooBar/g) || []) {
      assert.ok(out.includes(literal), `${JSON.stringify(literal)} survives in ${JSON.stringify(out)}`);
    }
  }
});

test("stripStumbles still tidies the prose around a literal", () => {
  // (The comma that only fenced the filler goes with it, as it does without a literal.)
  assert.strictEqual(stripStumbles("So um, open src/um/parser.js and the the tests."), "So open src/um/parser.js and the tests.");
  assert.strictEqual(stripStumbles("Run `echo echo` um, then the the build."), "Run `echo echo` then the build.");
  // A path ending a sentence still ends it: the next filler-led one is capitalized.
  assert.strictEqual(stripStumbles("Open src/um/parser.js. Um, then run it."), "Open src/um/parser.js. Then run it.");
  // Apostrophes are not quotes.
  assert.strictEqual(stripStumbles("It's um fine, don't worry."), "It's fine, don't worry.");
  // An unmarked repeat can't be told from a stutter: marking it keeps it.
  assert.strictEqual(stripStumbles("run echo echo"), "run echo");
  // An elision opens no quote, so the prose up to a later possessive is tidied.
  assert.strictEqual(
    stripStumbles("I left 'cause um the the dogs' toys were um gone."),
    "I left 'cause the dogs' toys were gone."
  );
  // A quoted sentence still ends its sentence: the next one takes the capital.
  assert.strictEqual(stripStumbles('She said "stop." Um, then we left.'), 'She said "stop." Then we left.');
  assert.strictEqual(stripStumbles("She said “stop.” Um, then we left."), "She said “stop.” Then we left.");
});

test("stripStumbles leaves a text with more literals than placeholders unchanged", () => {
  const text = Array.from({ length: 6500 }, (_, i) => `f${i}.js um`).join(" ");
  assert.strictEqual(stripStumbles(text), text);
});

test("stripStumbles leaves text holding private-use characters alone", () => {
  // Placeholders live in that range; a text already using it can't be masked safely.
  const text = "um the the \uE000 thing";
  assert.strictEqual(stripStumbles(text), text);
});

// Load main/services/route.js with the two cleanup backends replaced by a stub
// that echoes a fixed cleaned text, so the routing + filler backstop can be
// exercised without Electron or a model.
function loadRouteWith(cleanedText) {
  const routePath = require.resolve("../main/services/route");
  const stubs = {
    [require.resolve("../main/engines")]: { clean: async () => cleanedText },
    [require.resolve("../main/services/cleanup")]: { clean: async () => cleanedText },
    [require.resolve("../main/services/stt")]: {},
  };
  return withStubs(stubs, [routePath], () => require(routePath));
}

test("route.clean strips leftover stumbles for the styles that promise none", async () => {
  const left = "So the the page is uh, for admins.";
  for (const engine of ["builtin", "remote"]) {
    const route = loadRouteWith(left);
    assert.strictEqual(
      await route.clean("raw", { engine, style: "polished" }),
      "So the page is for admins."
    );
    assert.strictEqual(
      await route.clean("raw", { engine, style: "clean" }),
      "So the page is for admins."
    );
    // Verbatim keeps every word, and custom runs the user's own prompt.
    assert.strictEqual(await route.clean("raw", { engine, style: "verbatim" }), left);
    assert.strictEqual(await route.clean("raw", { engine, style: "custom" }), left);
  }
});

// End-to-end over the real failure: whatever the model hands back, the styles
// that promise no fillers deliver none — on both engines, which is what the
// live preview and the final clean both go through.
test("route.clean rescues the reported fluent dictation on every tidied style", async () => {
  for (const engine of ["builtin", "remote"]) {
    for (const style of ["clean", "polished"]) {
      const route = loadRouteWith(FLUENT.modelOutput);
      const out = await route.clean(FLUENT.raw, { engine, style });
      assert.deepStrictEqual(out.match(/(?<![\w-])(?:u[mh]+|erm+)(?![\w-])/gi), null);
    }
  }
});

// The technical corpus (docs/cleanup-models.md): a model that leaves spoken
// symbols as words must not have them collapsed as stutters.
test("stripStumbles keeps doubled symbol words and still removes the stumbles around them", () => {
  const kept = [
    "cd into dot dot slash config",
    "run the tests with dash dash watch",
    "if user equals equals null",
    "the underscore underscore init underscore underscore method",
    "add star star slash star dot test dot js",
    "is admin ampersand ampersand has access, not pipe pipe",
    "it should be i plus plus",
    "string colon colon from",
    "the heading should be hash hash installation",
  ];
  for (const text of kept) assert.strictEqual(stripStumbles(text), text);
  assert.strictEqual(
    stripStumbles("um open the the file at dot dot slash utils, uh, then run it"),
    "Open the file at dot dot slash utils, then run it"
  );
});

// The worst case: a model that hands the transcript back word for word, so
// every spoken symbol reaches the backstop as words. Before the exemption it
// broke 16 of them across these transcripts.
test("stripStumbles keeps every spoken symbol of the technical corpus and still drops its fillers", () => {
  for (const item of [...TECHNICAL, ...TECHNICAL_HELDOUT]) {
    const out = stripStumbles(item.text);
    for (const k of item.keep) {
      if (k.any.some((re) => re.test(item.text))) {
        assert.ok(k.any.some((re) => re.test(out)), `${k.name} lost from ${JSON.stringify(out)}`);
      }
    }
    assert.doesNotMatch(out, /(?<![\w-])(?:um|uh)(?![\w-])/i, out);
  }
});

test("route.clean skips the backstop for catalog models measured not to need it", async () => {
  const left = "Run it with dash dash watch and the the tests.";
  const tidied = "Run it with dash dash watch and the tests.";
  const route = loadRouteWith(left);
  for (const model of ["granite-4.0-micro", "qwen3-4b-2507", "gemma-4-12b"]) {
    assert.strictEqual(await route.clean("raw", { engine: "builtin", style: "clean", builtin: { model } }), left, model);
  }
  // The models that leave fillers in, a model the catalog doesn't know (a
  // user-added one), and a remote server all keep the net.
  for (const model of ["gemma-3-1b", "gemma-3-4b", "my-custom-model"]) {
    assert.strictEqual(await route.clean("raw", { engine: "builtin", style: "clean", builtin: { model } }), tidied, model);
  }
  assert.strictEqual(
    await route.clean("raw", { engine: "remote", style: "clean", builtin: { model: "granite-4.0-micro" } }),
    tidied
  );
});

/* ---------------- cleanup dictionary ---------------- */

test("dictionary defaults to empty and a stored list survives the merge", () => {
  assert.deepStrictEqual(DEFAULTS.cleanup.dictionary, []);
  const stored = ["Earheart", "sherpa-onnx"];
  assert.deepStrictEqual(
    deepMerge(DEFAULTS, { cleanup: { dictionary: stored } }).cleanup.dictionary,
    stored
  );
});

test("resolveCleanup injects dictionary terms into the prompt for every style", () => {
  const preset = resolveCleanup({
    systemPrompt: "Base prompt.",
    style: "clean",
    dictionary: ["Earheart", "sherpa-onnx"],
  });
  assert.match(preset.systemPrompt, /Preferred vocabulary/);
  assert.match(preset.systemPrompt, /- Earheart\n- sherpa-onnx/);
  // The style directive still applies after the dictionary block.
  assert.match(preset.systemPrompt, /Editing style:/);

  // The dictionary is orthogonal to the editing style, so custom mode (raw
  // sampling numbers, base prompt untouched otherwise) gets it too.
  const custom = resolveCleanup({
    systemPrompt: "Base prompt.",
    style: "custom",
    custom: { temperature: 0.3 },
    dictionary: ["Earheart"],
  });
  assert.match(custom.systemPrompt, /Preferred vocabulary/);
  assert.match(custom.systemPrompt, /- Earheart/);
});

test("resolveCleanup leaves the prompt unchanged for an empty or blank dictionary", () => {
  const base = { systemPrompt: "Base prompt.", style: "custom", custom: {} };
  assert.strictEqual(resolveCleanup(base).systemPrompt, "Base prompt.");
  assert.strictEqual(
    resolveCleanup({ ...base, dictionary: [] }).systemPrompt,
    "Base prompt."
  );
  // Whitespace-only entries (blank textarea lines) must not produce an empty
  // vocabulary block.
  assert.strictEqual(
    resolveCleanup({ ...base, dictionary: ["  ", ""] }).systemPrompt,
    "Base prompt."
  );
});

/* ---------------- start on boot (autostart) ---------------- */

test("start-on-boot defaults to off and survives the merge both ways", () => {
  assert.strictEqual(DEFAULTS.startOnBoot, false);
  // A stored true must not be reset to the default false.
  assert.strictEqual(deepMerge(DEFAULTS, { startOnBoot: true }).startOnBoot, true);
  assert.strictEqual(deepMerge(DEFAULTS, { startOnBoot: false }).startOnBoot, false);
});

test("linux autostart entry is a valid XDG desktop file launched hidden", () => {
  const entry = autostart.linuxDesktopEntry('"/opt/Earheart.AppImage" --hidden');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /\nType=Application\n/);
  assert.match(entry, /\nExec="\/opt\/Earheart\.AppImage" --hidden\n/);
  // GNOME treats a missing flag as disabled, so it must be present and true.
  assert.match(entry, /\nX-GNOME-Autostart-enabled=true\n/);
});

test("linux launch command starts hidden and prefers $APPIMAGE", () => {
  const saved = process.env.APPIMAGE;
  try {
    process.env.APPIMAGE = "/home/u/Earheart.AppImage";
    assert.strictEqual(
      autostart.linuxLaunchCommand(),
      '"/home/u/Earheart.AppImage" --hidden'
    );
    delete process.env.APPIMAGE;
    assert.ok(autostart.linuxLaunchCommand().endsWith(" --hidden"));
  } finally {
    if (saved === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = saved;
  }
});

test("linux launch command quotes AppImage paths with spaces and field codes", () => {
  const saved = process.env.APPIMAGE;
  try {
    process.env.APPIMAGE = "/home/A User/Earheart 100%.AppImage";
    assert.strictEqual(
      autostart.linuxLaunchCommand(),
      '"/home/A User/Earheart 100%%.AppImage" --hidden'
    );
    // Exec quoting (\") then key-file escaping (\\") — GLib unescapes the
    // key-file layer first, so a single backslash would be rejected.
    assert.strictEqual(
      autostart.desktopExecArg('/tmp/a"b\\c$`'),
      '"/tmp/a\\\\"b\\\\\\\\c\\\\$\\\\`"'
    );
  } finally {
    if (saved === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = saved;
  }
});

test("loginItemEnabled trusts Windows' run key even when openAtLogin lies", () => {
  // The Windows bug: we register the login item with --hidden, but
  // getLoginItemSettings() compares the stored command against the args it's
  // queried with, so a no-args (or mismatched) query reports openAtLogin:false
  // even though the run key is present and fires at boot.
  // executableWillLaunchAtLogin ignores args and reflects the run key, so the
  // toggle reads back as enabled — matching what actually happens on reboot.
  assert.strictEqual(
    autostart.loginItemEnabled({
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
    }),
    true
  );
  // Disabled on Windows: no run key, both signals agree.
  assert.strictEqual(
    autostart.loginItemEnabled({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
    }),
    false
  );
  // macOS/Linux don't report executableWillLaunchAtLogin, so fall back to
  // openAtLogin both ways.
  assert.strictEqual(autostart.loginItemEnabled({ openAtLogin: true }), true);
  assert.strictEqual(autostart.loginItemEnabled({ openAtLogin: false }), false);
  // A bare object (no fields at all) reads as off, never undefined.
  assert.strictEqual(autostart.loginItemEnabled({}), false);
});

test("linux autostart path honours XDG_CONFIG_HOME", () => {
  const path = require("node:path");
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = "/tmp/cfg";
    // Build the expected path with path.join so the separator matches the host
    // OS — the test runs on Windows CI too, where join uses backslashes.
    assert.strictEqual(
      autostart.linuxAutostartPath(),
      path.join("/tmp/cfg", "autostart", "earheart.desktop")
    );
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});

/* ---------------- two-layer transcript reconcile ---------------- */

test("reconcileTranscript shows freshly-spoken words as the faint tail", () => {
  // Cleanup has processed the first four words (fixing case); the fifth was
  // spoken since, so it shows as the not-yet-cleaned tail. Anchoring on the
  // cleaned line's last word survives cleanup's capitalization changes.
  const r = reconcileTranscript("the quick brown fox jumps", "The quick brown fox");
  assert.strictEqual(r.clean, "The quick brown fox");
  assert.strictEqual(r.tail, " jumps");
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript doesn't re-show words when cleanup removed filler", () => {
  // The whole reason cleanup exists: it drops "um" and collapses the stutter, so
  // the cleaned line has fewer words than the raw words it represents. Anchoring
  // on the last cleaned word ("quick") instead of a word-count offset means the
  // already-covered words are NOT duplicated into the tail.
  const r = reconcileTranscript("um the the quick", "The quick");
  assert.strictEqual(r.clean, "The quick");
  assert.strictEqual(r.tail, ""); // "quick" is the last raw word — nothing fresh
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript tails after the anchor despite filler before it", () => {
  // Filler before the anchor word, plus genuinely fresh words after it.
  const r = reconcileTranscript("um so the quick brown fox runs fast", "So the quick brown fox");
  assert.strictEqual(r.tail, " runs fast");
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript anchors on the LAST occurrence of a repeated word", () => {
  // The anchor word ("timer") appears twice; only a last-match scan tails the
  // words after its final occurrence. A first-match implementation would wrongly
  // tail "then set the timer for tea".
  const r = reconcileTranscript("set the timer then set the timer for tea", "Set the timer");
  assert.strictEqual(r.tail, " for tea");
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript shows raw only when there's no cleaned text yet", () => {
  const r = reconcileTranscript("hello world", "");
  assert.strictEqual(r.clean, "");
  assert.strictEqual(r.tail, "hello world");
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript shows the cleaned line alone when the ending was reworded", () => {
  // Cleanup reworded the tail ("alice" never appears in raw), so the anchor isn't
  // found: show the authoritative cleaned line without guessing a tail.
  const r = reconcileTranscript("send it to bob", "Send it to Bob, no to Alice.");
  assert.strictEqual(r.clean, "Send it to Bob, no to Alice.");
  assert.strictEqual(r.tail, "");
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript reports no text when both are empty", () => {
  const r = reconcileTranscript("", "");
  assert.strictEqual(r.hasText, false);
  assert.strictEqual(r.clean, "");
  assert.strictEqual(r.tail, "");
});

test("reconcileTranscript treats the anchor as the last raw word as no tail", () => {
  const r = reconcileTranscript("all done", "All done.");
  assert.strictEqual(r.clean, "All done.");
  assert.strictEqual(r.tail, "");
  assert.strictEqual(r.hasText, true);
});

test("reconcileTranscript collapses internal whitespace in the tail", () => {
  // The tail is rebuilt from split tokens, so runs of spaces normalize to one.
  const r = reconcileTranscript("the quick   brown  fox jumps", "The quick brown fox");
  assert.strictEqual(r.tail, " jumps");
});

test("reconcileTranscript hides whitespace-only input", () => {
  // Whitespace-only clean is treated as no clean; whitespace-only raw with no
  // clean yields no visible text so the overlay panel stays hidden.
  const a = reconcileTranscript("hello world", "   ");
  assert.strictEqual(a.clean, "");
  assert.strictEqual(a.tail, "hello world");
  assert.strictEqual(a.hasText, true);

  const b = reconcileTranscript("   ", "");
  assert.strictEqual(b.hasText, false);
});

test("wavSampleFrames counts frames; 0 for malformed buffers", () => {
  const { wavSampleFrames } = require("../main/util/wav");
  const samples = new Int16Array(1234);
  assert.strictEqual(wavSampleFrames(encodeWav(samples, 16000)), 1234);
  assert.strictEqual(wavSampleFrames(Buffer.from("not a wav")), 0);
});

test("wavSliceFromFrame keeps the exact tail samples", () => {
  const { wavSliceFromFrame } = require("../main/util/wav");
  const samples = new Int16Array(2000);
  for (let i = 0; i < samples.length; i++) samples[i] = i - 1000;
  const tail = wavSliceFromFrame(encodeWav(samples, 16000), 1500);
  const { samples: decoded, sampleRate } = wavToFloat32(tail);
  assert.strictEqual(sampleRate, 16000);
  assert.strictEqual(decoded.length, 500);
  // First tail sample is original frame 1500 (value 500).
  assert.ok(Math.abs(decoded[0] - 500 / 32768) < 1e-6);
  assert.ok(Math.abs(decoded[499] - 999 / 32768) < 1e-6);
});

test("wavSliceFromFrame clamps a past-the-end offset to an empty wav", () => {
  const { wavSliceFromFrame, wavSampleFrames } = require("../main/util/wav");
  const wav = encodeWav(new Int16Array(100), 16000);
  assert.strictEqual(wavSampleFrames(wavSliceFromFrame(wav, 5000)), 0);
  assert.strictEqual(wavSampleFrames(wavSliceFromFrame(wav, -5)), 100);
});

test("wavSlice keeps exactly the [from, to) samples of the range", () => {
  const { wavSlice } = require("../main/util/wav");
  const samples = new Int16Array(2000);
  for (let i = 0; i < samples.length; i++) samples[i] = i - 1000;
  const piece = wavSlice(encodeWav(samples, 16000), 600, 1400);
  const { samples: decoded, sampleRate } = wavToFloat32(piece);
  assert.strictEqual(sampleRate, 16000);
  assert.strictEqual(decoded.length, 800);
  // First sample is original frame 600 (value -400), last is frame 1399 (399).
  assert.ok(Math.abs(decoded[0] - -400 / 32768) < 1e-6);
  assert.ok(Math.abs(decoded[799] - 399 / 32768) < 1e-6);
});

test("wavSlice clamps its range and never returns a negative length", () => {
  const { wavSlice, wavSampleFrames } = require("../main/util/wav");
  const wav = encodeWav(new Int16Array(100), 16000);
  assert.strictEqual(wavSampleFrames(wavSlice(wav, -5, 40)), 40);
  assert.strictEqual(wavSampleFrames(wavSlice(wav, 60, 5000)), 40);
  assert.strictEqual(wavSampleFrames(wavSlice(wav, 70, 30)), 0);
  assert.strictEqual(wavSampleFrames(wavSlice(wav, 0, Infinity)), 100);
});

// A Developer ID release must survive the self-update untouched: re-signing
// it ad-hoc would change its designated requirement, void the user's macOS
// permission grants and break its notarization. Only a bundle that fails
// verification gets re-signed.
test("ensureMacSignature leaves a valid signature alone and repairs a broken one", () => {
  const { ensureMacSignature } = require("../main/util/mac-signature");
  const calls = [];
  const runWith = (verifyStatus, signStatus = 0) => (cmd, args) => {
    calls.push(args.includes("--verify") ? "verify" : "sign");
    return { status: args.includes("--verify") ? verifyStatus : signStatus, stderr: "boom" };
  };

  assert.strictEqual(ensureMacSignature("/A.app", { run: runWith(0) }), "verified");
  assert.deepStrictEqual(calls, ["verify"]);

  calls.length = 0;
  assert.strictEqual(ensureMacSignature("/A.app", { run: runWith(1) }), "re-signed");
  assert.deepStrictEqual(calls, ["verify", "sign"]);

  assert.throws(() => ensureMacSignature("/A.app", { run: runWith(1, 1) }), /Could not sign the updated app: boom/);
});

test("route.clean keeps literals intact on both tidied styles and both engines (#290)", async () => {
  const left = 'So um, run `echo echo` in src/um/ and set it to "um".';
  for (const engine of ["builtin", "remote"]) {
    for (const style of ["clean", "polished"]) {
      const route = loadRouteWith(left);
      assert.strictEqual(
        await route.clean("raw", { engine, style }),
        'So run `echo echo` in src/um/ and set it to "um".',
        `${engine}/${style}`
      );
    }
  }
});
