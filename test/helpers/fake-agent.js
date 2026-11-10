// A fake agent CLI for the task-store tests. The first word of the stdin
// prompt picks the behaviour; events are JSON lines like a real agent's.
if (!process.argv[2]) process.exit(0); // picked up by the test runner, not a test
const mode = process.argv[2];
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const word = input.trim().split(/\s+/)[0];
  const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
  const sid = process.env.FAKE_SESSION || "sess-1";
  const resumed = mode === "resume" ? process.argv[3] : null;
  if (word === "nosession") { setInterval(() => {}, 1000); return; } // never says anything
  if (word === "authfail") { process.stderr.write("not logged in\n"); process.exit(1); }
  emit({ type: "session", id: resumed || sid });
  emit({ type: "message", text: `echo:${input.trim()}` });
  if (word === "hang") { setInterval(() => {}, 1000); return; }
  if (word === "stubborn") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); return; }
  if (word === "boom") { emit({ type: "error", message: "model exploded" }); process.exit(1); }
  emit({ type: "done", ok: true });
});
