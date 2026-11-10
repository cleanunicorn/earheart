// Per-tool policy. A tool is addressed by server id + tool name + a hash of
// its input schema, so a server that changes a tool's schema (or swaps a
// tool for another under the same name) gets no inherited consent: the new
// shape starts disabled, policy "ask". "deny" always beats "enabled".

const POLICIES = new Set(["ask", "deny", "allow"]);
const key = (serverId, tool, schemaHash) => `${serverId}\u0000${tool}\u0000${schemaHash}`;

function createPolicyStore(initial = []) {
  const entries = new Map();
  for (const e of Array.isArray(initial) ? initial : []) {
    if (typeof e?.serverId === "string" && typeof e.tool === "string" && typeof e.schemaHash === "string") {
      entries.set(key(e.serverId, e.tool, e.schemaHash), {
        serverId: e.serverId, tool: e.tool, schemaHash: e.schemaHash,
        enabled: e.enabled === true,
        policy: POLICIES.has(e.policy) ? e.policy : "ask",
      });
    }
  }
  return {
    get(serverId, tool, schemaHash) {
      return entries.get(key(serverId, tool, schemaHash)) ?? { serverId, tool, schemaHash, enabled: false, policy: "ask" };
    },
    set(serverId, tool, schemaHash, { enabled, policy }) {
      const prev = this.get(serverId, tool, schemaHash);
      const next = {
        serverId, tool, schemaHash,
        enabled: typeof enabled === "boolean" ? enabled : prev.enabled,
        policy: POLICIES.has(policy) ? policy : prev.policy,
      };
      entries.set(key(serverId, tool, schemaHash), next);
      return next;
    },
    // Drop every entry of `serverId` whose (tool, schemaHash) is not in `live`.
    prune(serverId, live) {
      const keep = new Set(live.map((t) => key(serverId, t.name, t.schemaHash)));
      for (const [k, e] of entries) if (e.serverId === serverId && !keep.has(k)) entries.delete(k);
    },
    removeServer(serverId) {
      for (const [k, e] of entries) if (e.serverId === serverId) entries.delete(k);
    },
    toJSON() { return [...entries.values()]; },
  };
}

// What may happen to a call: "deny" (never), "ask" (needs approval) or "allow".
function decide(entry) {
  if (!entry || entry.policy === "deny") return { action: "deny", reason: "denied by policy" };
  if (!entry.enabled) return { action: "deny", reason: "tool is disabled" };
  return { action: entry.policy === "allow" ? "allow" : "ask" };
}

module.exports = { createPolicyStore, decide, POLICIES };
