// The tool-approval prompt. Everything shown came from a program the user
// configured but did not write, so it is rendered with textContent only.
// Deny has the initial focus; Allow stays disabled for a moment after a new
// request appears, so a keystroke meant for another app cannot approve it.
(() => {
  const $ = (id) => document.getElementById(id);
  const ALLOW_DELAY_MS = 600;
  let current = null;
  let tick = null;
  let busy = false;

  function render(request) {
    if (current && request?.id === current.id) return; // a queue change, not a new request
    clearInterval(tick);
    current = request && typeof request.id === "string" ? request : null;
    $("empty").hidden = Boolean(current);
    $("request").hidden = !current;
    $("allow").disabled = true;
    $("deny").disabled = !current;
    $("status").textContent = "";
    if (!current) return;
    $("server").textContent = String(current.server ?? "");
    $("tool").textContent = String(current.tool ?? "");
    $("description").textContent = String(current.description ?? "");
    $("args").textContent = String(current.args ?? "");
    $("deny").focus();
    const shownId = current.id;
    setTimeout(() => { if (current?.id === shownId && !busy) $("allow").disabled = false; }, ALLOW_DELAY_MS);
    const update = () => {
      const left = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
      $("countdown").textContent = `Expires in ${left}s. Approving applies to this one call only.`;
    };
    update();
    tick = setInterval(update, 1000);
  }

  async function decide(decision) {
    if (!current || busy) return;
    busy = true;
    $("allow").disabled = true;
    $("deny").disabled = true;
    try {
      const res = await window.earheart.invoke("approval:decide", { id: current.id, decision });
      if (!res?.ok) $("status").textContent = "That request is no longer pending.";
    } catch (err) {
      $("status").textContent = `Could not send the decision: ${err.message}`;
    } finally {
      busy = false;
    }
    // main pushes the next request (or closes this window) on its own.
  }

  $("deny").addEventListener("click", () => decide("deny"));
  $("allow").addEventListener("click", () => decide("allow"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") decide("deny"); });

  window.earheart.on("approval:request", render);
  window.earheart.invoke("approval:get").then(render).catch(() => render(null));
})();
