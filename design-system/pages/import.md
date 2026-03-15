# Import Page Design

> Overrides MASTER.md for the Import page.

## Purpose

Import starter data and ongoing internal updates from workbook templates.
Guided wizard with validation and preview before commit.

## Layout

- Step wizard: 1. Download Template → 2. Upload File → 3. Preview & Validate → 4. Choose Overwrite Mode → 5. Confirm Import
- Clear step indicator at top
- Each step occupies the main content area

## Visual Treatment

- Template download: prominent download button with file format badges (XLSX)
- Upload: drag-and-drop zone with file type indicators
- Validation: green checks for valid rows, amber warnings, red errors with row numbers
- Downloadable error report button
- Overwrite mode selector: radio cards explaining each mode clearly
- Final confirmation: summary of what will be imported/changed
