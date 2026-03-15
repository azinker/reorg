# Engine Room Page Design

> Overrides MASTER.md for the Engine Room operations control center.

## Purpose

Military-style operations center. Shows sync jobs, push queue, audit trail,
change logs — all presented cleanly for non-engineer operators.

## Layout

- Top summary cards (active syncs, queued pushes, recent errors, write lock status)
- Tabbed sections: Sync Jobs | Push Queue | Change Log | Raw Events
- Each section has its own filtered table/list view

## Visual Treatment

- Status indicators: colored dots (green=healthy, amber=warning, red=error)
- Timestamps in relative format ("2m ago") with absolute on hover
- Plain-English summaries first, technical detail behind toggle
- Raw API payloads in collapsible code blocks (monospace, dark background)
- Activity feed with user avatars/initials and action descriptions

## Density

- Compact density recommended for this page (lots of data)
- Scrollable sections with independent scroll containers
