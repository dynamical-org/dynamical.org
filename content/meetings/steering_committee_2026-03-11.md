---
title: Steering Committee Meeting, Q1 2026
date: 2026-03-11
---

## {{title}}
**Date:** March 11, 2026

**Members present:**
- Jacob Zwart
- Joe Hamman
- Jack Kelly
- Stephan Hoyer
- Alden Keefe Sampson

---

## Latency and sustainability

The committee discussed reducing the time between weather model output becoming available and updates reaching our datasets. Work included fetching directly from upstream sources with fallbacks and identifying opportunities to parallelize updates.

Members explored how users who need timely data and support could help sustain the shared infrastructure. One approach discussed was paid support for niche low-latency data products, while continuing to adhere to a free and open policy. The discussion emphasized keeping the open-data commitment clear as these options develop.

## Compression

We reviewed a compression audit and the trade-offs between smaller datasets, preserving useful precision and compatibility with users' tools. The discussion covered bit rounding, Zstandard and alternative codecs, with compatibility and the value of further efficiency gains guiding future evaluation.

## Dataset changes

The committee discussed documenting which dataset changes users should expect, including new variables, metadata corrections and extensions to the historical archive. Members recommended clear guidance on changes and transitions, noting that even an additive change can affect an existing workflow. Breaking changes need explicit communication and a managed transition.

## Governance

We discussed new steering committee membership and evolving its focus from technical to governance, with an emphasis on long-term stewardship and sustainability. Members were invited to suggest perspectives that would strengthen the committee.
