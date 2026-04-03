import { Truck } from "lucide-react";
import { ShipOrdersPanel } from "@/components/ship-orders/ShipOrdersPanel";

export const metadata = { title: "Ship Orders | reorG" };

export default function ShipOrdersPage() {
  return (
    <div className="flex flex-col gap-6 px-6 py-6 max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Truck className="h-6 w-6 text-white/60 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-white">Ship Orders</h1>
          <p className="text-sm text-white/50 mt-0.5">
            Paste order numbers and tracking numbers to mark awaiting-shipment orders as
            shipped across eBay TPP, eBay TT, BigCommerce, and Shopify. Carrier is always
            USPS. eBay orders are auto-detected between TPP and TT.
          </p>
        </div>
      </div>

      <ShipOrdersPanel />
    </div>
  );
}
