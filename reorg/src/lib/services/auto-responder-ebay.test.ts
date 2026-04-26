import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDeliveryDates,
  extractTrackingFromOrder,
  extractTrackingNumbersFromOrder,
  parseXmlSimple,
} from "@/lib/services/auto-responder-ebay";

// Minimal GetOrders XML modeled on a real CompleteSale flow (USPS, single
// transaction). Captured against order 03-14290-90166 where the bug was
// originally reported. The 22-digit tracking number is intentionally a string
// that fast-xml-parser will try to coerce into a JS number; the parser config
// must keep it as a string or downstream rendering breaks.
const SAMPLE_XML = `<?xml version="1.0"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <OrderArray>
    <Order>
      <OrderID>03-14290-90166</OrderID>
      <BuyerUserID>example_buyer</BuyerUserID>
      <ShippedTime>2026-02-26T17:00:00.000Z</ShippedTime>
      <ShippingServiceSelected>
        <ShippingService>USPSParcel</ShippingService>
        <ShippingPackageInfo>
          <ActualDeliveryTime>2026-03-02T12:42:00.000Z</ActualDeliveryTime>
        </ShippingPackageInfo>
      </ShippingServiceSelected>
      <TransactionArray>
        <Transaction>
          <Buyer>
            <UserFirstName>Example</UserFirstName>
            <UserLastName>Buyer</UserLastName>
          </Buyer>
          <Item><ItemID>123</ItemID><Title>Sample item</Title></Item>
          <ShippingDetails>
            <ShipmentTrackingDetails>
              <ShippingCarrierUsed>USPS</ShippingCarrierUsed>
              <ShipmentTrackingNumber>9401903308746074150623</ShipmentTrackingNumber>
            </ShipmentTrackingDetails>
          </ShippingDetails>
          <ShippingServiceSelected>
            <ShippingPackageInfo>
              <ActualDeliveryTime>2026-03-02T12:42:00.000Z</ActualDeliveryTime>
              <EstimatedDeliveryTimeMin>2026-02-26T08:00:00.000Z</EstimatedDeliveryTimeMin>
              <EstimatedDeliveryTimeMax>2026-03-02T08:00:00.000Z</EstimatedDeliveryTimeMax>
            </ShippingPackageInfo>
          </ShippingServiceSelected>
        </Transaction>
      </TransactionArray>
    </Order>
  </OrderArray>
</GetOrdersResponse>`;

function getOrder(): Record<string, unknown> {
  const parsed = parseXmlSimple(SAMPLE_XML);
  const root = parsed.GetOrdersResponse as Record<string, unknown>;
  const orderArray = root.OrderArray as Record<string, unknown>;
  const orders = orderArray.Order as Array<Record<string, unknown>>;
  return orders[0];
}

function getFirstTransaction(
  order: Record<string, unknown>,
): Record<string, unknown> {
  const ta = order.TransactionArray as Record<string, unknown>;
  const rawTx = ta.Transaction;
  const txs = (Array.isArray(rawTx) ? rawTx : [rawTx]) as Array<
    Record<string, unknown>
  >;
  return txs[0];
}

test("parseXmlSimple keeps 22-digit tracking numbers as strings", () => {
  // Without parseTagValue: false, fast-xml-parser converts the number into
  // JS's nearest double (9.401903308746074e+21) and the carrier's tracking
  // page errors out. This guards the parser config that prevents that.
  const order = getOrder();
  const tx = getFirstTransaction(order);
  const sd = tx.ShippingDetails as Record<string, unknown>;
  const std = (sd.ShipmentTrackingDetails as Array<Record<string, unknown>>)[0];
  assert.equal(typeof std.ShipmentTrackingNumber, "string");
  assert.equal(std.ShipmentTrackingNumber, "9401903308746074150623");
});

test("parseXmlSimple keeps the 14-char OrderID intact", () => {
  // OrderID looks numeric-with-dashes but eBay's hyphenated form should never
  // be coerced; this is a regression guard if anyone tweaks parser options.
  const order = getOrder();
  assert.equal(typeof order.OrderID, "string");
  assert.equal(order.OrderID, "03-14290-90166");
});

test("extractTrackingFromOrder finds the carrier and number on Transaction.ShippingDetails", () => {
  // This is the most common CompleteSale path — the failure mode this fix
  // addressed was the parser eating the number, not the extractor missing
  // the path. Both must work together.
  const order = getOrder();
  const result = extractTrackingFromOrder(order);
  assert.equal(result.carrier, "USPS");
  assert.equal(result.number, "9401903308746074150623");
});

test("extractTrackingNumbersFromOrder returns every tracking number with upload date fallback", () => {
  const xml = `<?xml version="1.0"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderArray>
    <Order>
      <OrderID>21-14438-90782</OrderID>
      <ShippedTime>2026-04-16T13:54:57.000Z</ShippedTime>
      <TransactionArray>
        <Transaction>
          <Shipment>
            <ShipmentTrackingDetails>
              <ShippingCarrierUsed>USPS</ShippingCarrierUsed>
              <ShipmentTrackingNumber>9401903308742461287149</ShipmentTrackingNumber>
            </ShipmentTrackingDetails>
            <ShipmentTrackingDetails>
              <ShippingCarrierUsed>USPS</ShippingCarrierUsed>
              <ShipmentTrackingNumber>9235990374019711425326</ShipmentTrackingNumber>
            </ShipmentTrackingDetails>
          </Shipment>
        </Transaction>
      </TransactionArray>
    </Order>
  </OrderArray>
</GetOrdersResponse>`;
  const parsed = parseXmlSimple(xml);
  const order = (
    (parsed.GetOrdersResponse as Record<string, unknown>)
      .OrderArray as Record<string, unknown>
  ).Order as Record<string, unknown>[];
  const result = extractTrackingNumbersFromOrder(order[0]);
  assert.deepEqual(result, [
    {
      carrier: "USPS",
      number: "9401903308742461287149",
      shippedTime: "2026-04-16T13:54:57.000Z",
    },
    {
      carrier: "USPS",
      number: "9235990374019711425326",
      shippedTime: "2026-04-16T13:54:57.000Z",
    },
  ]);
});

test("extractTrackingFromOrder returns nulls when no tracking is present", () => {
  const xml = `<?xml version="1.0"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderArray>
    <Order>
      <OrderID>11-22222-33333</OrderID>
      <TransactionArray>
        <Transaction>
          <Item><ItemID>1</ItemID></Item>
        </Transaction>
      </TransactionArray>
    </Order>
  </OrderArray>
</GetOrdersResponse>`;
  const parsed = parseXmlSimple(xml);
  const order = (
    (parsed.GetOrdersResponse as Record<string, unknown>)
      .OrderArray as Record<string, unknown>
  ).Order as Record<string, unknown>[];
  const result = extractTrackingFromOrder(order[0]);
  assert.equal(result.number, null);
  assert.equal(result.carrier, null);
});

test("extractDeliveryDates pulls min/max from Transaction.ShippingServiceSelected.ShippingPackageInfo", () => {
  // The whole reason estimated-delivery was blank in the right rail: this
  // fallback was missing. eBay returns delivery windows on the package node
  // for any order with handling time configured, which is most TPP volume.
  const order = getOrder();
  const tx = getFirstTransaction(order);
  const dates = extractDeliveryDates(order, tx);
  assert.equal(dates.estimatedMin, "2026-02-26T08:00:00.000Z");
  assert.equal(dates.estimatedMax, "2026-03-02T08:00:00.000Z");
});

test("extractDeliveryDates surfaces ActualDeliveryTime when carrier confirms delivery", () => {
  const order = getOrder();
  const tx = getFirstTransaction(order);
  const dates = extractDeliveryDates(order, tx);
  assert.equal(dates.actualDeliveryTime, "2026-03-02T12:42:00.000Z");
});

test("extractDeliveryDates prefers Order.EstimatedDeliveryDateMin when present", () => {
  // When eBay returns the legacy order-level shape, that wins over the
  // package-level fallback. Guards against a future regression where
  // someone re-orders the precedence in extractDeliveryDates.
  const xml = `<?xml version="1.0"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderArray>
    <Order>
      <OrderID>11-22222-33333</OrderID>
      <EstimatedDeliveryDateMin>2026-04-01T00:00:00.000Z</EstimatedDeliveryDateMin>
      <EstimatedDeliveryDateMax>2026-04-03T00:00:00.000Z</EstimatedDeliveryDateMax>
      <TransactionArray>
        <Transaction>
          <Item><ItemID>1</ItemID></Item>
          <ShippingServiceSelected>
            <ShippingPackageInfo>
              <EstimatedDeliveryTimeMin>2099-01-01T00:00:00.000Z</EstimatedDeliveryTimeMin>
            </ShippingPackageInfo>
          </ShippingServiceSelected>
        </Transaction>
      </TransactionArray>
    </Order>
  </OrderArray>
</GetOrdersResponse>`;
  const parsed = parseXmlSimple(xml);
  const order = (
    (parsed.GetOrdersResponse as Record<string, unknown>)
      .OrderArray as Record<string, unknown>
  ).Order as Record<string, unknown>[];
  const tx = (
    order[0].TransactionArray as Record<string, unknown>
  ).Transaction as Record<string, unknown>;
  const dates = extractDeliveryDates(order[0], tx);
  assert.equal(dates.estimatedMin, "2026-04-01T00:00:00.000Z");
  assert.equal(dates.estimatedMax, "2026-04-03T00:00:00.000Z");
});

test("extractDeliveryDates returns nulls when nothing is present", () => {
  const xml = `<?xml version="1.0"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <OrderArray>
    <Order>
      <OrderID>11-22222-33333</OrderID>
      <TransactionArray>
        <Transaction><Item><ItemID>1</ItemID></Item></Transaction>
      </TransactionArray>
    </Order>
  </OrderArray>
</GetOrdersResponse>`;
  const parsed = parseXmlSimple(xml);
  const order = (
    (parsed.GetOrdersResponse as Record<string, unknown>)
      .OrderArray as Record<string, unknown>
  ).Order as Record<string, unknown>[];
  const tx = (
    order[0].TransactionArray as Record<string, unknown>
  ).Transaction as Record<string, unknown>;
  const dates = extractDeliveryDates(order[0], tx);
  assert.equal(dates.estimatedMin, null);
  assert.equal(dates.estimatedMax, null);
  assert.equal(dates.actualDeliveryTime, null);
});
