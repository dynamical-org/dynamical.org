# wxopticon history scrub slider

Add a scrub slider to `/status/` that lets users rewind through historical
wxopticon snapshots without changing how the dashboard renders.

## Backend contract (already shipped)

All three live under the same `wxopticon/` R2 prefix and inherit CORS.

| URL | Purpose | Cache |
|---|---|---|
| `wxopticon/summary.json` | "now" payload (unchanged) | `max-age=15, s-w-r=60` |
| `wxopticon/history/index.json` | newest-first array of URL-safe ISO timestamps (`YYYY-MM-DDTHH-MM-SSZ`), up to 2016 entries | `max-age=15, s-w-r=60` |
| `wxopticon/history/{ts}.json` | full summary snapshot, byte-for-byte identical schema to live | `max-age=31536000, immutable` |

Gaps in `index.json` are implicit — the index only lists snapshots that
actually exist. The slider must snap to index entries so the user can't
land in a gap.

## Core design principle

**The render code must not know whether it's drawing live or historical
data.** Current `hydrate(summary)` already takes a full payload and
renders — the refactor is mostly about *removing* live-only side effects
from the render path:

- `updateBanners()` reads `lastFetchError` → lift to outer shell.
- `updateCountdowns()` ticks against wall clock → only starts in live mode.
- `setInterval(tick, 15s)` poll loop → only runs in live mode.

After refactor:

- `renderSnapshot(summary)` — pure: paints products + `generated_at`.
- Outer shell owns: banners, countdown timer, poll timer, ribbon, mode switch.
- Live mode calls `renderSnapshot(liveSummary)` on each poll.
- History mode calls `renderSnapshot(historicalSummary)` on each debounced
  slider settle.

## UX

1. **Toggle button** next to the existing UTC/local `<select>` at the top
   of the dashboard. Clock/rewind glyph, collapsed by default.
2. **On open:** fetch `history/index.json` once, show a range slider
   below the toggle. `0 → oldest`, `max → newest`. Default value is
   newest (so open-and-release is a visual no-op).
3. **Floating label** centered above the slider thumb, updates on `input`
   (not `change`). Format: `Apr 15, 12:30 PM` in the user's current time
   mode (respects UTC/local toggle).
4. **Debounce fetch** 200ms on slider input. Label updates immediately.
   In-flight fetches are sequenced so a late response can't overwrite a
   newer one.
5. **Do not flash a loading state** while fetching. Previous view stays
   until the new payload arrives.
6. **On fetch failure,** inline notice near the slider ("snapshot
   unavailable"), previous view stays.
7. **Historical indicator:** ribbon at top of `#wx-app` when scrubbed
   off-live: `Viewing history: Apr 15, 12:30 PM` + "Return to live" button.
   Escape key also returns to live.
8. **Return to live:** re-fetch `summary.json`, resume poll + countdowns,
   hide ribbon.

## Accessibility

- `<input type="range">` with `aria-label="History scrub"` and
  `aria-valuetext` set to the localized timestamp on each input.
- Arrow keys → ±1 snapshot (native).
- PageUp/PageDown → ±10 snapshots.
- Shift+Arrow → ±10 snapshots (intercept keydown, call `stepBy`).
- Escape → return to live.

## Out of scope for v1

- Autoplay replay.
- Diff/compare two snapshots.
- URL fragment deep-linking.
- Tick marks showing gap distribution (nice, not required).

## Build sequence

1. [x] Commit existing wxopticon visual WIP on main.
2. [x] Branch `wxopticon-history-scrub`, draft PR, plan file committed.
3. [ ] **Refactor** `public/wxopticon.js`:
       - extract `renderSnapshot(summary)` (pure — products +
         generated_at only).
       - lift banner/countdown/poll ownership into an outer shell.
       - introduce `mode` state: `"live"` vs `"scrub"`.
       - verify: live mode still works unchanged on dev server.
4. [ ] **Template** `content/wxopticon.njk`:
       - add history toggle button and collapsible container (slider,
         floating label, inline error slot) next to the time `<select>`.
       - add ribbon slot at top of `#wx-app`.
       - verify: page builds, default rendering unchanged while toggle
         is closed.
5. [ ] **CSS** `public/main.css`:
       - style toggle, slider, floating label, ribbon, "snapshot
         unavailable" notice.
       - respect existing color tokens (light + dark).
       - verify: screenshot on /status/.
6. [ ] **Wire scrub logic** in `public/wxopticon.js`:
       - on toggle-open: fetch index (once per session), populate slider,
         attach listeners.
       - on `input`: update label + aria-valuetext immediately, schedule
         debounced fetch with sequence number.
       - on debounced fire: fetch `history/{ts}.json`, call
         `renderSnapshot(json)`, skip if sequence stale, surface error
         inline on failure.
       - on `setMode('scrub')`: stopPolling(), stop countdown timer,
         show ribbon.
       - on `setMode('live')`: re-tick, startPolling(), hide ribbon.
       - Escape key handler in history mode.
7. [ ] **Verification** (Playwright):
       - Live mode unchanged → screenshot.
       - Open toggle → slider appears, label shows newest.
       - Mock `history/index.json` + `history/{ts}.json` via
         `browser_evaluate` fetch-interceptor (backend not live yet).
       - Drag slider → label updates live, view changes after pause.
       - Arrow keys step one, Shift-arrow steps ten.
       - Escape returns to live.
       - Network panel: debounced, not one-per-pixel.

## Verification strategy note

The history backend (`wxopticon/history/*`) is not yet deployed at the
time of this PR. End-to-end scrub verification uses a Playwright
fetch-interceptor that synthesizes a history index + snapshots from the
live summary so the frontend code path is fully exercised. Live mode is
verified against the real, deployed `summary.json`.
