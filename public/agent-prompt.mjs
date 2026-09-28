// Copy-to-clipboard for .agent-prompt blocks (_includes/agent-prompt.njk, and
// the dataset ID row in content/catalog-pages.njk, whose text is a <code>
// rather than a textarea). One delegated listener serves every block on the
// page; each include emits this module and the browser evaluates it once.
const timers = new WeakMap();

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".agent-prompt button");
  if (!button) return;
  const block = button.parentElement;
  const prompt = block.querySelector("textarea, code");
  const status = block.querySelector("[role=status]");
  // Selecting first means the fallback below has something to copy, and
  // leaves the text visibly selected if even that is unavailable.
  if (prompt.select) prompt.select();
  else getSelection().selectAllChildren(prompt);
  let copied = true;
  try {
    await navigator.clipboard.writeText(prompt.value ?? prompt.textContent);
  } catch {
    copied = document.execCommand("copy");
  }
  // Each attempt gets its own announcement and its own full display interval:
  // empty the live region, repopulate it after a frame so assistive tech sees
  // a change even when the text is the same, and restart this block's timer.
  // data-copied carries the same state to CSS, for blocks that show it as an
  // icon (the dataset ID row).
  clearTimeout(timers.get(block));
  status.textContent = "";
  block.toggleAttribute("data-copied", copied);
  requestAnimationFrame(() => {
    status.textContent = copied ? "copied" : "select the text and copy it yourself";
  });
  timers.set(block, setTimeout(() => {
    status.textContent = "";
    block.removeAttribute("data-copied");
  }, 2500));
  if (copied) {
    window.track("agent_prompt_copied", { prompt: block.dataset.prompt, page: location.pathname });
  }
});
