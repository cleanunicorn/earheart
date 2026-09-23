const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/auto-release.yml"), "utf8");
const helperSource = workflow
  .match(/          dispatch_release\(\) \{([\s\S]*?)          # A successful atomic push/)[0]
  .replace(/^          /gm, "");

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function runRecovery({ dispatchMode = "success", release = "missing", active = "none" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-release-recovery-"));
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "dispatches.log");
  fs.mkdirSync(bin);
  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  for-each-ref) printf 'v1.2.3\\tabc123\\n' ;;
  log) printf 'release: v1.2.3\\n' ;;
  merge-base) exit 0 ;;
  rev-parse) printf 'abc123\\n' ;;
  *) printf '%s\\n' "$*" >> "$RECOVERY_GIT_LOG" ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
case "$1 $2" in
  "api -i")
    if [[ "$RECOVERY_RELEASE" == exists ]]; then printf 'HTTP/2 200\\n'; exit 0; fi
    printf 'HTTP/2 404\\n'; exit 1 ;;
  "run list")
    if [[ "$RECOVERY_ACTIVE" == active || ( "$RECOVERY_DISPATCH_MODE" == accepted-error && -f "$RECOVERY_ACCEPTED" ) ]]; then
      printf '[{"status":"in_progress","headBranch":"v1.2.3","headSha":"abc123"}]\\n'
    else
      printf '[]\\n'
    fi ;;
  "workflow run")
    printf 'v1.2.3\\n' >> "$RECOVERY_DISPATCH_LOG"
    if [[ "$RECOVERY_DISPATCH_MODE" == fail ]]; then exit 1; fi
    if [[ "$RECOVERY_DISPATCH_MODE" == accepted-error ]]; then touch "$RECOVERY_ACCEPTED"; exit 1; fi
    exit 0 ;;
  *) exit 88 ;;
esac
`,
  );
  writeExecutable(path.join(bin, "npm"), "#!/usr/bin/env bash\nprintf 'npm called\\n' >> \"$RECOVERY_MUTATION_LOG\"\nexit 91\n");
  writeExecutable(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  const script = `max_attempts=3\n${helperSource}\nrecover_pushed_tags\n`;
  const result = spawnSync("bash", ["-c", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      GITHUB_REPOSITORY: "owner/repo",
      RECOVERY_DISPATCH_MODE: dispatchMode,
      RECOVERY_RELEASE: release,
      RECOVERY_ACTIVE: active,
      RECOVERY_ACCEPTED: path.join(directory, "accepted"),
      RECOVERY_DISPATCH_LOG: log,
      RECOVERY_GIT_LOG: path.join(directory, "git.log"),
      RECOVERY_MUTATION_LOG: path.join(directory, "mutations.log"),
    },
  });
  const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);
  const outcome = {
    status: result.status,
    dispatches: readLines(log),
    mutations: readLines(path.join(directory, "mutations.log")),
    stdout: result.stdout,
    stderr: result.stderr,
  };
  fs.rmSync(directory, { recursive: true, force: true });
  return outcome;
}

test("recovery retries a failed dispatch, then later dispatches the same durable tag without mutation", () => {
  const exhausted = runRecovery({ dispatchMode: "fail" });
  assert.equal(exhausted.status, 1);
  assert.deepStrictEqual(exhausted.dispatches, ["v1.2.3", "v1.2.3", "v1.2.3"]);

  const later = runRecovery();
  assert.equal(later.status, 0);
  assert.deepStrictEqual(later.dispatches, ["v1.2.3"]);
  assert.deepStrictEqual(later.mutations, []);
});

test("recovery suppresses tags owned by a release or active build", () => {
  for (const options of [{ release: "exists" }, { active: "active" }]) {
    const result = runRecovery(options);
    assert.equal(result.status, 0);
    assert.deepStrictEqual(result.dispatches, []);
  }
});

test("an accepted-but-ambiguous dispatch is reconciled before it can be retried", () => {
  const result = runRecovery({ dispatchMode: "accepted-error" });
  assert.equal(result.status, 0);
  assert.deepStrictEqual(result.dispatches, ["v1.2.3"]);
});
