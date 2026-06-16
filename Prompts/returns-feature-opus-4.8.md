# Prompt for Opus 4.8: reorG eBay Return Cases in Help Desk

You are working in the `reorg` codebase for The Perfect Part internal marketplace operations app.

Production domain: `https://reorg.theperfectpart.net`

You must read and obey `AGENTS.md` before making changes. The safety rules in `AGENTS.md` override every feature request. This task involves potential marketplace writes, so treat safety as the main product requirement, not as an implementation detail.

## Objective

Build an eBay Return Cases feature inside the existing Help Desk.

The feature lives under:

- Main list: `/help-desk/returns`
- Return detail/action page: `/help-desk/returns/[returnId]`

It must support both eBay stores:

- TPP eBay
- TT eBay

Return cases for both stores should appear together in one screen with a store badge and store filter.

The UI should match the information, columns, flows, and mental model of eBay Seller Hub's Manage Returns area, but styled as a polished reorG dark operational dashboard. Make it better than eBay where useful: clearer status badges, store badges, last-sync freshness, action availability, deadlines, linked order/ticket context, and audit visibility.

Reference screenshots are located here:

`C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG\Returns Screenshots`

Use them as the primary UI/flow reference:

- `screenshot1.png` through `screenshot4.png`: Manage Returns list view.
- `screenshot2.png`: status dropdown labels.
- `screenshot5.png` through `screenshot10.png`: new/non-actioned return, provide/upload/confirm label flows.
- `screenshot11.png` through `screenshot14.png`: approved/in-transit return, mark received, tracking modal, refund confirmation.
- `screenshot15.png` through `screenshot17.png`: delivered/awaiting-refund flow with deduction up to 50%, required reason/comment.
- `screenshot18.png` through `screenshot20.png`: closed return outcomes, buyer-closed return, partial refund accepted, full refund closed.

## Mandatory Safety Rules

Do not implement any delete path. No delete endpoints, no delete UI, no delete code paths.

The returns sync must be pull-only. It must never write to eBay.

No marketplace write may happen automatically. No cron, sync job, page load, status refresh, or delivered-tracking detection may trigger a write.

All live return actions must pass through this chain:

1. Admin-only authorization.
2. Global marketplace write lock check, if one exists.
3. Per-integration write lock check for the target store.
4. Returns-specific temporary live-write toggle check.
5. Environment check. Local/staging must be blocked unless explicitly allowed by an admin setting intended for this feature.
6. Latest return detail re-fetch from eBay.
7. Server-side validation that the action is currently available from eBay's return detail or sellerAvailableOptions.
8. Dry-run/preview step that performs no eBay write and shows the exact payload/action summary.
9. Explicit user confirmation after preview.
10. Single live eBay write call.
11. Full audit logging before and after the write, including blocked attempts.
12. Targeted live refresh from eBay after the write.

The temporary lock must default to OFF/LOCKED. The UI label should avoid ambiguity, for example:

- `Live Return Writes: OFF`
- `LOCKED - no eBay return actions can be sent`
- `Live Return Writes: ON`

When OFF, action buttons may be shown but must be disabled with a clear "Read-only mode / live return writes are locked" explanation.

Even when the returns live-write toggle is ON, do not bypass the existing `Integration.writeLocked` safety. TPP and TT must be independently gated. If TT is currently considered read-only by existing code/config, preserve that unless an Admin explicitly unlocks TT in the integration/write-lock settings.

No secrets in client code, logs, API responses, screenshots, fixtures, or git history.

## Current Codebase Starting Points

Inspect these first:

- `reorg/prisma/schema.prisma`
- `reorg/src/app/(app)/help-desk/HelpDeskClient.tsx`
- `reorg/src/components/helpdesk/FolderSidebar.tsx`
- `reorg/src/hooks/use-helpdesk.ts`
- `reorg/src/lib/services/helpdesk-ebay.ts`
- `reorg/src/lib/services/helpdesk-ebay-sync.ts`
- `reorg/src/lib/helpdesk/flags.ts`
- `reorg/src/app/(app)/help-desk/global-settings/page.tsx`
- Existing `/api/helpdesk/**` route patterns.
- Existing integration/write lock handling around `Integration.writeLocked`.

There is already a `HelpdeskCase` model/comment area for read-only eBay cases. Decide whether to extend it or add richer dedicated return models. Do not force returns into message tickets. Keep returns separate, but link to buyer/order/helpdesk ticket when possible.

## eBay API Research Requirement

Before coding, verify current official eBay documentation. Prefer official eBay developer docs only.

Known starting points:

- Post-Order Handling Returns guide: `https://developer.ebay.com/api-docs/user-guides/static/post-order-user-guide/post-order-returns.html`
- Post-Order API index: `https://developer.ebay.com/devzone/post-order/index.html`
- Search Returns: `GET /post-order/v2/return/search`
- Get Return: `GET /post-order/v2/return/{returnId}`
- Return states: `ReturnStateEnum`
- Return status/count filters: `ReturnCountFilterEnum`
- Seller available actions: `ActivityOptionEnum`
- Process Return Request: `POST /post-order/v2/return/{returnId}/decide`
- Upload Return File: `POST /post-order/v2/return/{returnId}/file/upload`
- Add Shipping Label Info: `POST /post-order/v2/return/{returnId}/add_shipping_label`
- Get Shipment Tracking Info: `GET /post-order/v2/return/{returnId}/tracking`
- Mark Return Received: `POST /post-order/v2/return/{returnId}/mark_as_received`
- Issue Return Refund: `POST /post-order/v2/return/{returnId}/issue_refund`
- Return files: `GET /post-order/v2/return/{returnId}/files`
- Label actions: `LabelActionEnum`
- Carriers: `ShippingCarrierEnum`

Important: the old eBay Return Management API is not recommended. Use Post-Order Return APIs unless current official docs say otherwise.

Several Post-Order return calls are not supported in eBay Sandbox. Use production read-only data for list/detail smoke testing. Do not perform live writes during tests.

If any live-write endpoint semantics are ambiguous, block that action in the UI and document why. Do not guess on writes.

## User Decisions Already Made

Implement live write actions now, but behind locks and confirmations.

Use a temporary lock/toggle so Admin can turn live production return writes ON/OFF.

TPP and TT returns appear together, with store badges and a store filter.

Default date range: Last 90 days.

Visual match: use eBay's information/flows, styled in reorG dark UI, with improvements.

Clicking a return case opens its own page: `/help-desk/returns/[returnId]`.

Read-only action state: show eBay-like actions, but disabled with explanation when live writes are locked.

Status filters: replicate the eBay dropdown labels from screenshot2 as closely as possible.

Partial refund writes should be fully implemented where eBay says they are available.

Return shipping label flows should be fully implemented where eBay says they are available.

Tracking modal should use eBay return tracking data when available and mimic screenshot12.

Data freshness: use local DB for the list, and refresh from eBay when opening details/action pages. The display should be as accurate and current as checking eBay directly.

Smoke testing uses production eBay read-only API data only.

Counts/badges: show a Return Cases badge count for cases needing attention in the Help Desk left pane.

Permissions: Admin users only for the first version.

Keep returns separate from Help Desk message tickets, but link to buyer/order/ticket where possible.

Include detailed write implementation now.

## UI Requirements

Add a `Return Cases` option under the Agent Folders area of the Help Desk left pane. It should be visually separated from the folder tree with a divider/line break so it is clearly not part of normal agent folders.

Show one option:

- `Return Cases`

Show a badge count for returns needing attention.

List page `/help-desk/returns`:

- Combined TPP + TT list.
- Store filter: All, TPP, TT.
- Default status: `Open returns/replacements`.
- Default period: `Last 90 days`.
- Search by Return ID, Order ID, buyer username, title/SKU if available.
- Sort default: date requested descending, matching eBay.
- Columns should cover eBay's Manage Returns view:
  - Action
  - Items, with thumbnail, title, quantity, and listing/order links where safe
  - Store badge
  - Status
  - Response/refund deadline
  - Details, including Return ID, requested date, reason
  - Refund/request amount
  - Buyer
  - Freshness/last synced
- Replicate status filter labels from screenshot2 where possible:
  - Open returns - needs attention
  - Open returns/replacements
  - Open replacements
  - Open returns
  - Returns in progress
  - Returns shipped
  - Returns delivered
  - Closed returns/replacements
- Map those labels to eBay `return_state`/`states` filters using official docs. If eBay does not expose an exact equivalent, map conservatively and document it.

Detail/action page `/help-desk/returns/[returnId]`:

- Re-fetch latest eBay detail on load with `cache: no-store` behavior.
- Show eBay-like progress line: Started, Shipped/Delivered, Refund/Closed as applicable.
- Right rail should show thumbnail, title, order number, return ID, request amount, return reason, buyer, date purchased, store, last refreshed, and linked local ticket/order if available.
- `Return details` must show buyer-entered return details/comments/photos/files when present.
- Show a timeline/history from eBay response history/activity history.
- Show sellerAvailableOptions/buyerAvailableOptions in an Admin debug/advanced panel.
- Show raw eBay response only in an Admin-only debug disclosure, never by default.

## Required Return Flows

### New/non-actioned return

Mimic screenshot5 through screenshot10.

Actions:

- Provide an eBay label.
- Upload a label.
- Confirm you sent a label.
- Send refund / partial refund if eBay says it is currently available.

Provide an eBay label:

- Verify current eBay docs for the exact flow.
- eBay docs reference `add_shipping_label` and may reference an initiate label step. Do not guess if unclear.
- If safely supported, implement through the official Post-Order flow.
- Show carrier, tracking, cost/label URL/label ID returned by eBay.
- eBay charges seller for eBay labels, so preview must clearly say this is a live paid action.

Upload a label:

- Accept `.pdf` return label upload, and image formats only if eBay supports them.
- Carrier selector must use eBay-supported carrier enum values, including at least USPS, UPS, FedEx, DHL, and Other if supported.
- Tracking number field is required. Add best-effort PDF tracking extraction only if feasible with existing dependencies; manual input must always be available.
- Use `file/upload` to upload the label, then `add_shipping_label` with the returned file ID and `UPLOAD_LABEL` or current official equivalent.
- Preview must show file name, carrier, tracking number, store, buyer, return ID.

Confirm you sent a label:

- Carrier selector.
- Tracking number.
- Radio/checkbox for "I sent a return shipping label with the original item."
- Use `add_shipping_label` with `MARK_AS_SENT` / `forwardShippingLabelProvided` or current official equivalent.

### Approved/in transit back to us

Mimic screenshot11 through screenshot14.

Actions:

- Mark as received.
- Track package modal.
- Start refund.

Track package:

- Use `GET /post-order/v2/return/{returnId}/tracking` with the return carrier/tracking values from return detail.
- Show tracking status and scan history with date/time/location/status, similar to screenshot12.

Mark as received:

- Use `POST /post-order/v2/return/{returnId}/mark_as_received`.
- Require preview and explicit confirmation.
- After success, refresh return detail from eBay.

Start refund:

- Optional photo upload of received item if eBay supports refund-related file upload. Do not make it required.
- Step 1: collect optional photo/comments.
- Step 2: confirmation page showing exact refund amount before sending.
- Use `issue_refund` only after validating the action is available and amount matches eBay estimate/rules.

### Delivered and awaiting refund

Mimic screenshot15 through screenshot17.

Actions:

- Track package modal.
- Start refund.

Deduction support:

- Because seller offers free returns, when a return is delivered and eBay allows deductions, UI must allow amount or percent deduction up to 50%.
- Deduction reason is required if deduction > 0.
- Comment is required if deduction > 0.
- Show computed total refund with/without deduction.
- Server must validate max 50%, required reason/comment, and no negative/refund-over-original amounts.
- Verify how eBay's Post-Order API expects seller deduction/refund details. If the API only supports itemized refund amounts/comments and not structured deduction reasons, store the internal deduction reason in the audit log and include the seller comment to eBay only if permitted by docs.
- Do not send refund until final confirmation.

### Closed returns

Mimic screenshot18 through screenshot20.

Support display for:

- Buyer closed return.
- Buyer accepted partial refund.
- Full refund after returned item.
- Partial refund history and outcome.
- Closed reason, closed date, refund details, files/photos, and eBay activity history.

Closed returns are display-only unless eBay explicitly exposes a sellerAvailableOption. Do not add speculative actions.

## Partial Refund Requirements

Implement partial refund capability only when eBay indicates it is available for that return.

Research and distinguish:

- Seller partial refund offer to resolve a new/open return, likely through `decide`.
- Refund with deduction after delivered item, likely through `issue_refund`.
- Existing partial refund accepted/declined/failed/initiated states in return history.

Do not present a live partial refund button unless the latest return detail says it is available.

All partial refund/deduction actions require:

- Admin.
- Live Return Writes ON.
- Integration/store write unlock.
- Latest eBay detail refresh.
- Dry-run/preview.
- Explicit confirmation.
- Audit log.
- Targeted refresh.

## Backend/Data Requirements

Use a hybrid freshness strategy:

- Background/manual sync pulls returns into local DB for list performance and counts.
- Detail page refreshes directly from eBay before rendering action state.
- After every live action, refresh the specific return from eBay and update local DB.

Create or extend service layer files. Route handlers must not perform raw Prisma writes or direct eBay calls when service functions should own the behavior.

Suggested new service/module shape, adjust to repo conventions:

- `src/lib/services/helpdesk-ebay-returns.ts`
- `src/lib/services/helpdesk-ebay-returns-sync.ts`
- `src/lib/helpdesk/returns.ts`
- `src/app/api/helpdesk/returns/route.ts`
- `src/app/api/helpdesk/returns/[returnId]/route.ts`
- `src/app/api/helpdesk/returns/[returnId]/refresh/route.ts`
- `src/app/api/helpdesk/returns/[returnId]/tracking/route.ts`
- `src/app/api/helpdesk/returns/[returnId]/actions/*`
- `src/app/api/helpdesk/returns/settings/route.ts`

Potential Prisma models, adapt after inspecting existing schema:

- `HelpdeskReturnCase`
- `HelpdeskReturnFile`
- `HelpdeskReturnTrackingEvent`
- `HelpdeskReturnActionAttempt`
- `HelpdeskReturnSyncCheckpoint`
- `HelpdeskReturnSettings` or reuse existing global settings pattern.

Store eBay raw responses in JSON for traceability, but expose only normalized fields to the client by default.

Use `integrationId + returnId` uniqueness.

Link to `HelpdeskTicket` when possible by eBay order number and buyer username. Do not create a message ticket for every return by default.

## eBay Client Requirements

Reuse existing eBay credential/token handling if possible. Existing tokens may need additional Post-Order scopes. If scope/token support is missing, show an Admin-facing setup error and document required scopes; do not leak token values.

Implement REST Post-Order calls with:

- access token refresh
- timeout
- typed request/response wrappers
- error normalization
- eBay request ID capture if returned
- network transfer sampling consistent with existing helpdesk calls
- audit logging for all writes and blocked attempts

## API/Validation Requirements

All API routes:

- Require Auth.js session.
- Require Admin for returns feature v1.
- Use Zod validation for params/body/query.
- Return typed JSON errors.
- Never swallow errors silently.
- Use service functions for DB writes and eBay calls.

Write routes must have separate preview and commit behavior. Commit must require a server-generated preview/action token or equivalent idempotency key so the submitted confirmation matches the previewed payload.

Prevent duplicate live writes on double-click/retry. Use idempotency/action attempt records where practical.

## UI Safety and UX Requirements

When live writes are locked:

- Show all relevant eBay-like actions in disabled state.
- Explain which lock is blocking them: returns live-write toggle, integration write lock, global write lock, environment lock, missing token/scope, or unavailable eBay seller option.

When live writes are enabled:

- Still show a preview confirmation screen/modal before live commit.
- The final confirmation should require a clear intentional action. Prefer typed confirmation for paid/irreversible actions:
  - eBay label purchase
  - refund
  - partial refund/deduction
  - mark received
- Never perform action on first click.

Use Lucide icons, not emojis.

All clickable elements must use `cursor-pointer`.

No layout-shifting hover effects.

Text must fit on mobile/desktop.

Do not build a landing page. Build the actual operational screen.

## Acceptance Criteria

1. Help Desk sidebar shows `Return Cases` below Agent Folders, separated by a visual divider, with needs-attention count.
2. `/help-desk/returns` lists TPP and TT returns together, with store filter, status filter, last 90 days default, search, sort, and eBay-equivalent columns.
3. `/help-desk/returns/[returnId]` opens a dedicated detail/action page and refreshes latest eBay return detail.
4. New return label flows are implemented where eBay sellerAvailableOptions/docs allow them, otherwise safely disabled with explanation.
5. Tracking modal uses eBay return tracking API.
6. Mark as received is implemented behind all locks, preview, confirmation, audit, and refresh.
7. Refund, partial refund, and deduction flows are implemented behind all locks, preview, confirmation, audit, and refresh where eBay allows them.
8. Closed return outcomes display correctly.
9. Sync is pull-only and never performs writes.
10. No delete paths exist.
11. Tests cover pure status/filter/action-availability mapping, safety gating, amount/deduction validation, and sync upsert behavior.
12. Admin-only access enforced server-side and client-side.
13. Production smoke test can use read-only production eBay data with live writes OFF.
14. Build/lint/tests pass, or any failures are documented with exact reason.

## Verification

Run the repo's existing validation commands after inspecting `package.json`. At minimum, try:

- Prisma validation/generate as appropriate.
- Unit tests for new helpers.
- Lint/typecheck/build if available.

Start the dev server and visually verify:

- `/help-desk`
- `/help-desk/returns`
- `/help-desk/returns/[returnId]` with a real synced return if available
- mobile and desktop viewports
- console errors
- disabled/live-lock states

Do not perform any live eBay writes during verification unless Adam explicitly turns on the toggle and confirms a specific action outside this prompt.

## If You Need More Information

Do not use a questionnaire UI.

Ask typed questions in chat. Make them multiple choice, give a recommended answer, and include a short example so Adam understands the tradeoff.

If blocked by eBay docs ambiguity around a live write action, ask before implementing that specific action live. Implement the rest safely.
