---
title: Steering Committee Meeting, Q3 2025
date: 2025-09-03
---

## {{title}}
**Date:** September 3, 2025  

**Members present:**  
- Joe Hamman  
- Jack Kelly  
- Stephan Hoyer
- Alden Keefe Sampson  

---

Our September steering committee meeting focused on dataset format and metadata conventions. 

## Dataset format 

Zarr is a fantastic format for gridded weather data. But updating a Zarr dataset while others are reading from it at the same time is hard to do exactly right. Icechunk is a storage engine for Zarr that addresses this issue, among other benefits. Steering committee members weighed adopting Icechunk for dynamical datasets and decided on the following plan: Dynamical will start offering Icechunk versions of our datasets alongside standard Zarr datasets to gather feedback and iron out issues [We reached this point as of Dec 2025]. When we’re confident the user experience using our Icechunk datasets is equal or better than our existing Zarrs we will start publishing new datasets solely in Icechunk. Following significant heads up through our newsletter we will cease updating existing Zarr datasets and eventually remove them. We believe this change will set our datasets up well for the long-term from a user experience, correctness and performance perspective.

## Metadata conventions 

The more consistent and interoperable our datasets are the better. Adopting CF Conventions in our datasets was the unanimous suggestion of steering committee members and is now a priority for our dataset development. We discussed how AI coding tools can help expedite this process and the cf_xarray library can help validate conformance.