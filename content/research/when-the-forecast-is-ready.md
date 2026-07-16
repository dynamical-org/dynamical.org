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
- **Is this run on time?** — per-init status measured against the distribution of prior
  arrivals for that product, so "late" means late relative to how this feed
  usually behaves.

You can see all of this on the [pipeline status page](https://status.dynamical.org/pipeline).

The second component is a system that enables consumers to create subscriptions (via webhooks, Slack notifications, etc) to meaningful events (e.g. "notify me when IFS ENS progress:f024 is complete" or "notify me when GEFS on AWS is delayed").

## What "ready" actually means

wxopticon models each run's progress as a sequence of **readiness boundaries**.
Rather than a single "done" flag, a run crosses named milestones as its lead
hours become available:

| kind         | fires when                                                        |
|--------------|-------------------------------------------------------------------|
| `started`    | the first file of a run lands (any lead time)                     |
| `progress`   | every lead ≤ a lead-group horizon is available (e.g. `progress:f240`) |
| `complete`   | the full run is available — you don't need to know group names    |
| `delayed`    | the run is still in flight a minute past its expected completion time (p95 + margin) |

I went back and forth on the correct threshold for "delayed." Raw p95 turned out to be too harsh: for a very consistent feed the distribution is so tight that p95 sits only slightly above the median, so firing exactly at p95 would page on roughly 1 in 20 perfectly normal runs. So we nudge the trigger just past it — p95 + 1 minute — which keeps ordinary run-to-run variation quiet and lets only genuinely stalled runs cross the line. I still think it could be an area where further tweaks are needed. As we roll out our own [SLA](/sla), we will treat delayed for dynamical.org as a commitment rather than being driven by historical stats.

## How it works, briefly

wxopticon is a set of stateless functions over a single append-only event log in
object storage. **The log is the source of truth**, and
everything else (the dashboard, on-timedness, the readiness milestones) is a
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
last 365 days wxopticon recorded roughly **1.8 million file arrivals across about
8,700 runs** of thirteen upstream feeds.

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
stretch past 13 hours. The value isn't the common run, which is boringly regular; it's catching the handful each year that stall, and the four runs — out of roughly 8,700, a 99.95% completion rate — that never completed.

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
  "occurred_at": "2026-06-10T11:12:04Z"
}
```

Every event carries a human-readable `product_label` (with the AWS/NOMADS source
badge baked in), and `progress`/`complete`/`delayed` events add a `lead_group`
and `lead_group_label` naming the horizon they concern — so a payload reads on
its own without a lookup table.

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
every run nests the same discrete events a webhook would deliver:

```json
{
  "generated_at": "2026-06-10T09:45:00+00:00",
  "products": {
    "external-noaa-gfs-aws": {
      "label": "NOAA GFS (AWS)",
      "runs": [
        { "init_time": "2026-06-10T06:00:00+00:00", "status": "processing",
          "completion_pct": 0.62,
          "events": [
            { "event_id": "noaa-gfs/external-noaa-gfs-aws/2026-06-10T06:00Z/progress/f240",
              "group_id": "noaa-gfs", "product_id": "external-noaa-gfs-aws",
              "product_label": "NOAA GFS forecast (AWS)",
              "kind": "progress", "lead_group": "f240", "lead_group_label": "10d",
              "occurred_at": "2026-06-10T09:41:03Z" }
          ] }
      ]
    }
  }
}
```

The events are identical to what a webhook carries (minus the subscription id),
so the client logic is the same: select the products you care about, and dedupe
on `event_id` across polls. The file is refreshed each five-minute cycle and
served with `Cache-Control: max-age=5, stale-while-revalidate=10`, so feel free to slam it.

## Where to go from here

- Watch the pipeline live: [status.dynamical.org/pipeline](https://status.dynamical.org/pipeline)
- Poll the feed: [assets.dynamical.org/wxopticon/feed.json](https://assets.dynamical.org/wxopticon/feed.json)
- Manage webhook subscriptions: [status.dynamical.org/webhooks](https://status.dynamical.org/webhooks)

We continue to tune how "delayed" is determined, and are doing work to ingest, archive, and cross-reference source advisories (a dissemination delay from ECMWF, for example) with our observations.

wxopticon is a living, but experimental piece of our infrastructure. If there's a source you'd like us to watch, or a boundary you wish you could subscribe to, [let us know](mailto:feedback@dynamical.org).
