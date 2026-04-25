/**
 * Template placeholder substitution. Runs client-side inside the Composer.
 * Supported placeholders (case-insensitive, double curly braces):
 *
 *   {{buyer_name}}        Checkout/delivery name (falls back to buyer name/userId)
 *   {{buyer_username}}    Raw eBay user id
 *   {{first_name}}        First word of the checkout/delivery name
 *   {{order_number}}      eBay order number
 *   {{item_id}}           eBay listing id
 *   {{item_title}}        Listing title
 *   {{tracking_number}}   First tracking number for the related order (optional)
 *   {{store_name}}        Integration label (e.g. "TPP eBay")
 *
 * Unknown placeholders are left in place so the agent can spot them before send.
 */

export interface TemplateContext {
  deliveryName?: string | null;
  buyerName?: string | null;
  buyerUserId?: string | null;
  ebayItemId?: string | null;
  ebayItemTitle?: string | null;
  ebayOrderNumber?: string | null;
  trackingNumber?: string | null;
  storeName?: string | null;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export function fillTemplate(body: string, ctx: TemplateContext): string {
  return body.replace(PLACEHOLDER_RE, (match, key: string) => {
    const k = key.toLowerCase();
    switch (k) {
      case "buyer_name":
        return bestBuyerName(ctx) ?? ctx.buyerUserId ?? match;
      case "buyer_username":
        return ctx.buyerUserId ?? match;
      case "first_name": {
        const n = bestBuyerName(ctx) ?? "";
        const first = n.split(/\s+/)[0];
        return first || match;
      }
      case "order_number":
        return ctx.ebayOrderNumber ?? match;
      case "item_id":
        return ctx.ebayItemId ?? match;
      case "item_title":
        return ctx.ebayItemTitle ?? match;
      case "tracking_number":
        return ctx.trackingNumber ?? match;
      case "store_name":
        return ctx.storeName ?? match;
      default:
        return match;
    }
  });
}

function bestBuyerName(ctx: TemplateContext): string | null {
  const delivery = cleanHumanName(ctx.deliveryName, ctx.buyerUserId);
  if (delivery) return delivery;
  return cleanHumanName(ctx.buyerName, ctx.buyerUserId);
}

function cleanHumanName(value: string | null | undefined, username?: string | null): string | null {
  const clean = value?.trim();
  if (!clean) return null;
  if (username && clean.toLowerCase() === username.trim().toLowerCase()) return null;
  return clean;
}

export function findUnfilledPlaceholders(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) set.add(m[1].toLowerCase());
  return Array.from(set);
}
