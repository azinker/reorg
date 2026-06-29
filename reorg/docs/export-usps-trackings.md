# Export USPS Trackings from Label PDF

Use this when you have a **batch USPS label PDF** (one label per page) and need an Excel file with **Order Number** and **Tracking Number** for each page.

## What to say

Tell the agent:

- **EXPORT ME USPS TRACKINGS**
- Or provide the PDF path directly: *"Export USPS trackings from `<path-to-labels.pdf>`"*

If you only say the phrase without a path, the agent should ask for the `.pdf` file location.

## Input

- A multi-page PDF where **each page is one USPS postage label**
- Text must be **selectable** (not a scanned image-only PDF)
- Typical source: DTS / label batch exports under `DTS LB BATCHES\Completed\`

Example input:

`C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\DTS LB BATCHES\Completed\LABELS_1.pdf`

## Output

Written **next to the input PDF** (same directory):

| File | Contents |
|------|----------|
| `<pdf-stem>_trackings.xlsx` | Column A = Order Number, Column B = Tracking Number (one row per page) |

Example: `LABELS_1.pdf` → `LABELS_1_trackings.xlsx`

## What gets extracted

### Order number (line under recipient name)

Four formats, always in the same position on the label:

| Format | Example |
|--------|---------|
| eBay | `20-14806-83116` |
| Long marketplace | `112-2757629-1768209` |
| Hash prefix | `#35001` |
| Plain numeric | `4643810` |

### Tracking number

From the line after `USPS TRACKING #`, spaced form:

`9400 1502 0624 1037 6384 50`

Stored in Excel **without spaces**:

`9400150206241037638450`

## How the agent runs it

From `reorg/`:

```powershell
python scripts/export-usps-label-trackings.py "C:\path\to\LABELS_1.pdf"
```

Optional custom output path:

```powershell
python scripts/export-usps-label-trackings.py "C:\path\to\LABELS_1.pdf" --output "C:\path\to\custom.xlsx"
```

**Requirements:** Python 3 with `PyMuPDF` (`fitz`) and `openpyxl` installed.

The script runs **two extraction passes** per page (plain text + text blocks) and flags mismatches. It also validates that every tracking number is exactly **22 digits**.

## Agent checklist

1. Confirm the PDF path exists.
2. Run the script.
3. Report: pages extracted, issue count (must be **0** for a clean run), order-format breakdown.
4. Spot-check pages the user named (e.g. page 1, 42, 171, 173) if this is a first run on a new batch.
5. Give the full output `.xlsx` path.

If `issues` is non-zero, **do not** treat the export as complete — inspect failing pages and fix the parser or PDF before delivering.

## Read-only

This workflow **reads** a local PDF and writes a local Excel file. It does not touch eBay, the reorG database, or any marketplace.
