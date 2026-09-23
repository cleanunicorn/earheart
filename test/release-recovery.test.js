const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

function workflowRunSource(source) {
  const match = normalizeNewlines(source).match(/        run: \|\n([\s\S]+)$/);
  if (!match) throw new Error("auto-release workflow run block was not found");
  return match[1].replace(/^          /gm, "");
}

const workflow = normalizeNewlines(
  fs.readFileSync(path.join(ROOT, ".github/workflows/auto-release.yml"), "utf8"),
);
const helperSource = workflow
  .match(/          dispatch_release\(\) \{([\s\S]*?)          # A successful atomic push/)[0]
  .replace(/^          /gm, "");
const fullWorkflowSource = workflowRunSource(workflow);

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

test("full workflow extraction accepts Windows checkout newlines", () => {
  assert.equal(workflowRunSource(workflow.replace(/\n/g, "\r\n")), fullWorkflowSource);
});

test("a pushed release tag survives dispatch exhaustion and is redispatched by a later full workflow run", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-release-workflow-"));
  const repository = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  const remoteTag = path.join(directory, "remote-tag");
  const dispatches = path.join(directory, "dispatches.log");
  const mutations = path.join(directory, "mutations.log");
  fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repository, "main", "services"), { recursive: true });
  fs.mkdirSync(bin);
  for (const file of ["auto-release.js", "changelog.js"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", file), path.join(repository, "scripts", file));
  }
  fs.copyFileSync(
    path.join(ROOT, "main", "services", "release-notes.js"),
    path.join(repository, "main", "services", "release-notes.js"),
  );
  fs.copyFileSync(
    path.join(ROOT, "main", "services", "update-feed.js"),
    path.join(repository, "main", "services", "update-feed.js"),
  );
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ version: "1.2.2" }));
  fs.writeFileSync(path.join(repository, "package-lock.json"), JSON.stringify({ version: "1.2.2" }));
  fs.writeFileSync(
    path.join(repository, "CHANGELOG.md"),
    "# Changelog\n\n## v1.2.2 — 2026-09-20\n\n- Boundary (#100)\n",
  );
  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
case "$1" in
  fetch|reset|config|add) exit 0 ;;
  for-each-ref) [[ -f "$WORKFLOW_REMOTE_TAG" ]] && printf 'v1.2.3\\tabc123\\n' ;;
  log) printf 'release: v1.2.3\\n' ;;
  merge-base) exit 0 ;;
  rev-parse) printf 'abc123\\n' ;;
  commit|tag) printf '%s\\n' "$*" >> "$WORKFLOW_MUTATIONS" ;;
  push) printf '%s\\n' "$*" >> "$WORKFLOW_MUTATIONS"; touch "$WORKFLOW_REMOTE_TAG" ;;
  *) exit 89 ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$WORKFLOW_MUTATIONS"
"$WORKFLOW_NODE" -e 'const fs=require("node:fs"); for (const file of ["package.json", "package-lock.json"]) { const json=JSON.parse(fs.readFileSync(file)); json.version="1.2.3"; fs.writeFileSync(file, JSON.stringify(json)); }'
`,
  );
  writeExecutable(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
case "$1 $2" in
  "api -i") printf 'HTTP/2 404\\n'; exit 1 ;;
  "api --paginate")
    printf '%s\\n' '{"number":101,"title":"fix: recovery","mergedAt":"2026-09-21T10:00:00Z"}' '{"number":100,"title":"fix: boundary","mergedAt":"2026-09-20T10:00:00Z"}' ;;
  "run list") printf '[]\\n' ;;
  "workflow run")
    printf 'v1.2.3\\n' >> "$WORKFLOW_DISPATCHES"
    [[ "$WORKFLOW_PHASE" == fail ]] && exit 1
    exit 0 ;;
  *) exit 88 ;;
esac
`,
  );
  writeExecutable(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  const run = (phase) =>
    spawnSync("bash", ["-c", fullWorkflowSource], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "test-token",
        TRIGGER_PR: "101",
        TRIGGER_TITLE: "fix: recovery",
        RUNNER_TEMP: directory,
        GITHUB_REPOSITORY: "owner/repo",
        WORKFLOW_NODE: process.execPath,
        WORKFLOW_REMOTE_TAG: remoteTag,
        WORKFLOW_DISPATCHES: dispatches,
        WORKFLOW_MUTATIONS: mutations,
        WORKFLOW_PHASE: phase,
      },
    });
  const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);

  const exhausted = run("fail");
  assert.equal(exhausted.status, 1);
  assert.ok(fs.existsSync(remoteTag), `the atomic push should persist the release tag: ${exhausted.stderr}`);
  assert.deepStrictEqual(readLines(dispatches), ["v1.2.3", "v1.2.3", "v1.2.3"]);
  const firstMutations = readLines(mutations);
  assert.deepStrictEqual(firstMutations, [
    "version patch --no-git-tag-version",
    "commit -m release: v1.2.3",
    "tag -a v1.2.3 -m v1.2.3",
    "push --atomic origin HEAD:main refs/tags/v1.2.3:refs/tags/v1.2.3",
  ]);

  const later = run("success");
  assert.equal(later.status, 0);
  assert.deepStrictEqual(readLines(dispatches), ["v1.2.3", "v1.2.3", "v1.2.3", "v1.2.3"]);
  assert.deepStrictEqual(readLines(mutations), firstMutations);
  fs.rmSync(directory, { recursive: true, force: true });
});
