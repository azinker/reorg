# Settings Page Design

> Overrides MASTER.md for the Settings page.

## Purpose

Application preferences and safety controls for Admin users.

## Layout

- Grouped sections: Display, Safety, Advanced
- Display: theme toggle, density selector, timezone picker, frozen columns toggle, search bar preference
- Safety: global write lock toggle, environment indicator
- Advanced: master store change (extreme caution UI)

## Visual Treatment

- Toggle switches for boolean settings
- Dropdown/select for timezone, density
- Master store section: warning card with red border, requires typing "I agree" + confirmation button
- Write lock toggle: prominent, with clear on/off label and amber when locked
