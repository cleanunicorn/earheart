const search = document.getElementById("search");
const results = document.getElementById("results");
const status = document.getElementById("status");
let items = [], selected = -1, generation = 0, executing = false;
function select(index) {
  selected = index;
  for (const [i, option] of [...results.querySelectorAll('[role="option"]')].entries()) {
    option.setAttribute("aria-selected", String(i === selected));
  }
  const active = document.getElementById(`option-${selected}`);
  if (active) { search.setAttribute("aria-activedescendant", active.id); active.scrollIntoView({ block: "nearest" }); }
  else search.removeAttribute("aria-activedescendant");
}
async function refresh() {
  const version = ++generation;
  const value = search.value;
  try {
    const response = await earheart.invoke("palette:query", value);
    if (version !== generation || executing) return;
    if (!response.ok) throw new Error(response.error);
    const old = items[selected];
    items = response.items;
    results.replaceChildren();
    let group;
    items.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        const heading = document.createElement("div");
        heading.className = "group"; heading.textContent = group;
        heading.setAttribute("role", "presentation"); results.append(heading);
      }
      const option = document.createElement("div");
      option.id = `option-${i}`; option.className = "option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-disabled", String(!!item.disabled));
      option.textContent = item.label;
      // Keep the combobox focused; a pointer selection must not blur-close it.
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => { select(i); activate(); });
      results.append(option);
    });
    const previous = items.findIndex(item => old && item.id === old.id && item.entryId === old.entryId && !item.disabled);
    select(previous >= 0 ? previous : items.findIndex(item => !item.disabled));
    status.textContent = response.notice;
  } catch (error) {
    if (version !== generation) return;
    items = []; results.replaceChildren(); select(-1); status.textContent = error.message;
  }
}
async function activate() {
  const item = items[selected];
  if (executing || !item || item.disabled) return;
  executing = true; ++generation;
  search.disabled = true;
  try {
    const response = await earheart.invoke("palette:execute", { id: item.id, entryId: item.entryId, query: search.value });
    if (!response.ok) throw new Error(response.error);
  } catch (error) {
    status.textContent = `${error.message} Close Commands and reopen to retry.`;
    document.getElementById("close").focus();
  }
}
async function close() { await earheart.invoke("palette:close"); }
document.getElementById("close").addEventListener("click", close);
search.addEventListener("input", () => { select(-1); refresh(); });
document.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (event.key === "Tab") {
    event.preventDefault();
    if (event.target === search || search.disabled) document.getElementById("close").focus();
    else search.focus();
    return;
  }
  if (event.key === "Escape") { event.preventDefault(); close(); return; }
  if (event.target !== search || executing) return;
  const eligible = items.map((item, i) => item.disabled ? -1 : i).filter(i => i >= 0);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    let at = eligible.indexOf(selected);
    if (event.key === "Home") at = 0;
    else if (event.key === "End") at = eligible.length - 1;
    else at = (at + (event.key === "ArrowDown" ? 1 : -1) + eligible.length) % eligible.length;
    select(eligible[at] ?? -1);
  } else if (event.key === "Enter") { event.preventDefault(); if (!event.repeat) activate(); }
});
search.focus();
refresh();
// Search is bounded and local; refresh saved dictations while open, including
// deletes made by another window. Generation guards discard older replies.
setInterval(() => { if (!executing && !document.hidden) refresh(); }, 1500);
