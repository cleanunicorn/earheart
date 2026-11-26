// Sample only while the resource figures are on screen. Closing Settings or
// scrolling away leaves the tray app with no background monitoring work.
(() => {
  const card = document.getElementById("runtime-card");
  const unloadButton = document.getElementById("runtime-unload");
  const unloadStatus = document.getElementById("runtime-unload-status");
  let interval = null;
  let inView = false;
  let revision = 0;
  let unloading = false;
  let anyLoaded = false;

  const BACKENDS = { cuda: "CUDA", vulkan: "Vulkan", metal: "Metal" };

  function formatBytes(bytes) {
    const gib = bytes >= 1024 ** 3;
    const value = bytes / (gib ? 1024 ** 3 : 1024 ** 2);
    return value.toLocaleString(i18n.locale, { maximumFractionDigits: gib ? 2 : 0 }) + (gib ? " GiB" : " MiB");
  }

  function show(id, text, detail) {
    const main = document.getElementById(id);
    main.textContent = text;
    main.title = text;
    const node = document.getElementById(id + "-detail");
    node.textContent = detail || "";
    node.hidden = !detail;
  }

  // Speech always runs on the CPU, so its weights sit in its worker's RAM.
  function sttDetail(stats) {
    if (!stats.stt) return "";
    const kib = stats.sttMemoryKiB;
    return kib > 0 ? i18n.t("runtime.inRam", { size: formatBytes(kib * 1024) }) : i18n.t("runtime.inRamNoSize");
  }

  // Layers offloaded against the model's total is what says VRAM or RAM:
  // llama.cpp quietly falls back to the CPU when the GPU can't fit it.
  function cleanupDetail(stats) {
    if (!stats.cleanup) return "";
    const kib = stats.cleanupMemoryKiB;
    const place = stats.cleanupPlacement;
    if (place && place.backend && place.gpuLayers > 0) {
      const params = { backend: BACKENDS[place.backend] || place.backend, layers: place.gpuLayers, total: place.totalLayers };
      if (!(place.totalLayers > 0)) return i18n.t("runtime.onGpuNoTotal", params);
      return i18n.t(place.gpuLayers >= place.totalLayers ? "runtime.onGpu" : "runtime.onGpuPartly", params);
    }
    if (place) return kib > 0 ? i18n.t("runtime.inRam", { size: formatBytes(kib * 1024) }) : i18n.t("runtime.inRamNoSize");
    return kib > 0 ? i18n.t("runtime.workerRam", { size: formatBytes(kib * 1024) }) : "";
  }

  function gpuFigures(stats) {
    const gpu = stats.gpu;
    if (gpu && gpu.total > 0) {
      return [
        i18n.t("runtime.gpuUsed", { used: formatBytes(gpu.used), total: formatBytes(gpu.total) }),
        i18n.t(gpu.unified ? "runtime.gpuUnified" : "runtime.gpuWholeDevice"),
      ];
    }
    // A cleanup model that answered without a GPU backend is on the CPU.
    if (stats.cleanupPlacement && !stats.cleanupPlacement.backend) return [i18n.t("runtime.noGpu"), ""];
    return ["—", i18n.t("runtime.gpuUnknown")];
  }

  function syncUnload() {
    unloadButton.disabled = unloading || !anyLoaded;
  }

  async function refresh() {
    const ticket = ++revision;
    const stats = await earheart.invoke("usage:runtime").catch(() => null);
    if (ticket !== revision) return;
    const unavailable = i18n.t("runtime.unavailable");
    const kib = stats?.memoryKiB;
    document.getElementById("runtime-memory").textContent = kib > 0 ? formatBytes(kib * 1024) : unavailable;
    if (!stats) {
      show("runtime-stt", unavailable);
      show("runtime-cleanup", unavailable);
      show("runtime-gpu", unavailable);
    } else {
      show("runtime-stt", stats.stt || i18n.t("runtime.none"), sttDetail(stats));
      show("runtime-cleanup", stats.cleanup || i18n.t("runtime.none"), cleanupDetail(stats));
      show("runtime-gpu", ...gpuFigures(stats));
    }
    anyLoaded = !!(stats && (stats.stt || stats.cleanup));
    syncUnload();
  }

  unloadButton.addEventListener("click", async () => {
    unloading = true;
    syncUnload();
    unloadStatus.textContent = i18n.t("runtime.unloading");
    unloadStatus.hidden = false;
    const result = await earheart.invoke("usage:unload-models").catch(() => null);
    unloadStatus.textContent = i18n.t(
      result?.ok ? "runtime.unloaded"
        : result?.reason === "dictating" ? "runtime.unloadDictating"
        : result?.reason === "busy" ? "runtime.unloadBusy"
        : "runtime.unloadFailed"
    );
    unloading = false;
    await refresh();
  });

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
