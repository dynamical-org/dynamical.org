---
type: "Lab note"
title: "Knowing the moment a forecast is ready"
date: 2026-07-07
areas:
  - weather-product-design
featured: 4
summary: >-
  Forecast files don't arrive all at once — they trickle in over minutes or
  hours, on a cadence set by whoever produces the model. To stop guessing, we
  built wxopticon: a tool that watches upstream weather sources and answers two
  operational questions — when to expect a given dataset, and whether a run is
  on time relative to how that feed actually behaves.
---

Forecast production is a factory assembly line, a fulfillment center, and a delivery route all in one. Lewis Fry Richardson's Weather Forecasting Factory was not too far off.

{% figure "/assets/notes/conlin-1.jpg" %}“Weather Forecasting Factory” by Stephen Conlin, 1986. Based on the description in Weather Prediction by Numerical Process, by L.F. Richardson, Cambridge University Press, 1922, and on advice from Prof. John Byrne, Trinity College Dublin. Image: ink and water colour, c. 50 x 38.5 cm. © Stephen Conlin 1986. All Rights Reserved ´. (Courtesy: Hendrik Hoffmann, School of Mathematics & Statistics, University College Dublin. <a href="https://www.emetsoc.org/resources/rff/">Source</a>){% endfigure %}

Every dataset in the dynamical.org catalog (so far) is downstream of a model run that
someone else produces on their own cadence. And the initialization is just the beginning (literally and philosophically). Then the files start landing, one by one, eventually
trickling in over tens of minutes (or even hours) rather than appearing all at once. If your
pipeline depends on that data, you have two bad options: pretend you can divine a cron schedule that will "always work," or poll blindly.

And to add to that, we had questions like:

- How often is GEFS full lead time completed "late"?
- What does "late" even mean? What is the spread of the min to the max latencies from init?
- What does the rollout of a forecast look like, file by file, minute by minute?
- How do different delivery routes (read: file destinations) impact latency?

These questions and many more we sought to understand deeply so that the dynamical.org catalog was resilient, low-latency, and designed with minute details about the upstream sources in mind. The prompt for actually sitting down and answering them was a [question Will Hobbs](https://www.linkedin.com/in/will-hobbs-93215023/) [posted on LinkedIn](https://www.linkedin.com/posts/will-hobbs-93215023_question-for-people-that-work-with-nwpaiwp-ugcPost-7449580009725267970-3FJU/) about NOAA model file availability. We needed something more definitive than trial-and-error guesses about the delay between model initialization and usable forecast files.

So, we built a tool called **wxopticon** to remove that guesswork (I pronounce it "waxopticon", and I say it in a slightly mischievous voice and picture Saruman reaching for the Palantir -- no not THAT Palantir. Oh never mind). It watches upstream weather
sources and dynamical.org's own catalog stores, and it answers two operational questions:

- **When can I expect lead-group X dataset Y?** — a next-run countdown learned from observed
  arrival history.
- **Is this run on time?** — per-init lifecycle and timing measured against the
  distribution of arrivals for that product, so "late" means late relative to
  how this feed usually behaves.

You can see all of this on the [pipeline status page](/status/pipeline/).

The second component is a system that enables consumers to create subscriptions
(via webhooks, Slack notifications, etc) to meaningful events (e.g. "notify me
when IFS ENS progress:f024 is complete" or "warn me when GEFS on AWS is still
in flight behind schedule").

## What "ready" actually means

wxopticon models each run's progress as a sequence of **readiness boundaries**.
Rather than a single "done" flag, a run crosses named milestones as its lead
hours become available:

| kind         | fires when                                                        |
|--------------|-------------------------------------------------------------------|
| `progress`   | every lead ≤ an intermediate lead-group horizon is available (e.g. `progress:f240`) |
| `complete`   | the full run is available — you don't need to know group names    |
| `in_flight`  | a still-running run is behind its learned schedule                |
| `advisory`   | the upstream agency opens or resolves a dissemination advisory    |

That table describes events, not run states. We initially mixed those concepts
together, which made it hard to say whether `delayed` meant "still running" or
"finished, but late." The current model has two orthogonal axes:

- **`status`** is lifecycle: `pending`, `in_flight`, `complete`, `failed`, or
  `unobserved`.
- **`timing`** is the judgement: `on_time` or `delayed`, when there is enough
  history to make one.

So a run can be `in_flight` and `delayed`, then finish `complete` and
`on_time`. That is not a contradiction. An intermediate lead group was behind
its own schedule, but the full run recovered before crossing the full-run
threshold. Conversely, a `complete` run can carry `timing: delayed`: the data
is ready, but later than its feed's learned norm.

## Landing on spreadf

I went back and forth on the correct threshold for "delayed." Our first pass
split the question in two: an in-flight run was delayed at p95 plus one minute,
while a completed run was judged against p99. Raw p95 was obviously too harsh:
by definition, it would flag roughly one ordinary run in twenty. But adding one
minute still hugged very consistent feeds too tightly, and p99 was a volatile
tail statistic answering a different question.

We replayed a year of arrivals and compared several buffers above p95:

- a fixed 30 minutes, which ignores whether a product normally takes two hours
  or twenty-six;
- ten percent of p50, which scales with typical latency but not with the
  distribution's actual width;
- `p95 + (p95 - p50)`, which adapts to dispersion but collapses back toward p95
  on a very tight feed.

The version that behaved sensibly across both tight and wide distributions was
the dispersion buffer with a floor:

`spreadf = p95 + max(p95 - p50, 15 minutes)`

Each product gets its own spreadf from a trailing 90-day window. Each lead
group gets one too. That last part is important: if GFS is still working toward
day 10 after its day-10 group would normally be ready, wxopticon can mark the
run `in_flight` and `delayed` before the full 16-day run reaches its later
deadline. The event names the lead group that triggered the warning.

The same spreadf rule now drives the dashboard, in-flight warnings, and the
completed run's timing. It is an anomaly detector, not an SLA. A dynamical.org
[SLA](/sla) is a fixed commitment; spreadf describes whether an upstream feed
is behaving unusually relative to itself.

## How it works, briefly

wxopticon is a set of stateless functions over a single append-only event log in
object storage. **The log is the source of truth**, and
everything else (the dashboard, status and timing, the readiness milestones) is a
pure replay of it.

A lean detection scan runs every two minutes: it replays the log to find the runs
still expected, probes their upstream locations, appends any new state
transitions, and fans each new milestone out to subscribers. A separate
summarize pass runs every five minutes to refresh the status feed and seed
"delayed" signals. For products with a notification stream (e.g. AWS SNS), a
continuous listener catches arrivals within seconds instead of waiting for the
next scan.

## What a year of arrivals actually looks like

Because every arrival is in the log, we can replay a whole year of it. Over the
last 365 days wxopticon recorded roughly **1.9 million file arrivals across
9,150 completed product-runs** of thirteen upstream feeds. After excluding
periods before comparable monitoring or infrastructure baselines, 8,604 of
those runs were judgeable by the current delay method.

**A run arrives over time.** The moment a run *starts* and the
moment it's *complete* can be hours apart, and the shape of that arrival looks
different for every model.

{% figure "/assets/notes/arrival-staircase.png", "Scatter plots for four models, each point a forecast file positioned by its forecast hour (vertical) against hours after init time (horizontal). GFS traces a long diagonal, HRRR a tight one, GEFS two slopes with a plateau, AIFS a near-vertical band." %}Every file found over the last year, by forecast hour and how long after init time it landed; the dark line is the per-lead median. GFS trickles its 16-day run in over about two hours; HRRR's 48 hours land in a tight climb between roughly 50 and 110 minutes; GEFS races out to day 16, pauses, then delivers its 35-day tail in a burst almost a day later; AIFS drops its entire 15-day run in a single ~1-hour window. (A few files with rewritten upstream timestamps are clipped from view.){% endfigure %}

This is why "ready" is a series of milestones; a short-range
consumer can start using GEFS the instant the early lead groups land, long before the full run completes.

**The feeds are punctualish!** Measured from init time to the last file of the run, the median completion runs about 1h47m for HRRR, 3h37m for DWD's ICON-EU, 5h15m for AIFS, 5h22m for GFS, and a full ~26h for GEFS's 35-day run.

{% figure "/assets/notes/time-to-complete.png", "A dumbbell chart ranking thirteen feeds by time from init to a complete run, from HRRR near two hours to GEFS 35-day near 26 hours, each showing median, 95th and 99th percentile." %}Time from init time to a complete run: median (filled) through the 95th to the 99th percentile (open circle). The striking part is how narrow most of these ranges are.{% endfigure %}

GFS completes within a 13-minute band from its median to its 99th percentile, run after run. Regularity is exactly what makes a learned next-run expectation meaningful. A "late" signal is useful because on-time is so consistent.

**When a run is slow, it's the rare exception.** The clearest case is ECMWF's
AIFS-ENS: its median run finishes in 5h57m, but its slowest one percent of runs
stretch toward twelve and a half hours. The value isn't the common run, which
is boringly regular; it's catching the handful each year that stall.

But a threshold-selection plot is not the same thing as what a user would have
heard in real time. The line in that plot is computed over the whole year;
production recomputes a rolling baseline every five minutes, and an apparent
crossing only becomes an `in_flight` event if a summarize tick sees the run
still unfinished. We replayed those actual rules.

Across the 8,604 judgeable product-runs, **102 finished delayed: 1.19%**. The
rate varied by product, from zero in the sample for NOAA's HRRR NOMADS feed to
3.92% for ECMWF AIFS-ENS. A reasonable expectation is therefore "about one
percent of product-runs," not a universal promise that every feed will produce
the same rate.

These are concrete product-runs, not unique model cycles. GFS on AWS and GFS
on NOMADS are two delivery artifacts of the same forecast and are counted
separately because a user can depend on either one.

Lead groups produced **46 observable early warnings**, or about 0.5% of runs:

- 20 (43.5%) persisted to a completed full-run delay;
- 26 (56.5%) recovered and completed on time;
- the median warning arrived 63 minutes before the run completed;
- for the warnings that persisted, the median lead over the full-run deadline
  was 57 minutes.

That is the contract I would want as a user: an `in_flight` event triggered by
a lead group is a useful warning, not a final verdict. Subscribe to
`complete_delayed` if you only want confirmed late completions. The payload is
still a normal `complete` event with `timing: delayed`;
`complete_delayed` is a subscription filter, not another event kind.

There is one subtle methodological consequence of using a live rolling
baseline. Once a run completes, its latency joins the sample used to judge it.
Of 111 completions that landed beyond the threshold calculated without that
just-completed run, nine moved back inside spreadf when their completion joined
the baseline. We report that movement explicitly in the
[analysis](https://github.com/dynamical-org/wxopticon/tree/main/analysis/outcomes)
rather than pretending the threshold is a fixed line.

**Did the lead groups detect official advisories early?** Not in the archive we
have. We found 24 product/run matches with an opening agency advisory. Four
also produced a lead-group warning, and those warnings followed the agency
post by roughly 2, 11, 96, and 196 minutes. That is too small a sample for a
broad conclusion, but it is enough to reject the claim that lead-group spreadf
was an earlier advisory detector in this period.

The two signals still complement each other. `in_flight` is our statistical
inference from arrivals; `advisory` is the agency's authoritative statement
that a dissemination problem exists. Plenty of anomalous runs have no public
notice, while an advisory can explain why a statistical warning fired.

One last thing the log settles: **how far the cloud copy lags.** Every NOAA model
is disseminated through both NOAA's NOMADS server and a range of cloud providers (S3, GCS, Azure, and others, via NOAA's
Open Data Dissemination program), and a consumer might read whichever it sees first (we, for example, blend our reads across sources in an attempt to optimize and roll with NOMADS rate limits).

For GFS, NOMADS is always first. Across roughly 75,000 files carrying the same
forecast hour, the S3 copy trailed NOMADS by a median of about a minute and a half
and never once led it — the cost of the extra ingest hop into the cloud. So the
earliest a run is actually obtainable is its NOMADS timestamp, and that's the
baseline wxopticon measures arrival against.

## Subscribing: signed webhooks

If you can expose an inbound HTTP endpoint, webhooks are the lowish-latency path:
seconds after arrival for NODD push products, at most one cycle for
everything else. wxopticon POSTs you a signed JSON body the moment a run crosses
a boundary you've subscribed to:

```json
{
  "event_id": "noaa-gfs/external-noaa-gfs-aws/2026-06-10T06:00Z/complete",
  "group_id": "noaa-gfs",
  "product_id": "external-noaa-gfs-aws",
  "product_label": "NOAA GFS forecast (AWS)",
  "init_time": "2026-06-10T06:00:00Z",
  "kind": "complete",
  "lead_group": "f384",
  "lead_group_label": "16d",
  "max_lead_hours": 384,
  "occurred_at": "2026-06-10T11:12:04Z",
  "latency_s": 18724.0,
  "timing": "on_time"
}
```

Every event carries a human-readable `product_label` (with the AWS/NOMADS source
badge baked in). `progress` and `complete` name the readiness horizon they
crossed. An `in_flight` warning carries the run deadline, elapsed time, and
completion percentage; when a lead group triggered it, the payload also names
that group and its earlier deadline. So a payload reads on its own without a
lookup table.

Every delivery is signed (`X-Wxopticon-Signature`), retried with backoff on
failure, and stable per boundary. Subscriptions are managed at
[status.dynamical.org/webhooks](https://status.dynamical.org/webhooks); access
is currently allowlisted, so [get in touch](mailto:feedback@dynamical.org) if
you'd like to try it. You can even attach a small sandboxed Python function that runs
against the just-arrived dataset and shapes the payload or filters out deliveries you don't want.

{% figure "/assets/notes/wxopticon-slack.png", "A Slack channel showing a wxopticon boundary notification delivered through an incoming webhook, with the run's product, init time, and the milestone it crossed." %}wxopticon also supports Slack-style incoming webhooks, so boundaries can land straight in a channel.{% endfigure %}

## Prefer polling? The status feed

Not every consumer can accept inbound requests. For those of you who hear the soft footfall of the IT team plodding imperceptibly, but threateningly, in the distance -- coming closer, ever closer at the mention of *webhooks*, wxopticon publishes the same
events as a single JSON file you fetch on your own schedule, with no subscription or auth:

**<https://assets.dynamical.org/wxopticon/feed.json>**

It's a product-keyed snapshot. Each product carries its most recent runs, and
every run nests the same discrete arrival events a webhook would deliver.
Active agency advisories sit in a top-level list because one incident can span
products or cycles; affected products carry references back to them.

```json
{
  "generated_at": "2026-06-10T09:45:00+00:00",
  "products": {
    "external-noaa-gfs-aws": {
      "label": "NOAA GFS (AWS)",
      "runs": [
        { "init_time": "2026-06-10T06:00:00+00:00", "status": "in_flight",
          "completion_pct": 0.62, "timing": "on_time",
          "events": [
            { "event_id": "noaa-gfs/external-noaa-gfs-aws/2026-06-10T06:00Z/progress/f240",
              "group_id": "noaa-gfs", "product_id": "external-noaa-gfs-aws",
              "product_label": "NOAA GFS forecast (AWS)",
              "kind": "progress", "lead_group": "f240", "lead_group_label": "10d",
              "occurred_at": "2026-06-10T09:41:03Z", "timing": "on_time" }
          ] }
      ]
    }
  },
  "advisories": []
}
```

The nested events are identical to what a webhook carries (minus the
subscription id), so the client logic is the same: select the products you care
about, and dedupe on `event_id` across polls. The file is refreshed each five-minute cycle and
served with `Cache-Control: max-age=5, stale-while-revalidate=10`, so feel free to slam it.

## Where to go from here

- Watch the pipeline live: [dynamical.org/status/pipeline](/status/pipeline/)
- Poll the feed: [assets.dynamical.org/wxopticon/feed.json](https://assets.dynamical.org/wxopticon/feed.json)
- Manage webhook subscriptions: [status.dynamical.org/webhooks](https://status.dynamical.org/webhooks)

We continue to tune how "delayed" is determined. wxopticon now also ingests,
archives, and cross-references official source advisories (an ECMWF
dissemination delay, for example) with our observations. Those records taught
us another useful lesson: an advisory overlay drawn against run initialization
times is good incident context, but detection-order claims require comparing
the actual wall-clock alarm and post timestamps.

wxopticon is a living, but experimental piece of our infrastructure. If there's a source you'd like us to watch, or a boundary you wish you could subscribe to, [let us know](mailto:feedback@dynamical.org).
