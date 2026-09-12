// Copy-to-clipboard for .agent-prompt blocks (_includes/agent-prompt.njk).
// One delegated listener serves every prompt on the page; the include emits
// this module once per prompt and the browser evaluates it once.
const timers = new WeakMap();

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".agent-prompt button");
  if (!button) return;
  const block = button.parentElement;
  const prompt = block.querySelector("textarea");
  const status = block.querySelector("[role=status]");
  // Selecting first means the fallback below has something to copy, and
  // leaves the text visibly selected if even that is unavailable.
  prompt.select();
  let copied = true;
  try {
    await navigator.clipboard.writeText(prompt.value);
  } catch {
    copied = document.execCommand("copy");
  }
  // Each attempt gets its own announcement and its own full display interval:
  // empty the live region, repopulate it after a frame so assistive tech sees
  // a change even when the text is the same, and restart this block's timer.
  clearTimeout(timers.get(block));
  status.textContent = "";
  requestAnimationFrame(() => {
    status.textContent = copied ? "copied" : "select the text and copy it yourself";
  });
  timers.set(block, setTimeout(() => { status.textContent = ""; }, 2500));
  if (copied) {
    window.track("agent_prompt_copied", { prompt: block.dataset.prompt, page: location.pathname });
  }
});
