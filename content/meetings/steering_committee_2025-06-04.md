---
title: Steering Committee Meeting, Q2 2025
date: 2025-06-04
---

## {{title}}
**Date:** June 4, 2025  

**Members present:**  
- Jacob Zwart  
- Joe Hamman  
- Jack Kelly  
- Alden Keefe Sampson  

---

## Dataset Usage Statistics

Usage has been growing steadily in recent months from over **10M requests/month in March** to almost **40M in May**. Roughly **45TB of data** was served in May.  
- **GFS and GEFS analysis datasets** see the most requests.  
- **Temperature, wind, and precipitation** are by far the most accessed variables.  
- Usage is global, with the **majority coming from North America and Europe**.

---

## AWS Open Data Program Acceptance

dynamical.org was **accepted into AWS’s Open Data Program**, which provides:  
- **Cost-free S3 storage and hosting** for a significant portion of dynamical’s datasets  
- Support duration of **at least two years**  

This will serve as a bridge to **publish more datasets** as dynamical secures fiscal support.

---

## Data Proxy Considerations

Discussion focused on the current `data.dynamical.org` proxy:  
### Benefits:
- Allows switching to **lowest cost/most available storage** with **no user impact**  
- Enables **usage analytics**

### Downsides:
- May not scale well with growing usage

A potential improvement:  
- Metadata requests go to `data.dynamical.org`  
- **Heavy data requests** go **directly to cloud object storage**  
- This approach will be enabled via **Icechunk**

---

## External Contributor Strategy

Key considerations for managing external contributors:  
- QA/QC process will require close involvement from dynamical.org engineers at first  
- Introduce **controls and staging areas** to manage contributions  
- Begin with a **small-scale experiment** (trusted contributor + single dataset — in progress)  
- Use **automated quality checks** to compare new datasets against existing ones

---

## Evaluating Icechunk

Icechunk is a new format built on Zarr. Committee discussed whether dynamical should adopt it.  
### Benefits:
- Ensures datasets being **read from and written to simultaneously** remain correct  
- Avoids edge cases and operational issues in current Zarr workarounds

### Transition Plan:
- Maintain continuity by **publishing in both formats temporarily**  
- Begin with **double-write tests**