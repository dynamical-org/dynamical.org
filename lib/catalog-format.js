function abbreviateDuration(value) {
  const duration = value == null ? "" : String(value);
  const withExplicitCadence = duration.replace(
    /\bevery\s+(hour|minute)\b/gi,
    (_match, unit) => `every 1${unit.toLowerCase() === "hour" ? "h" : "m"}`,
  );

  return withExplicitCadence.replace(
    /(\d+(?:\.\d+)?)\s+(hours?|minutes?)\b/gi,
    (_match, amount, unit) =>
      `${Number(amount)}${unit.toLowerCase().startsWith("hour") ? "h" : "m"}`,
  );
}

module.exports = { abbreviateDuration };
