# Import Guide

Use the Import feature to bulk-update internal data such as SKU, UPC, weight, supplier cost, supplier shipping cost, and notes without editing each row one by one.

## Step 1: Download The Template

1. Go to **Import** in the sidebar.
2. Click **Download template**.
3. Open the file in Excel, Google Sheets, or another spreadsheet tool.

## Step 2: Fill In Your Data

The template includes these supported columns:

| Column | Required | Description |
|--------|----------|-------------|
| `sku` | Yes | Used to match the import row to the correct product row in reorG |
| `upc` | No | Optional. Blank UPC cells are ignored. Filled UPC values are staged for review, not pushed live automatically |
| `weight` | No | Optional. Use reorG weight format |
| `supplier_cost` | No | Optional. Internal supplier cost used for profit calculations |
| `supplier_shipping_cost` | No | Optional. Internal supplier shipping cost used for profit calculations |
| `notes` | No | Optional. Internal free-text notes stored on the master row inside reorG |

Important rules:

- `sku` is the only required field.
- Blank optional cells are ignored.
- Blank optional cells do **not** delete existing values in the table.
- Only one row per SKU is allowed in each import file.

## Weight Format Rules

Use one of these formats:

- `1` through `16` for ounces
- `2LBS` through `10LBS` for pounds

Examples:

- `5` = 5 ounces
- `16` = 16 ounces
- `2LBS` = 2 pounds
- `5LBS` = 5 pounds

Invalid examples:

- `17`
- `1LBS`
- `11LBS`
- `5 oz`
- `2 lbs`

## Step 3: Upload The File

1. Save the file as **XLSX** or **CSV**.
2. On the Import page, choose the file.
3. Use the **Next** button to move to the validation step.

## Step 4: Preview And Validate

reorG parses the file and shows:

- how many rows are valid
- how many rows have errors
- which rows would be created, updated, or left unchanged in the selected mode

If rows fail:

- the page shows the SKU and the exact reason
- duplicate SKUs in the same file are flagged as errors
- you can download the failed rows as an editable `.xlsx` file

## Step 5: Choose Import Mode

| Mode | Behavior |
|------|----------|
| `Fill blanks only` | Updates only empty internal fields. Existing values stay in place. Blank optional cells are ignored |
| `Overwrite provided values only` | Updates only the fields you actually filled in. Blank optional cells are still ignored |

reorG updates the impact preview when you switch modes, so you can see what would happen before running the import.

## Step 6: Run The Import

1. Click **Run import**.
2. Wait for the result screen.
3. Review:
   - successful rows
   - failed rows
   - what changed for each SKU
   - why any row failed
4. If needed, download the failed rows workbook, fix it, and re-upload only those rows.

## What Happens With UPC Imports

- Imported UPCs are staged for review.
- Importing a UPC does not push it live automatically.
- If the UPC cell is blank in your file, reorG ignores it and leaves the current UPC alone.

## What The Notes Field Means

`notes` is an internal reorG field stored on the master row. It does not push to marketplaces.

## Quick Checklist

- [ ] Downloaded the template
- [ ] Filled in `sku` for every row
- [ ] Used valid weight format
- [ ] Kept only one row per SKU
- [ ] Saved as XLSX or CSV
- [ ] Checked the impact preview
- [ ] Reviewed any failed rows before re-uploading

## Troubleshooting

**"Invalid file type"**
Use XLSX or CSV.

**"SKU is required"**
Every row must have a SKU.

**"Duplicate SKU in import file"**
Keep only one row per SKU in each import.

**"Invalid weight format"**
Use `5` for 5 ounces or `2LBS` for 2 pounds.

**"No changes needed"**
The row matched an existing SKU, but the selected import mode did not need to update anything.
