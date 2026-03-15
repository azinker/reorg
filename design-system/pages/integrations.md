# Integrations Page Design

> Overrides MASTER.md for the Integrations page.

## Purpose

Manage marketplace connections, API tokens, write locks, and connection health.

## Layout

- Integration cards in a grid (one per store)
- Each card: store name + logo/acronym, connection status, last sync, write lock toggle, configure button
- Master store indicator badge on the master integration card

## Visual Treatment

- Connection status: Connected (green dot), Disconnected (red dot), Needs Attention (amber dot)
- Write lock toggle: prominent switch, amber when locked, green when unlocked
- Master store badge: distinct visual treatment (e.g., crown icon or "Master" tag)
- Token/credentials area: masked by default, reveal on click, copy button
- Test Connection button per integration
