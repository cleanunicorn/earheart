// Settings → Advanced → Tools: configure local MCP servers, discover their
// tools, enable them and choose ask/allow/deny. Server names, tool names and
// descriptions are text from programs the user configured, so every one is set
// with textContent. Secret environment values are never sent back to this page:
// it only learns whether one is set.
(() => {
  const $ = (id) => document.getElementById(id);
  if (!$("tools-card")) return;
  let servers = [];
  let editing = null;
  const busy = new Set();

  const say = (text, bad = false) => {
    const s = $("tools-status");
    s.textContent = text;
    s.className = bad ? "status err" : "status";
  };
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "server";
  const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

  // One literal call site per channel (test/ipc-contract.test.js scans for them).
  const safe = async (fn) => { try { return await fn(); } catch (err) { return { ok: false, error: err.message }; } };
  const api = {
    list: () => safe(() => window.earheart.invoke("tools:list")),
    save: (server) => safe(() => window.earheart.invoke("tools:save-server", server)),
    remove: (id) => safe(() => window.earheart.invoke("tools:remove-server", id)),
    discover: (id) => safe(() => window.earheart.invoke("tools:discover", id)),
    policy: (req) => safe(() => window.earheart.invoke("tools:set-policy", req)),
  };
  const errText = (res) => res.error ?? (res.errors ?? []).join("; ") ?? "failed";

  function toolRow(server, tool) {
    const row = node("div", undefined, "row");
    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = tool.enabled;
    on.disabled = !tool.usable;
    on.setAttribute("aria-label", `Enable ${trunc(tool.name, 60)}`);
    const label = node("span", tool.name);
    label.title = trunc(tool.description || "", 300);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Policy for ${trunc(tool.name, 60)}`);
    for (const [value, text] of [["ask", "Ask each time"], ["allow", "Always allow"], ["deny", "Deny"]]) {
      const o = node("option", text);
      o.value = value;
      select.append(o);
    }
    select.value = tool.policy;
    select.disabled = !tool.usable;
    const push = async (patch) => {
      const res = await api.policy({ serverId: server.id, tool: tool.name, schemaHash: tool.schemaHash, ...patch });
      if (res.ok) { servers = res.servers; draw(); } else { say(errText(res), true); draw(); }
    };
    on.addEventListener("change", () => push({ enabled: on.checked }));
    select.addEventListener("change", () => push({ policy: select.value }));
    row.append(on, label, select);
    if (!tool.usable) row.append(node("span", `Unavailable: ${trunc(tool.problem ?? "unsupported schema", 120)}`, "hint"));
    return row;
  }

  function serverBlock(server) {
    const box = node("div", undefined, "field");
    const head = node("div", undefined, "row space-between");
    head.append(node("strong", trunc(server.name, 60)));
    const actions = node("span", undefined, "row");
    const mk = (text, fn) => { const b = node("button", text, "ghost"); b.type = "button"; b.addEventListener("click", fn); return b; };
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = server.enabled;
    enabled.setAttribute("aria-label", `Server ${trunc(server.name, 60)} enabled`);
    enabled.addEventListener("change", async () => {
      const res = await api.save(toForm(server, { enabled: enabled.checked }));
      if (res.ok) { servers = res.servers; say(""); } else say(errText(res), true);
      draw();
    });
    const discover = mk(busy.has(server.id) ? "Starting…" : "Discover tools", async () => {
      busy.add(server.id); say(`Starting ${trunc(server.name, 40)}…`); draw();
      const res = await api.discover(server.id);
      busy.delete(server.id);
      if (res.servers) servers = res.servers;
      say(res.ok ? "Discovered." : `Discovery failed: ${trunc(res.error ?? "error", 200)}`, !res.ok);
      draw();
    });
    discover.disabled = busy.has(server.id);
    actions.append(enabled, discover,
      mk("Edit", () => startEdit(server)),
      mk("Remove", async () => {
        if (!window.confirm(`Remove ${trunc(server.name, 60)} and its tool settings?`)) return;
        const res = await api.remove(server.id);
        if (res.ok) { servers = res.servers; say("Removed."); } else say(errText(res), true);
        draw();
      }));
    head.append(actions);
    box.append(head, node("p", trunc([server.command, ...server.args].join(" "), 200), "hint"));
    if (server.discoveryError) box.append(node("p", `Last discovery failed: ${server.discoveryError}`, "status err"));
    if (!server.discovered) box.append(node("p", "Not discovered yet. Press Discover tools to start this server and list its tools.", "hint"));
    else if (!server.tools.length && !server.discoveryError) box.append(node("p", "This server offers no tools.", "hint"));
    for (const t of server.tools) box.append(toolRow(server, t));
    return box;
  }

  function draw() {
    const list = $("tools-list");
    list.replaceChildren(...servers.map(serverBlock));
  }

  // --- add / edit form -------------------------------------------------------
  function envToText(env) {
    return Object.entries(env).map(([k, e]) => (e.secret ? `!${k}=` : `${k}=${e.value}`)).join("\n");
  }
  function parseEnv(text, previous) {
    const env = {};
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const secret = line.startsWith("!");
      const body = secret ? line.slice(1) : line;
      const eq = body.indexOf("=");
      if (eq < 1) throw new Error(`Environment line "${trunc(line, 30)}" needs KEY=value`);
      const key = body.slice(0, eq), value = body.slice(eq + 1);
      env[key] = secret
        ? (value === "" && previous?.[key]?.secret ? { secret: true, keep: true } : { secret: true, value })
        : { secret: false, value };
    }
    return env;
  }
  function toForm(server, patch = {}) {
    // Re-save an existing server unchanged except `patch`; secrets are kept in main.
    const env = Object.fromEntries(Object.entries(server.env).map(([k, e]) => [k, e.secret ? { secret: true, keep: true } : { secret: false, value: e.value }]));
    return { id: server.id, name: server.name, enabled: server.enabled, command: server.command, args: server.args, cwd: server.cwd, env, ...patch };
  }
  function startEdit(server) {
    editing = server;
    $("tools-name").value = server.name;
    $("tools-command").value = server.command;
    $("tools-args").value = server.args.join("\n");
    $("tools-cwd").value = server.cwd;
    $("tools-env").value = envToText(server.env);
    $("tools-save").textContent = "Save server";
    $("tools-cancel-edit").hidden = false;
    $("tools-name").focus();
  }
  function endEdit() {
    editing = null;
    for (const id of ["tools-name", "tools-command", "tools-args", "tools-cwd", "tools-env"]) $(id).value = "";
    $("tools-save").textContent = "Add server";
    $("tools-cancel-edit").hidden = true;
  }

  $("tools-cancel-edit").addEventListener("click", () => { endEdit(); say(""); });
  $("tools-save").addEventListener("click", async () => {
    let env;
    try { env = parseEnv($("tools-env").value, editing?.env); } catch (err) { say(err.message, true); return; }
    const name = $("tools-name").value.trim();
    const taken = new Set(servers.map((s) => s.id));
    let id = editing?.id ?? slug(name);
    for (let n = 2; !editing && taken.has(id); n++) id = `${slug(name).slice(0, 36)}-${n}`;
    const res = await api.save({
      id, name, enabled: editing?.enabled ?? false,
      command: $("tools-command").value,
      args: $("tools-args").value.split("\n").filter((l) => l !== ""),
      cwd: $("tools-cwd").value.trim(),
      env,
    });
    if (!res.ok) { say(errText(res), true); return; }
    servers = res.servers;
    const wasEditing = editing !== null;
    endEdit();
    say(wasEditing ? "Saved." : "Added. Press Discover tools to list its tools.");
    draw();
  });

  async function load() {
    const res = await api.list();
    if (!res.ok) { say(`Could not load tools: ${errText(res)}`, true); return; }
    servers = res.servers;
    $("tools-storage").textContent = res.secureStorage
      ? "Secret values are encrypted with your system's secure storage."
      : "Secret values are stored unencrypted in a private file: this system has no secure storage available.";
    draw();
  }
  load();
})();
