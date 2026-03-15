# Errors Page Design

> Overrides MASTER.md for the Errors page.

## Purpose

Friendly error summaries explaining what failed, why, and how to fix it.
Technical details available behind a toggle for debugging.

## Layout

- Error list sorted by most recent
- Each error card shows: timestamp, plain-English summary, affected store, severity badge
- Expandable technical detail section per error
- Filter by: store, severity, time range, resolved/unresolved

## Visual Treatment

- Severity badges: Critical (red), Warning (amber), Info (blue)
- Plain-English first: "Sync failed for TPP eBay — rate limit exceeded. Will retry in 15 minutes."
- Technical toggle shows: error code, raw message, stack trace excerpt, request/response data
- Resolved errors: muted styling with strikethrough timestamp
