// Unit tests for the pure (non-Electron) parts of the main process.
// Run with: npm test

const { test } = require("node:test");
const assert = require("node:assert");

const http = require("node:http");

const { encodeWav, encodeSilenceWav, wavToFloat32, wavDurationSec } = require("../main/util/wav");
const { stripThinking } = require("../main/services/cleanup");
const { deepMerge, migrateLegacy, DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");
const autostart = require("../main/autostart");
const { listRemoteModels } = require("../main/services/models-remote");
const { reconcileTranscript } = require("../renderer/transcript");

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

test("stripThinking removes reasoning blocks", () => {
  assert.strictEqual(
    stripThinking("<think>hmm, let me see</think>Hello world."),
    "Hello world."
  );
  assert.strictEqual(stripThinking("No tags here."), "No tags here.");
  assert.strictEqual(
    stripThinking("<THINK>a</THINK>\n\n  Result  "),
    "Result"
  );
});

test("deepMerge keeps defaults for missing keys and overrides present ones", () => {
  const base = { a: 1, nested: { x: "default", y: 2 }, arr: [1, 2] };
  const override = { nested: { x: "custom" }, arr: [3] };
  const merged = deepMerge(base, override);
  assert.deepStrictEqual(merged, {
    a: 1,
    nested: { x: "custom", y: 2 },
    arr: [3],
  });
});

test("deepMerge ignores null/undefined overrides", () => {
  assert.deepStrictEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
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

test("migrateLegacy maps pre-engine settings onto external engines", () => {
  // The old local autostart server has been removed; a config that used it
  // folds into "remote" and the stale sttServer key is dropped.
  const autostart = migrateLegacy({
    stt: { baseUrl: "http://x" },
    cleanup: { enabled: true },
    sttServer: { autoStart: true },
  });
  assert.strictEqual(autostart.stt.engine, "remote");
  assert.strictEqual(autostart.cleanup.engine, "remote");
  assert.ok(!("sttServer" in autostart));

  // No engine field -> "remote".
  const remote = migrateLegacy({ stt: {}, cleanup: {}, sttServer: {} });
  assert.strictEqual(remote.stt.engine, "remote");
  assert.ok(!("sttServer" in remote));

  // A config already carrying the removed "server" engine is rewritten too.
  const legacyServer = migrateLegacy({ stt: { engine: "server" }, cleanup: {} });
  assert.strictEqual(legacyServer.stt.engine, "remote");
});

test("migrateLegacy leaves fresh and already-migrated configs untouched", () => {
  assert.deepStrictEqual(migrateLegacy({}), {}); // fresh install
  const modern = { stt: { engine: "builtin" }, cleanup: { engine: "builtin" } };
  assert.deepStrictEqual(migrateLegacy(modern), modern);
});

test("new installs default to in-process engines", () => {
  assert.strictEqual(DEFAULTS.stt.engine, "builtin");
  assert.strictEqual(DEFAULTS.cleanup.engine, "builtin");
  assert.strictEqual(DEFAULTS.cleanup.enabled, true);
  assert.ok(DEFAULTS.stt.builtin.model);
  assert.ok(DEFAULTS.cleanup.builtin.model);
});

test("customModels defaults to empty and a stored list survives the merge", () => {
  assert.deepStrictEqual(DEFAULTS.customModels, []);
  const stored = [{ id: "custom-x", kind: "cleanup", files: [] }];
  // deepMerge replaces arrays wholesale, so a saved custom-models list is kept
  // intact (not element-merged against the empty default) when settings load.
  assert.deepStrictEqual(deepMerge(DEFAULTS, { customModels: stored }).customModels, stored);
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
  const entry = autostart.linuxDesktopEntry("/opt/Earheart.AppImage --hidden");
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /\nType=Application\n/);
  assert.match(entry, /\nExec=\/opt\/Earheart\.AppImage --hidden\n/);
  // GNOME treats a missing flag as disabled, so it must be present and true.
  assert.match(entry, /\nX-GNOME-Autostart-enabled=true\n/);
});

test("linux launch command starts hidden and prefers $APPIMAGE", () => {
  const saved = process.env.APPIMAGE;
  try {
    process.env.APPIMAGE = "/home/u/Earheart.AppImage";
    assert.strictEqual(
      autostart.linuxLaunchCommand(),
      "/home/u/Earheart.AppImage --hidden"
    );
    delete process.env.APPIMAGE;
    assert.ok(autostart.linuxLaunchCommand().endsWith(" --hidden"));
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

/* ---------------- live preview ---------------- */

test("live preview defaults are present and overridable", () => {
  const lp = DEFAULTS.stt.livePreview;
  assert.strictEqual(lp.enabled, true);
  assert.ok(lp.intervalMs > 0);
  assert.ok(lp.chunkSeconds > 0);
  assert.ok(lp.cleanupPauseMs > 0);

  // A saved file that only flips the toggle keeps the rest of the tuning.
  const off = deepMerge(DEFAULTS, { stt: { livePreview: { enabled: false } } });
  assert.strictEqual(off.stt.livePreview.enabled, false);
  assert.strictEqual(off.stt.livePreview.intervalMs, lp.intervalMs);
  assert.strictEqual(off.stt.livePreview.cleanupPauseMs, lp.cleanupPauseMs);
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

/* ---------------- remote model listing ---------------- */

function serveJson(handler) {
  const server = http.createServer((req, res) => {
    const { status, body } = handler(req);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

test("listRemoteModels parses OpenAI shape, sorts and de-dupes", async () => {
  const { server, base } = await serveJson((req) => {
    assert.strictEqual(req.url, "/v1/models");
    assert.strictEqual(req.headers.authorization, "Bearer secret");
    return {
      status: 200,
      body: { data: [{ id: "gpt-z" }, { id: "gpt-a" }, { id: "gpt-a" }] },
    };
  });
  try {
    const models = await listRemoteModels({ baseUrl: base, apiKey: "secret" });
    assert.deepStrictEqual(models, ["gpt-a", "gpt-z"]);
  } finally {
    server.close();
  }
});

test("listRemoteModels accepts a bare array and omits the auth header without a key", async () => {
  const { server, base } = await serveJson((req) => {
    assert.strictEqual(req.headers.authorization, undefined);
    return { status: 200, body: ["b", "a"] };
  });
  try {
    const models = await listRemoteModels({ baseUrl: base });
    assert.deepStrictEqual(models, ["a", "b"]);
  } finally {
    server.close();
  }
});

test("listRemoteModels surfaces HTTP errors", async () => {
  const { server, base } = await serveJson(() => ({ status: 401, body: { error: "nope" } }));
  try {
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /HTTP 401/);
  } finally {
    server.close();
  }
});

test("listRemoteModels requires a base URL", async () => {
  await assert.rejects(() => listRemoteModels({}), /Base URL is required/);
});

test("listRemoteModels rejects a non-http(s) base URL", async () => {
  await assert.rejects(
    () => listRemoteModels({ baseUrl: "file:///etc/passwd" }),
    /must use http or https/
  );
});

test("listRemoteModels returns an empty list when the service reports none", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: { data: [] } }));
  try {
    assert.deepStrictEqual(await listRemoteModels({ baseUrl: base }), []);
  } finally {
    server.close();
  }
});

test("listRemoteModels rejects a non-JSON body", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: "not json{" }));
  try {
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /did not return JSON/);
  } finally {
    server.close();
  }
});

test("listRemoteModels rejects an unexpected JSON shape", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: { notdata: 1 } }));
  try {
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /Unexpected/);
  } finally {
    server.close();
  }
});

test("listRemoteModels strips a trailing slash before appending /models", async () => {
  const { server, base } = await serveJson((req) => {
    assert.strictEqual(req.url, "/v1/models"); // not /v1//models
    return { status: 200, body: { data: [{ id: "m" }] } };
  });
  try {
    // base already ends in /v1; add another slash so joinUrl has to strip it.
    assert.deepStrictEqual(await listRemoteModels({ baseUrl: `${base}/` }), ["m"]);
  } finally {
    server.close();
  }
});

test("listRemoteModels wraps a network failure with the URL", async () => {
  // Port 1 is not listenable, so the fetch rejects at the connection stage.
  await assert.rejects(
    () => listRemoteModels({ baseUrl: "http://127.0.0.1:1/v1" }),
    /Could not reach/
  );
});

test("idle model unload defaults to a finite window and is overridable", () => {
  // Sensible default: unload after a couple of idle minutes.
  assert.strictEqual(DEFAULTS.engines.idleUnloadMinutes, 2);
  // A stored 0 (never unload) must survive the merge, not be reset to default.
  const never = deepMerge(DEFAULTS, { engines: { idleUnloadMinutes: 0 } });
  assert.strictEqual(never.engines.idleUnloadMinutes, 0);
  // A stored custom window survives too.
  const custom = deepMerge(DEFAULTS, { engines: { idleUnloadMinutes: 10 } });
  assert.strictEqual(custom.engines.idleUnloadMinutes, 10);
});
