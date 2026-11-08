// The tools manager: owns server configuration, the discovered tool catalog,
// policies, the approval broker and every client process.
//
// execute() is the only path to a tool call. Order, with every refusal
// returning { ok: false, error } and never throwing, so a failing tool can
// not stall dictation:
//   server enabled -> tool discovered at the current schema -> policy
//   (deny/disabled never run) -> schema validation -> approval (ask) ->
//   re-check of all of the above (config or policy may have changed while
//   the user decided) -> bounded call -> sanitized result.
// Servers start lazily (first discovery or call), never at app boot.

const { createClient: realCreateClient } = require("./client");
const { validateServer, validateServers, publicServer, redact, MAX_SERVERS } = require("./config");
const { validateArgs, unsupportedReason, hashSchema, hashArgs } = require("./schema");
const { createPolicyStore, decide } = require("./policy");
const { createBroker } = require("./broker");
const { summarizeResult, boundedError, asModelData, line } = require("./output");

const IDLE_MS = 5 * 60_000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const SHUTDOWN_MS = 2500;

function createManager({ store, createClient = realCreateClient, clientOptions = {}, brokerOptions = {}, onApprovalChange = () => {}, idleMs = IDLE_MS, now = Date.now, log = () => {} } = {}) {
  const loaded = store.load();
  let servers = loaded.servers;
  const policies = createPolicyStore(loaded.policies);
  const catalog = new Map(); // serverId -> { tools: [...], at, error }
  const clients = new Map(); // serverId -> { client, idle }
  const crashes = new Map(); // serverId -> [timestamps]
  const revisions = new Map(); // serverId -> number, bumped by config/policy changes
  const broker = createBroker({ ...brokerOptions, onChange: onApprovalChange, now });
  let shuttingDown = false;

  const bump = (id) => revisions.set(id, (revisions.get(id) ?? 0) + 1);
  const rev = (id) => revisions.get(id) ?? 0;
  const find = (id) => servers.find((s) => s.id === id);
  const persist = () => store.save({ servers, policies: policies.toJSON() });

  async function dropClient(serverId) {
    const entry = clients.get(serverId);
    if (!entry) return;
    clients.delete(serverId);
    clearTimeout(entry.idle);
    await entry.client.close().catch(() => {});
  }

  function clientFor(server) {
    if (shuttingDown) throw new Error("Earheart is shutting down");
    const recent = (crashes.get(server.id) ?? []).filter((t) => now() - t < CRASH_WINDOW_MS);
    crashes.set(server.id, recent);
    if (recent.length >= CRASH_LIMIT) throw new Error("server keeps crashing; wait a minute or fix its command, then refresh");
    let entry = clients.get(server.id);
    if (entry?.client.dead) { clients.delete(server.id); clearTimeout(entry.idle); entry.client.close().catch(() => {}); entry = null; }
    if (!entry) {
      const client = createClient(server, clientOptions);
      client.onExit((info) => {
        if (clients.get(server.id)?.client === client) {
          crashes.get(server.id)?.push(now());
          clients.delete(server.id);
          clearTimeout(entry?.idle);
        }
      });
      entry = { client, idle: null };
      clients.set(server.id, entry);
    }
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => dropClient(server.id), idleMs);
    entry.idle.unref?.();
    return entry.client;
  }

  const describe = (server, tool) => {
    const p = policies.get(server.id, tool.name, tool.schemaHash);
    return { name: tool.name, description: tool.description, schemaHash: tool.schemaHash, usable: tool.usable, problem: tool.problem ?? null, enabled: p.enabled, policy: p.policy };
  };

  function view() {
    return servers.map((s) => ({
      ...publicServer(s),
      discovered: catalog.has(s.id),
      discoveryError: catalog.get(s.id)?.error ?? null,
      tools: (catalog.get(s.id)?.tools ?? []).map((t) => describe(s, t)),
    }));
  }

  // --- configuration -------------------------------------------------------

  async function saveServer(raw) {
    const existing = find(raw?.id);
    // A secret the form didn't re-enter keeps its stored value.
    const env = {};
    for (const [k, e] of Object.entries(raw?.env && typeof raw.env === "object" ? raw.env : {})) {
      const prev = existing?.env[k];
      env[k] = e && typeof e === "object" && e.secret && e.keep && prev?.secret ? { ...prev } : e;
    }
    const res = validateServer({ ...raw, env });
    if (res.errors) return { ok: false, errors: res.errors };
    const next = res.server;
    if (!existing && servers.length >= MAX_SERVERS) return { ok: false, errors: ["too many servers"] };
    const prior = servers;
    servers = existing ? servers.map((s) => (s.id === next.id ? next : s)) : [...servers, next];
    try { persist(); } catch (err) { servers = prior; return { ok: false, errors: [`could not save: ${boundedError(err)}`] }; }
    bump(next.id);
    // Whatever changed, a pending approval was given for the old state.
    broker.cancelServer(next.id, "server configuration changed");
    // A different program, arguments, directory or environment is a different
    // server: stop the process and forget what it listed. Renaming it or
    // flipping `enabled` keeps the catalog; disabling still stops the process.
    const launch = (s) => JSON.stringify([s.command, s.args, s.cwd, Object.entries(s.env).map(([k, e]) => [k, e.value])]);
    const relaunch = !existing || launch(existing) !== launch(next);
    if (relaunch || !next.enabled) await dropClient(next.id);
    if (relaunch) catalog.delete(next.id);
    return { ok: true, servers: view() };
  }

  async function removeServer(id) {
    if (!find(id)) return { ok: false, errors: ["unknown server"] };
    const prior = servers;
    servers = servers.filter((s) => s.id !== id);
    policies.removeServer(id);
    try { persist(); } catch (err) { servers = prior; return { ok: false, errors: [`could not save: ${boundedError(err)}`] }; }
    bump(id);
    broker.cancelServer(id, "server removed");
    await dropClient(id);
    catalog.delete(id);
    return { ok: true, servers: view() };
  }

  async function discover(serverId) {
    const server = find(serverId);
    if (!server) return { ok: false, error: "unknown server" };
    const startRev = rev(serverId);
    try {
      const client = clientFor(server);
      const listed = await client.listTools();
      if (rev(serverId) !== startRev) return { ok: false, error: "server changed during discovery" };
      const tools = listed.map((t) => {
        const problem = unsupportedReason(t.inputSchema);
        return { ...t, schemaHash: hashSchema(t.inputSchema), usable: !problem, problem };
      });
      policies.prune(serverId, tools);
      catalog.set(serverId, { tools, at: now(), error: null });
    } catch (err) {
      const message = line(redact(err?.message ?? err, server), 300);
      catalog.set(serverId, { tools: [], at: now(), error: message });
      await dropClient(serverId);
      return { ok: false, error: message, servers: view() };
    }
    try { persist(); } catch (err) { log(`could not save tool policies: ${boundedError(err)}`); }
    return { ok: true, servers: view() };
  }

  // Discover every enabled server that has no catalog yet (e.g. after a restart).
  async function prepare() {
    await Promise.all(servers.filter((s) => s.enabled && !catalog.has(s.id)).map((s) => discover(s.id)));
  }

  function setPolicy({ serverId, tool, schemaHash, enabled, policy }) {
    const server = find(serverId);
    const t = catalog.get(serverId)?.tools.find((x) => x.name === tool && x.schemaHash === schemaHash);
    if (!server || !t) return { ok: false, error: "unknown tool; refresh the server first" };
    if (enabled === true && !t.usable) return { ok: false, error: `cannot enable: ${t.problem}` };
    policies.set(serverId, tool, schemaHash, { enabled, policy });
    try { persist(); } catch (err) { return { ok: false, error: `could not save: ${boundedError(err)}` }; }
    bump(serverId);
    // Turning a tool off or to deny withdraws any approval already asked for.
    if (enabled === false || policy === "deny") broker.cancelServer(serverId, "policy changed");
    return { ok: true, servers: view() };
  }

  // --- model-facing seam (command mode, #344) ------------------------------

  // Tools the model may be offered: server enabled, tool enabled, not denied,
  // schema supported. Everything else is simply absent.
  function modelCatalog() {
    const out = [];
    for (const s of servers) {
      if (!s.enabled) continue;
      for (const t of catalog.get(s.id)?.tools ?? []) {
        const p = policies.get(s.id, t.name, t.schemaHash);
        if (t.usable && decide(p).action !== "deny") out.push({ serverId: s.id, serverName: s.name, tool: t.name, description: t.description, inputSchema: t.inputSchema });
      }
    }
    return out;
  }

  // Resolve a call to {server, tool, entry} against the *current* state.
  function resolveCall(serverId, toolName, schemaHash) {
    const server = find(serverId);
    if (!server || !server.enabled) return { error: "server is not enabled" };
    const tool = catalog.get(serverId)?.tools.find((t) => t.name === toolName);
    if (!tool) return { error: "tool is not in the discovered catalog" };
    if (schemaHash && tool.schemaHash !== schemaHash) return { error: "tool changed since it was approved" };
    if (!tool.usable) return { error: `tool schema is unsupported: ${tool.problem}` };
    const verdict = decide(policies.get(serverId, toolName, tool.schemaHash));
    if (verdict.action === "deny") return { error: verdict.reason };
    return { server, tool, verdict };
  }

  async function execute({ serverId, tool: toolName, args, signal } = {}) {
    try {
      // After a restart the catalog is empty: list the enabled server's tools
      // on first use. Consent is keyed by schema hash, so this grants nothing.
      if (find(serverId)?.enabled && !catalog.has(serverId)) await discover(serverId);
      const first = resolveCall(serverId, toolName);
      if (first.error) return { ok: false, error: first.error };
      const { server, tool } = first;
      // Work on a private JSON copy: what is validated, shown, hashed and sent
      // must be one and the same value.
      let sent;
      try { sent = JSON.parse(JSON.stringify(args ?? {})); } catch { return { ok: false, error: "arguments are not valid JSON" }; }
      const valid = validateArgs(tool.inputSchema, sent);
      if (!valid.ok) return { ok: false, error: `invalid arguments: ${valid.errors.slice(0, 3).join("; ")}` };
      const argsHash = hashArgs(sent);
      const startRev = rev(serverId);

      if (first.verdict.action === "ask") {
        const asked = await broker.request({ serverId, serverName: server.name, tool: toolName, description: tool.description, args: sent, argsHash }, { signal });
        if (!asked.approved || asked.argsHash !== argsHash) return { ok: false, error: asked.reason ?? "not approved", denied: true };
        // The user took time to decide; consent applies to the state they saw.
        if (rev(serverId) !== startRev) return { ok: false, error: "configuration changed while waiting for approval", denied: true };
        const again = resolveCall(serverId, toolName, tool.schemaHash);
        if (again.error || again.verdict.action === "deny") return { ok: false, error: again.error ?? "policy changed", denied: true };
        if (!validateArgs(again.tool.inputSchema, sent).ok) return { ok: false, error: "invalid arguments", denied: true };
      }
      if (signal?.aborted) return { ok: false, error: "cancelled" };

      const client = clientFor(server);
      const raw = await client.callTool(toolName, sent, { signal });
      const summary = summarizeResult(raw);
      return { ok: !summary.isError, isError: summary.isError, text: summary.text, modelText: asModelData(server.name, toolName, summary) };
    } catch (err) {
      return { ok: false, error: line(redact(err?.message ?? err, find(serverId)), 300) };
    }
  }

  async function shutdown(deadlineMs = SHUTDOWN_MS) {
    shuttingDown = true;
    broker.cancelAll("Earheart is quitting");
    const all = Promise.allSettled([...clients.keys()].map(dropClient));
    await Promise.race([all, new Promise((r) => { const t = setTimeout(r, deadlineMs); t.unref?.(); })]);
  }

  return {
    view, saveServer, removeServer, discover, prepare, setPolicy, modelCatalog, execute, shutdown,
    broker,
    running: () => clients.size,
    // test hooks
    _clients: clients,
  };
}

module.exports = { createManager };
