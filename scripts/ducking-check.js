#!/usr/bin/env node
// Manual check for "lower other audio while recording" on the machine it runs
// on: picks the platform backend the app would use (main/ducking/backends.js),
// lowers the default output through the real controller, holds it, restores
// it, and prints the volume at each step. Plain Node — no Electron, no
// settings, nothing persisted (the marker lives in memory).
//
//   node scripts/ducking-check.js [--level=20] [--hold=3] [--backend=wpctl]
//
// Exits 1 when the volume after the restore differs from the one before.
// Play some audio while it runs to hear the effect.

const { execFileAsync } = require("../main/util/exec-file");
const { candidates } = require("../main/ducking/backends");
const { createDucker } = require("../main/ducking/controller");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const level = Number(arg("level", "20"));
  const holdMs = Number(arg("hold", "3")) * 1000;
  const only = arg("backend", "");
  const run = (cmd, args, opts = {}) => execFileAsync(cmd, args, { timeout: 20000, ...opts });
  const backends = candidates(process.platform, run).filter((b) => !only || b.name === only);
  let marker = null;
  const ducker = createDucker({
    backends,
    store: { load: () => marker, save: (m) => { marker = m; }, clear: () => { marker = null; } },
    getConfig: () => ({ enabled: true, levelPercent: level }),
    logger: { warn: (m) => console.log(`  warn: ${m}`), info: (m) => console.log(`  info: ${m}`) },
  });
  const status = await ducker.getStatus();
  console.log(`backend: ${status.available ? status.mechanism : `unavailable (${status.reason})`}`);
  if (!status.available) return 0;
  const b = backends.find((x) => x.name === status.mechanism);
  const show = (label, s) =>
    console.log(`${label.padEnd(8)} device=${s?.device} volume=${s?.volume} muted=${s?.muted} raw=${JSON.stringify(s?.raw)}`);

  const before = await b.read();
  show("before", before);
  await ducker.setCapturing("check", true);
  show("lowered", await b.read(before.device));
  const after1 = await ducker.getStatus();
  if (after1.state !== "lowered") console.log(`  not lowered: ${after1.detail || after1.lastError}`);
  await new Promise((r) => setTimeout(r, holdMs));
  await ducker.setCapturing("check", false);
  const after = await b.read(before.device);
  show("after", after);
  const same = after && b.same(after.raw, before.raw) && after.muted === before.muted;
  console.log(same ? "OK: restored to the volume before" : "FAIL: volume differs from before");
  return same ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
