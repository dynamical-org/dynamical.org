// Copy-to-clipboard for .agent-prompt blocks (_includes/agent-prompt.njk, and
// the dataset ID row in content/catalog-pages.njk, whose text is a <code>
// rather than a textarea), plus catalog example footers. One delegated listener
// serves every block; includes emit this module and the browser evaluates it once.
const timers = new WeakMap();

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".agent-prompt button, .example-copy");
  if (!button) return;
  const example = button.closest(".codeTabPanel");
  const block = example || button.parentElement;
  const prompt = block.querySelector("textarea, code");
  const status = block.querySelector("[role=status]");
  // Highlighting can normalize whitespace. Keep the exact STAC source for copy.
  const text = example ? example.querySelector(".example-source").content.textContent : prompt.value ?? prompt.textContent;
  // Selecting first means the fallback below has something to copy, and
  // leaves the text visibly selected if even that is unavailable.
  if (prompt.select) prompt.select();
  else getSelection().selectAllChildren(prompt);
  let copied = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (example) {
      const source = document.createElement("textarea");
      source.value = text;
      source.style.cssText = "position:fixed;left:-9999px";
      document.body.append(source);
      source.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        source.remove();
        button.focus();
      }
      if (!copied) {
        if (prompt.select) prompt.select();
        else getSelection().selectAllChildren(prompt);
      }
    } else copied = document.execCommand("copy");
  }
  // Each attempt gets its own announcement and its own full display interval:
  // empty the live region, repopulate it after a frame so assistive tech sees
  // a change even when the text is the same, and restart this block's timer.
  // data-copy carries the same state to CSS, for blocks that show it
  // visually some other way (the dataset ID row).
  clearTimeout(timers.get(block));
  status.textContent = "";
  block.dataset.copy = copied ? "copied" : "failed";
  requestAnimationFrame(() => {
    status.textContent = copied ? "copied" : "select the text and copy it yourself";
  });
  timers.set(block, setTimeout(() => {
    status.textContent = "";
    delete block.dataset.copy;
  }, 2500));
  if (copied && (!example || block.dataset.prompt)) {
    window.track("agent_prompt_copied", { prompt: block.dataset.prompt, page: location.pathname });
  }
});
