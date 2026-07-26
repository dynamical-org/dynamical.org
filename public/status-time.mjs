const TIME_MODE_KEY = "wxopticon:time-mode";

export function localZoneLabel(now = new Date()) {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
  })
    .formatToParts(now)
    .find(({ type }) => type === "timeZoneName")?.value;
  return zone ?? "LOC";
}

export function setupTimeToggle(toggle, onChange) {
  const localOption = toggle.querySelector('option[value="local"]');
  localOption.textContent = localZoneLabel();
  const local = localStorage.getItem(TIME_MODE_KEY) !== "utc";
  toggle.value = local ? "local" : "utc";
  toggle.addEventListener("change", () => {
    const nextLocal = toggle.value === "local";
    localStorage.setItem(TIME_MODE_KEY, nextLocal ? "local" : "utc");
    onChange(nextLocal);
  });
  return local;
}
