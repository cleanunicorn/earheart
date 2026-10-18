// Decimal labels shared by the wizard and Settings. Unknown is not zero.
const ModelProgress = (() => {
  const bytes = (n) => !Number.isFinite(n) ? "size unknown" : n >= 1e9 ? (Math.max(0, n) / 1e9).toFixed(1) + " GB" : (Math.max(0, n) / 1e6).toFixed(0) + " MB";
  const fraction = ({ received = 0, total }) => Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, received / total)) : 0;
  const label = (p) => Number.isFinite(p.total) && p.total > 0 ? Math.round(fraction(p) * 100) + "% · " + bytes(Math.max(0, Math.min(p.received || 0, p.total))) + " / " + bytes(p.total) : bytes(p.received || 0) + " received · total unknown";
  return { bytes, fraction, label };
})();
if (typeof module !== "undefined") module.exports = ModelProgress;
