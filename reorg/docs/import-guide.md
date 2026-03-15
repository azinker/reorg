# Import Guide

Use the Import feature to bulk-update internal data (SKU, weight, supplier cost, notes, etc.) without editing each row by hand. This guide explains how to prepare your file, upload it, and choose how it updates existing data.

---

## Step 1: Download the Template

1. Go to **Import** in the sidebar
2. Click **Download Template**
3. Open the file in Excel, Google Sheets, or another spreadsheet tool

---

## Step 2: Fill In Your Data

The template has columns for the data reorG uses. Fill in the ones you need:

| Column | Required | Description |
|--------|----------|-------------|
| **sku** | Yes | Product SKU. Must match exactly an existing listing in the master store, or a new row will be created |
| **weight** | No | Weight in reorG format (see below) |
| **supplier_cost** | No | Supplier cost per unit (number) |
| **supplier_shipping_cost** | No | Supplier shipping cost per unit (number) |
| **notes** | No | Free-text notes |

**Important:** SKU must be present. All other columns are optional.

---

## Weight Format Rules

reorG uses a specific format for weight. Use one of these:

### Ounces (1–16 oz)

- Use a number from **1** to **16**
- Examples: `5` = 5 oz, `12` = 12 oz
- reorG may display these as `5oz`, `12oz` in the UI

### Pounds (2–10 lbs)

- Use the format **2LBS** through **10LBS** (no space, uppercase optional)
- Examples: `2LBS` = 2 pounds, `5LBS` = 5 pounds, `10LBS` = 10 pounds
- Do not use `1LBS` — use `16` for 1 pound (16 oz)

### Valid Examples

| Input | Meaning |
|-------|---------|
| `5` | 5 ounces |
| `16` | 16 ounces (1 pound) |
| `2LBS` | 2 pounds |
| `5LBS` | 5 pounds |
| `10LBS` | 10 pounds |

### Invalid Examples

| Input | Why Invalid |
|-------|-------------|
| `17` | Ounces must be 1–16 |
| `1LBS` | Use `16` for 1 pound |
| `11LBS` | Pounds must be 2–10 |
| `5 oz` | No spaces in pound format; for ounces use `5` |
| `2 lbs` | Use `2LBS` (no space) |

---

## Step 3: Upload the File

1. Save your spreadsheet as **XLSX** or **CSV**
2. On the Import page, click **Choose File** or drag the file into the upload area
3. Click **Upload** (or equivalent)

---

## Step 4: Preview

1. reorG will parse the file and show a preview
2. Check:
   - **Valid rows** — how many rows passed validation
   - **Error rows** — how many had problems (missing SKU, bad weight, etc.)
3. If there are errors, download the error report, fix those rows, and upload again

---

## Step 5: Choose Overwrite Mode

When you confirm the import, you choose how it updates existing data:

| Mode | Behavior |
|------|----------|
| **Fill blanks only** | Updates only empty fields. Existing values are not changed. |
| **Overwrite all** | Replaces all imported fields, even if they already have values. |

**Recommendation:** Use **Fill blanks** for first imports or when adding data. Use **Overwrite all** when you’ve intentionally prepared a full refresh.

---

## Step 6: Confirm

1. Review the preview again
2. Click **Confirm Import**
3. Wait for the import to finish
4. Check the Dashboard to verify the data

---

## Quick Checklist

- [ ] Downloaded the template
- [ ] SKU column filled for every row
- [ ] Weight format correct (1–16 for oz, 2LBS–10LBS for lbs)
- [ ] Numeric columns use numbers, not text
- [ ] File saved as XLSX or CSV
- [ ] Chose Fill blanks or Overwrite
- [ ] Confirmed import

---

## Troubleshooting

**"Invalid file type"**  
Use XLSX or CSV. Avoid older formats like XLS.

**"SKU required"**  
Every row must have a value in the SKU column.

**"Invalid weight format"**  
Check the weight rules. Use `5` for 5 oz, `2LBS` for 2 lbs.

**"Row skipped" or "No match"**  
SKU must match exactly. No fuzzy matching. Check for extra spaces or typos.
