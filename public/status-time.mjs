const TIME_MODE_KEY = "wxopticon:time-mode";

export function localTimeLabel(now = new Date()) {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
  })
    .formatToParts(now)
    .find(({ type }) => type === "timeZoneName")?.value;
  return zone ? `Local time (${zone})` : "Local time";
}

export function setupTimeToggle(toggle, onChange) {
  const localOption = toggle.querySelector('option[value="local"]');
  localOption.textContent = localTimeLabel();
  const local = localStorage.getItem(TIME_MODE_KEY) !== "utc";
  toggle.value = local ? "local" : "utc";
  toggle.addEventListener("change", () => {
    const nextLocal = toggle.value === "local";
    localStorage.setItem(TIME_MODE_KEY, nextLocal ? "local" : "utc");
    onChange(nextLocal);
  });
  return local;
}
