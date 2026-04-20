/**
 * Template placeholder substitution. Runs client-side inside the Composer.
 * Supported placeholders (case-insensitive, double curly braces):
 *
 *   {{buyer_name}}        Friendly name (falls back to userId)
 *   {{buyer_username}}    Raw eBay user id
 *   {{first_name}}        First word of buyer_name
 *   {{order_number}}      eBay order number
 *   {{item_id}}           eBay listing id
 *   {{item_title}}        Listing title
 *   {{tracking_number}}   First tracking number for the related order (optional)
 *   {{store_name}}        Integration label (e.g. "TPP eBay")
 *
 * Unknown placeholders are left in place so the agent can spot them before send.
 */

export interface TemplateContext {
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
        return ctx.buyerName ?? ctx.buyerUserId ?? match;
      case "buyer_username":
        return ctx.buyerUserId ?? match;
      case "first_name": {
        const n = ctx.buyerName ?? ctx.buyerUserId ?? "";
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

export function findUnfilledPlaceholders(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) set.add(m[1].toLowerCase());
  return Array.from(set);
}
