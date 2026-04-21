/**
 * Canonical Help Desk inbox column registry.
 *
 * Lives in /lib so both the route handler and any client component can
 * import these constants without dragging the route module (and its
 * Next.js handler typing constraints) into the import graph.
 *
 * Adding a column = adding a key here AND wiring a renderer in
 * `TicketTable.tsx`. The route handler validates incoming PUT payloads
 * against this list to keep stale clients from poisoning the persisted
 * column preferences.
 */

export const KNOWN_COLUMN_KEYS = [
  "channel",
  "customer",
  "type",
  "latestUpdate",
  "owner",
  "timeLeft",
  "created",
  "status",
  "orderId",
  "ebayUsername",
] as const;

export type HelpdeskColumnKey = (typeof KNOWN_COLUMN_KEYS)[number];

export const DEFAULT_COLUMNS: HelpdeskColumnKey[] = [...KNOWN_COLUMN_KEYS];
