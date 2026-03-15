# Shipping Rates Guide

reorG uses a shipping rate table to look up shipping cost based on product weight. This affects profit calculations. This guide explains how the table works and how to set it up.

---

## How It Works

1. Each product has a **weight** (stored in reorG’s format: e.g. `5` for 5 oz, `2LBS` for 2 lbs).
2. reorG converts that weight to ounces and looks up the matching row in the shipping rate table.
3. The **cost** in that row is the shipping cost used in profit calculations.
4. If there’s no match or no cost, profit may use a fallback (e.g. $0) or show a warning.

---

## Weight Keys in the Table

The table uses fixed **weight keys**. These are created when you seed the database:

| Range | Format | Examples |
|-------|--------|----------|
| 1–16 oz | `1oz`, `2oz`, … `16oz` | `5oz` = 5 ounces |
| 2–10 lbs | `2LBS`, `3LBS`, … `10LBS` | `2LBS` = 2 pounds |

Product weight is converted to ounces and matched to the closest key. For example:
- Product weight `5` (5 oz) → matches `5oz`
- Product weight `2LBS` (32 oz) → matches `2LBS`

---

## Populating the Table

1. Go to **Shipping Rates** in the sidebar
2. You’ll see a list of weight keys with a **cost** field for each
3. Enter the shipping cost (in dollars) for each weight tier
4. Save your changes

**Example:**
- `1oz` → $4.50
- `2oz` → $4.75
- …
- `16oz` → $7.00
- `2LBS` → $8.50
- `3LBS` → $9.50
- …

Use your actual carrier rates or a simplified tier structure.

---

## What Happens When Weight or Rate Is Missing

| Situation | Result |
|-----------|--------|
| Product has no weight | Shipping cost = $0 (or not calculated); profit may be incomplete |
| Product weight doesn’t match any key | reorG may use $0, the nearest tier, or show a warning — depends on implementation |
| Key exists but cost is empty | Same as above — no cost to apply |
| Weight format invalid (e.g. `17`, `11LBS`) | May not match; fix the weight in the product data |

**Best practice:** Set a cost for every weight key you use, and ensure all products have valid weights.

---

## Weight Format Reminder

Product weights in reorG use:
- `1`–`16` = ounces
- `2LBS`–`10LBS` = pounds

The shipping rate table keys (`1oz`, `2oz`, … `2LBS`, …) align with this. See `docs/import-guide.md` for full weight format rules.

---

## Profit Calculation

For each listing, profit is:

```
profit = salePrice
       - supplierCost
       - supplierShipping
       - shippingCost   ← from this table, based on weight
       - platformFee
       - adFee
```

Accurate shipping costs improve profit accuracy.
