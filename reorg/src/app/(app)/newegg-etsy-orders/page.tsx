import { requirePageAccess } from "@/lib/page-access";
import { MarketplaceOrdersClient } from "@/components/marketplace-orders/MarketplaceOrdersClient";

export const metadata = { title: "Newegg & Etsy Orders | reorG" };

export default async function NeweggEtsyOrdersPage() {
  await requirePageAccess("newegg-etsy-orders");
  return <MarketplaceOrdersClient />;
}
