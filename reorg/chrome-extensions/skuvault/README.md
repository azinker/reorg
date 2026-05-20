# SKUVAULT Quick Adjust

Small Chrome popup for authenticated reorG users to quickly adjust SkuVault inventory.

## What it does

- Looks up the current on-hand quantity for a SKU.
- Adds quantity to warehouse `WH3`, location `12126`, reason `Add`.
- Removes quantity from warehouse `WH3`, location `12126`, reason `Remove`.
- Shows stock in green when on-hand quantity is above 5 and red when it is 5 or below.

## Install

1. Download the ZIP from `https://reorg.theperfectpart.net/chrome-extension`.
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click Load unpacked and select the extracted folder that contains `manifest.json`.
6. Pin SKUVAULT Quick Adjust.

## Requirements

- Stay logged into reorG in Chrome.
- reorG production must have `SKUVAULT_USERNAME` and `SKUVAULT_PASSWORD` configured.
- SkuVault credentials are used only by reorG server routes; they are not included in this extension.
