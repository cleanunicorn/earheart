// Tests for main/util/retry.js: which stage failures are worth another try,
// how many tries each gets, and that the helper rethrows the last error so the
// pipeline's fallbacks run exactly as before once the budget is spent.

const { test } = require("node:test");
const assert = require("node:assert");
const { withRetry, attemptsFor, MAX_ATTEMPTS, RETRY_DELAYS_MS } = require("../main/util/retry");

const coded = (code) => Object.assign(new Error(code), { code });
const status = (s) => Object.assign(new Error(`service error ${s}`), { status: s });

// Runs `withRetry` against a scripted sequence of outcomes (an Error to throw,
// anything else to return), recording the attempts, retries and sleeps.
async function run(outcomes, opts = {}) {
  const seen = { attempts: [], retries: [], sleeps: [] };
  const attempt = async (n) => {
    seen.attempts.push(n);
    const out = outcomes[Math.min(n, outcomes.length) - 1];
    if (out instanceof Error) throw out;
    return out;
  };
  const promise = withRetry(attempt, {
    onRetry: (info) => seen.retries.push(info),
    sleep: async (ms) => {
      seen.sleeps.push(ms);
    },
    ...opts,
  });
  return { promise, seen };
}

test("retry: a worker that died or a service that blinked gets three tries", () => {
  for (const code of ["ENGINE_EXITED", "SERVICE_UNREACHABLE", "SERVICE_DROPPED", "SERVICE_BAD_REPLY"]) {
    assert.strictEqual(attemptsFor(coded(code)), MAX_ATTEMPTS, code);
  }
  for (const s of [408, 429, 500, 502, 503, 504]) assert.strictEqual(attemptsFor(status(s)), 3, String(s));
});

test("retry: a timeout already cost its deadline, so it gets one retry", () => {
  assert.strictEqual(attemptsFor(coded("ENGINE_TIMEOUT")), 2);
  assert.strictEqual(attemptsFor(coded("SERVICE_TIMEOUT")), 2);
});

test("retry: failures a retry would only repeat are not retried", () => {
  // Settings (401/403/404/400), a missing model, a cancel, and a greedy
  // model's empty or runaway reply all come back the same.
  for (const s of [400, 401, 403, 404, 422]) assert.strictEqual(attemptsFor(status(s)), 1, String(s));
  assert.strictEqual(attemptsFor(new Error("model not installed")), 1);
  assert.strictEqual(attemptsFor(new Error("Cleanup returned no usable text")), 1);
  assert.strictEqual(attemptsFor(Object.assign(new Error("aborted"), { name: "AbortError" })), 1);
  assert.strictEqual(attemptsFor(coded("EMPTY_SPEECH")), 1);
  assert.strictEqual(attemptsFor(undefined), 1);
  assert.strictEqual(attemptsFor("a string"), 1);
});

test("retry: a first-try success runs once and never sleeps", async () => {
  const { promise, seen } = await run(["ok"]);
  assert.strictEqual(await promise, "ok");
  assert.deepStrictEqual(seen.attempts, [1]);
  assert.deepStrictEqual(seen.sleeps, []);
  assert.deepStrictEqual(seen.retries, []);
});

test("retry: a passing failure is retried until it succeeds, backing off between tries", async () => {
  const { promise, seen } = await run([coded("ENGINE_EXITED"), status(503), "ok"]);
  assert.strictEqual(await promise, "ok");
  assert.deepStrictEqual(seen.attempts, [1, 2, 3]);
  assert.deepStrictEqual(seen.sleeps, RETRY_DELAYS_MS);
  assert.deepStrictEqual(
    seen.retries.map(({ attempt, of }) => [attempt, of]),
    [[2, 3], [3, 3]],
    "each retry says which try it is, out of how many"
  );
  assert.strictEqual(seen.retries[0].err.code, "ENGINE_EXITED", "and why");
});

test("retry: when the budget is spent the last error is rethrown", async () => {
  const last = coded("SERVICE_UNREACHABLE");
  const { promise, seen } = await run([coded("ENGINE_EXITED"), coded("ENGINE_EXITED"), last, "never"]);
  await assert.rejects(promise, (err) => err === last);
  assert.deepStrictEqual(seen.attempts, [1, 2, 3]);
});

test("retry: a failure that won't pass stops at once, even mid-sequence", async () => {
  const fatal = status(401);
  const { promise, seen } = await run([coded("ENGINE_EXITED"), fatal, "never"]);
  await assert.rejects(promise, (err) => err === fatal);
  assert.deepStrictEqual(seen.attempts, [1, 2]);
});

test("retry: a timeout after a crash ends at the timeout's smaller budget", async () => {
  const timeout = coded("ENGINE_TIMEOUT");
  const { promise, seen } = await run([coded("ENGINE_EXITED"), timeout, "never"]);
  await assert.rejects(promise, (err) => err === timeout);
  assert.deepStrictEqual(seen.attempts, [1, 2]);
});

test("retry: a cancelled dictation is not retried, before or after the pause", async () => {
  const err = coded("ENGINE_EXITED");
  const before = await run([err, "ok"], { stale: () => true });
  await assert.rejects(before.promise, (e) => e === err);
  assert.deepStrictEqual(before.seen.attempts, [1]);
  assert.deepStrictEqual(before.seen.sleeps, [], "no pause for a dictation nobody waits on");

  // Cancelled during the pause: no retry notice, no second attempt.
  let cancelled = false;
  const during = await run([err, "ok"], {
    stale: () => cancelled,
    sleep: async () => {
      cancelled = true;
    },
  });
  await assert.rejects(during.promise, (e) => e === err);
  assert.deepStrictEqual(during.seen.attempts, [1]);
  assert.deepStrictEqual(during.seen.retries, []);
});

test("retry: the default pause is a real timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const promise = withRetry(async () => {
    calls++;
    if (calls === 1) throw coded("ENGINE_EXITED");
    return "ok";
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(calls, 1, "waits before the retry");
  t.mock.timers.tick(RETRY_DELAYS_MS[0]);
  assert.strictEqual(await promise, "ok");
  assert.strictEqual(calls, 2);
});
