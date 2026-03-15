# Cursor IDE Setup for reorG

This guide explains how to set up the reorG project in Cursor for development and AI-assisted coding.

---

## Step 1: Open the Workspace

1. Open **Cursor** (cursor.com)
2. Go to **File** → **Open Folder**
3. Select the **reorg** folder (the project root, where `package.json` and `prisma` live)
4. Cursor will load the workspace and index the codebase

---

## Step 2: Project Structure for AI

Cursor uses these to provide accurate help:

- **AGENTS.md** — In the project root. Contains rules, conventions, data model, and safety constraints. Read this first for context.

- **.cursor/rules/** — Cursor rules (e.g. `reorg-safety.mdc`, `reorg-integrations.mdc`) that apply to all edits.

- **Design system** — `design-system/MASTER.md` and `design-system/pages/*.md` define UI/UX. Use them for visual and layout decisions.

---

## Step 3: Skills

### UI/UX Pro Max Skill

The **UI/UX Pro Max** skill is used for design decisions. If it’s installed, use it when:

- Creating or updating UI components
- Making layout or styling changes
- Aligning with the design system

The skill lives at `.cursor/skills/ui-ux-pro-max/SKILL.md`. Cursor will use it when relevant.

---

## Step 4: When to Use Plan Mode

Use **Plan Mode** (or equivalent planning feature) when:

- Changing architecture
- Adding or refactoring integrations
- Modifying the data model (Prisma schema)
- Changing sync or push flows

This helps keep changes consistent and avoids breaking existing behavior.

---

## Step 5: When to Use High Effort

Use **high effort** (or “thorough” mode) for:

- **Schema changes** — Prisma migrations, new tables, new fields
- **Integration work** — eBay, BigCommerce, Shopify adapter changes
- **Write safety** — Any code that might push to marketplaces
- **Sync logic** — Matching, upserts, StagedChange handling

These areas have strict rules; extra review reduces mistakes.

---

## Step 6: Quick Reference

| Task | Suggested Approach |
|------|---------------------|
| Fix a bug | Normal mode, reference relevant files |
| Add a UI component | Use UI/UX Pro Max skill, follow design system |
| Change Prisma schema | Plan Mode + high effort |
| Modify integration adapter | Plan Mode + high effort |
| Update write safety logic | Plan Mode + high effort, re-read AGENTS.md |
| Add documentation | Normal mode, follow existing docs style |

---

## Important Files to Know

- `AGENTS.md` — Project rules and conventions
- `.cursor/rules/*.mdc` — Safety and integration rules
- `prisma/schema.prisma` — Database schema
- `src/lib/integrations/types.ts` — Integration interface
- `src/lib/safety.ts` — Write safety checks
- `src/lib/services/sync.ts` — Sync logic (pull-only)
- `src/lib/services/push.ts` — Push logic (with dry-run)

---

## Safety Reminders

Before editing:

1. Sync must stay **pull-only** — never add push logic to sync
2. No **delete** functionality for marketplace listings
3. All pushes need **explicit user confirmation**
4. Staged values must **survive sync** — never overwrite StagedChange in sync
