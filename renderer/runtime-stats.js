// Sample only while the resource figures are on screen. Closing Settings or
// scrolling away leaves the tray app with no background monitoring work.
(() => {
  const card = document.getElementById("runtime-card");
  let interval = null;
  let inView = false;
  let revision = 0;

  async function refresh() {
    const ticket = ++revision;
    const stats = await earheart.invoke("usage:runtime").catch(() => null);
    if (ticket !== revision) return;
    const unavailable = i18n.t("runtime.unavailable");
    const kib = stats?.memoryKiB;
    const gib = kib >= 1024 ** 2;
    const memory = kib / (gib ? 1024 ** 2 : 1024);
    document.getElementById("runtime-memory").textContent = kib > 0
      ? memory.toLocaleString(i18n.locale, { maximumFractionDigits: gib ? 2 : 0 }) + (gib ? " GiB" : " MiB")
      : unavailable;
    for (const kind of ["stt", "cleanup"]) {
      document.getElementById("runtime-" + kind).textContent =
        stats ? stats[kind] || i18n.t("runtime.none") : unavailable;
    }
  }

  function sync() {
    if (inView && !document.hidden) {
      if (interval !== null) return;
      refresh();
      interval = setInterval(refresh, 5000);
    } else {
      clearInterval(interval);
      interval = null;
      revision++;
    }
  }

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    sync();
  }).observe(card);
  document.addEventListener("visibilitychange", sync);
  i18n.onChange(() => { if (interval !== null) refresh(); });
})();
