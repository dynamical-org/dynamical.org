// CF time decoding and UTC labels. Pure.

const UNIT_MS = {
  microseconds: 1e-3,
  microsecond: 1e-3,
  us: 1e-3,
  milliseconds: 1,
  millisecond: 1,
  ms: 1,
  seconds: 1000,
  second: 1000,
  s: 1000,
  minutes: 60_000,
  minute: 60_000,
  min: 60_000,
  hours: 3_600_000,
  hour: 3_600_000,
  h: 3_600_000,
  days: 86_400_000,
  day: 86_400_000,
  d: 86_400_000,
};

/**
 * Parse CF units: "seconds since 1970-01-01" (a time) or "seconds" (a duration).
 * The reference date is read as UTC when no zone is given.
 * @param {string} units
 * @returns {{ unitMs: number, epochMs: number | null }}
 */
export function parseCfUnits(units) {
  const m = /^\s*(\w+)(?:\s+since\s+(.+?))?\s*$/.exec(String(units ?? ""));
  const unitMs = m ? UNIT_MS[m[1].toLowerCase()] : undefined;
  if (!m || unitMs === undefined) throw new Error(`Unsupported CF time units "${units}"`);
  if (!m[2]) return { unitMs, epochMs: null };
  let ref = m[2].trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) ref += "T00:00:00";
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(ref)) ref += "Z";
  const epochMs = Date.parse(ref);
  if (Number.isNaN(epochMs)) throw new Error(`Unparseable CF reference date in "${units}"`);
  return { unitMs, epochMs };
}

/**
 * Decode a CF time or duration coordinate to milliseconds (since the Unix epoch
 * for times). BigInt values (int64 coordinates) are accepted.
 * @param {ArrayLike<number | bigint>} values
 * @param {string} units
 * @returns {number[]}
 */
export function decodeCf(values, units) {
  const { unitMs, epochMs } = parseCfUnits(units);
  const base = epochMs ?? 0;
  return Array.from(values, (v) => base + Number(v) * unitMs);
}

const pad = (n) => String(n).padStart(2, "0");

/** "2026-09-25 12:00 UTC" */
export function formatUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "+48 h", "+1.5 h"; lead times are always shown in hours. */
export function formatLead(ms) {
  const h = ms / 3_600_000;
  return `+${Number.isInteger(h) ? h : h.toFixed(2).replace(/0+$/, "")} h`;
}
