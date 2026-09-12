// Copy-to-clipboard for .agent-prompt blocks (_includes/agent-prompt.njk).
// One delegated listener serves every prompt on the page; the include emits
// this module once per prompt and the browser evaluates it once.
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
  status.textContent = copied ? "copied" : "select the text and copy it yourself";
  setTimeout(() => { status.textContent = ""; }, 2500);
  window.track("agent_prompt_copied", { prompt: block.dataset.prompt, page: location.pathname });
});
