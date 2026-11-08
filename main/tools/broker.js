// Approval broker: correlates each pending tool call with a random,
// single-use id bound to the exact arguments, expires it, and settles every
// pending request when its window closes, the app quits or its server is
// removed. UI-agnostic: it never touches a window itself.
//
// Guarantees (test/tools-broker.test.js):
//   - an id is consumed *before* the decision is delivered, so it can never
//     authorize a second call
//   - an expired or cancelled id cannot be resolved
//   - nothing but an explicit "allow" approves
//   - requests are shown one at a time, in order

const crypto = require("node:crypto");
const { line } = require("./output");

const DEFAULT_TTL_MS = 60_000;
const MAX_QUEUE = 8;

function createBroker({ ttlMs = DEFAULT_TTL_MS, onChange = () => {}, now = Date.now, randomId = () => crypto.randomBytes(16).toString("hex") } = {}) {
  const queue = []; // { id, view, argsHash, serverId, settle, timer }

  const emit = () => { try { onChange(current()); } catch { /* UI is best effort */ } };
  const current = () => (queue[0] ? { ...queue[0].view } : null);

  function drop(entry) {
    const i = queue.indexOf(entry);
    if (i === -1) return false;
    queue.splice(i, 1);
    clearTimeout(entry.timer);
    return true;
  }

  // info: { serverId, serverName, tool, description, args, argsHash }
  function request(info, { signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve({ approved: false, reason: "cancelled" });
      if (queue.length >= MAX_QUEUE) return resolve({ approved: false, reason: "too many pending approvals" });
      const id = randomId();
      const expiresAt = now() + ttlMs;
      let text;
      try { text = JSON.stringify(info.args, null, 2); } catch { text = "(unprintable arguments)"; }
      const entry = {
        id, argsHash: info.argsHash, serverId: info.serverId,
        view: {
          id, expiresAt,
          server: line(info.serverName, 60),
          tool: line(info.tool, 80),
          description: line(info.description ?? "", 300),
          // Truncated, plain text. The renderer must still use textContent.
          args: text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text,
        },
        settle: resolve,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        if (drop(entry)) { resolve({ approved: false, reason: "approval expired" }); emit(); }
      }, ttlMs);
      entry.timer.unref?.();
      if (signal) {
        // A caller that gives up withdraws its prompt: nobody can approve a dead call.
        signal.addEventListener("abort", () => {
          if (drop(entry)) { resolve({ approved: false, reason: "cancelled" }); emit(); }
        }, { once: true });
      }
      queue.push(entry);
      emit();
    });
  }

  // Resolve one request. `decision` must be exactly "allow" to approve.
  // Returns false for an unknown, expired or already used id.
  function decide(id, decision) {
    const entry = queue.find((e) => e.id === id);
    if (!entry || typeof id !== "string") return false;
    if (now() > entry.view.expiresAt) { drop(entry); entry.settle({ approved: false, reason: "approval expired" }); emit(); return false; }
    drop(entry); // consumed before anything else can observe it
    entry.settle(decision === "allow"
      ? { approved: true, argsHash: entry.argsHash }
      : { approved: false, reason: "denied by user" });
    emit();
    return true;
  }

  function cancel(predicate, reason) {
    for (const entry of [...queue]) {
      if (predicate(entry) && drop(entry)) entry.settle({ approved: false, reason });
    }
    emit();
  }

  return {
    request,
    decide,
    current,
    size: () => queue.length,
    cancelAll: (reason = "cancelled") => cancel(() => true, reason),
    cancelServer: (serverId, reason = "server removed") => cancel((e) => e.serverId === serverId, reason),
  };
}

module.exports = { createBroker, DEFAULT_TTL_MS };
