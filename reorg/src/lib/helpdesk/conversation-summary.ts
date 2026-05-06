const HELP_DESK_TIME_ZONE = "America/New_York";

export interface HelpdeskTimelineEvent {
  id: string;
  type: "system";
  action: string;
  kind: string;
  text: string;
  shortText?: string | null;
  href?: string | null;
  externalId?: string | null;
  holdUntil?: string | null;
  deadlineAt?: string | null;
  deadlineLabel?: string | null;
  trackingNumber?: string | null;
  estimatedDeliveryText?: string | null;
  actor?: unknown;
  at: string;
}

export interface ConversationMessage {
  direction: "INBOUND" | "OUTBOUND";
  source: "EBAY" | "EBAY_UI" | "EXTERNAL_EMAIL" | "SYSTEM" | "AUTO_RESPONDER";
  subject: string | null;
  bodyText: string;
  sentAt: string;
  fromName: string | null;
  fromIdentifier: string | null;
}

export interface ConversationTicket {
  subject: string | null;
  buyerName: string | null;
  buyerUserId: string | null;
  ebayOrderNumber: string | null;
  ebayItemTitle: string | null;
  type: string;
  status: string;
  messages: ConversationMessage[];
}

export interface CaseStatusSummary {
  title: string;
  caseId: string | null;
  caseUrl: string | null;
  status:
    | "Open"
    | "In Transit Back"
    | "Awaiting Refund"
    | "Refunded"
    | "Escalated to eBay"
    | "On Hold"
    | "Closed";
  tone: "amber" | "sky" | "emerald" | "neutral";
  openedAt: string | null;
  returnShippedAt: string | null;
  returnDeliveredAt: string | null;
  refundDueAt: string | null;
  escalatedAt: string | null;
  holdAt: string | null;
  holdUntil: string | null;
  closedAt: string | null;
  latestEventText: string | null;
  agentNote: string;
}

export function buildCaseStatusSummary(
  events: HelpdeskTimelineEvent[],
  messages: ConversationMessage[] = [],
): CaseStatusSummary | null {
  const caseEvents = events
    .filter(isCaseEvent)
    .slice()
    .sort((a, b) => dateMs(a.at) - dateMs(b.at));

  if (caseEvents.length === 0) return null;

  const opened = caseEvents.find(isOpenCaseEvent) ?? null;
  const returnShipped = last(caseEvents.filter(isReturnShippedEvent));
  const returnDelivered = last(caseEvents.filter(isReturnDeliveredEvent));
  const refundDue = last(caseEvents.filter(isRefundDueEvent));
  const escalated = last(caseEvents.filter(isEscalatedCaseEvent));
  const hold = last(caseEvents.filter(isHoldCaseEvent));
  const refunded = last(caseEvents.filter(isReturnRefundedEvent));
  const refundDueAt = refundDue?.deadlineAt ?? returnDelivered?.deadlineAt ?? null;
  const closed = last(
    [...caseEvents.filter(isClosedCaseEvent), ...(refunded ? [refunded] : [])].sort(
      (a, b) => dateMs(a.at) - dateMs(b.at),
    ),
  );
  const latest = last(caseEvents);
  const holdUntil = findHoldUntil(events, messages);
  const linkedCaseEvent =
    caseEvents.find((event) => event.externalId || event.href) ?? null;
  const title = inferCaseTitle(caseEvents, messages);

  let status: CaseStatusSummary["status"] = "Open";
  let tone: CaseStatusSummary["tone"] = "amber";
  if (refunded && (!hold || dateMs(refunded.at) >= dateMs(hold.at))) {
    status = "Refunded";
    tone = "emerald";
  } else if (closed && (!hold || dateMs(closed.at) >= dateMs(hold.at))) {
    status = "Closed";
    tone = "emerald";
  } else if (hold) {
    status = "On Hold";
    tone = "sky";
  } else if (refundDue || returnDelivered) {
    status = "Awaiting Refund";
    tone = "amber";
  } else if (returnShipped) {
    status = "In Transit Back";
    tone = "amber";
  } else if (escalated) {
    status = "Escalated to eBay";
    tone = "amber";
  }

  const agentNote =
    status === "On Hold"
      ? holdUntil
        ? `eBay has the case on hold until ${holdUntil}. Monitor delivery and be ready before that date.`
        : "eBay has the case on hold. Monitor delivery and watch for the next case update."
      : status === "Awaiting Refund"
        ? findDeadlineLabel(refundDue, "Refund Due")
          ? `The returned item is back. Refund is due by ${findDeadlineLabel(refundDue, "Refund Due")}.`
          : refundDueAt
            ? `The returned item is back. Refund is due by ${formatHelpdeskDate(refundDueAt)}.`
          : "The returned item is back. Inspect it and issue the refund if everything checks out."
        : status === "In Transit Back"
          ? "The buyer shipped the return back. Wait for delivery, then inspect the item before refunding."
          : status === "Escalated to eBay"
        ? "The buyer escalated this to eBay. Keep replies factual and align next steps with the case state."
        : status === "Refunded"
          ? "The return case is refunded. Confirm no follow-up from the buyer is still waiting before closing related work."
        : status === "Closed"
          ? "The case appears closed. Confirm the outcome before promising any additional resolution."
          : "The case appears open. Keep the agent response tied to tracking, delivery, refund, or replacement status.";

  return {
    title,
    caseId: linkedCaseEvent?.externalId ?? null,
    caseUrl: linkedCaseEvent?.href ?? null,
    status,
    tone,
    openedAt: opened?.at ?? null,
    returnShippedAt: returnShipped?.at ?? null,
    returnDeliveredAt: returnDelivered?.at ?? null,
    refundDueAt,
    escalatedAt: escalated?.at ?? null,
    holdAt: hold?.at ?? null,
    holdUntil,
    closedAt: closed?.at ?? null,
    latestEventText: latest?.shortText ?? latest?.text ?? null,
    agentNote,
  };
}

export function buildConversationSummary(
  ticket: ConversationTicket,
  events: HelpdeskTimelineEvent[],
): string[] {
  const lines: string[] = [];
  const orderReceived = firstEventByActions(events, ["EBAY_ORDER_RECEIVED", "ORDER_RECEIVED"]);
  const orderShipped = firstEventByActions(events, ["EBAY_ORDER_SHIPPED", "ORDER_SHIPPED"]);
  const trackingAdded = last(
    events.filter((event) =>
      ["EBAY_ORDER_TRACKING_ADDED", "ORDER_TRACKING_ADDED"].includes(event.action),
    ),
  );
  const caseSummary = buildCaseStatusSummary(events, ticket.messages);
  const latestBuyer = latestMessage(ticket.messages, "INBOUND");
  const latestAgent = latestMessage(ticket.messages, "OUTBOUND");

  const buyerLabel = ticket.buyerName ?? ticket.buyerUserId ?? "Buyer";
  const product = ticket.ebayItemTitle ? compactText(ticket.ebayItemTitle, 80) : null;

  if (ticket.ebayOrderNumber || product) {
    lines.push(
      [
        ticket.ebayOrderNumber ? `Order ${ticket.ebayOrderNumber}` : "Order",
        product ? `for ${product}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  if (orderReceived) {
    lines.push(`Order received ${formatHelpdeskDate(orderReceived.at)}.`);
  }
  if (orderShipped) {
    const tracking = trackingAdded?.trackingNumber
      ? ` Tracking ${trackingAdded.trackingNumber}.`
      : "";
    lines.push(`Order shipped ${formatHelpdeskDate(orderShipped.at)}.${tracking}`);
  } else if (trackingAdded?.trackingNumber) {
    lines.push(`Tracking on file: ${trackingAdded.trackingNumber}.`);
  }

  if (caseSummary) {
    const caseLineParts = [
      `${caseSummary.title}: ${caseSummary.status.toLowerCase()}`,
      caseSummary.openedAt ? `opened ${formatHelpdeskDate(caseSummary.openedAt)}` : null,
      caseSummary.returnShippedAt
        ? `buyer shipped back ${formatHelpdeskDate(caseSummary.returnShippedAt)}`
        : null,
      caseSummary.returnDeliveredAt
        ? `returned item delivered ${formatHelpdeskDate(caseSummary.returnDeliveredAt)}`
        : null,
      caseSummary.refundDueAt
        ? `refund due ${formatHelpdeskDate(caseSummary.refundDueAt)}`
        : null,
      caseSummary.escalatedAt
        ? `escalated ${formatHelpdeskDate(caseSummary.escalatedAt)}`
        : null,
      caseSummary.holdAt ? `held ${formatHelpdeskDate(caseSummary.holdAt)}` : null,
      caseSummary.holdUntil ? `hold expires ${caseSummary.holdUntil}` : null,
      caseSummary.closedAt ? `closed ${formatHelpdeskDate(caseSummary.closedAt)}` : null,
    ].filter(Boolean);
    lines.push(caseLineParts.join("; ") + ".");
  }

  if (latestBuyer) {
    lines.push(
      `Latest buyer message from ${buyerLabel}: "${compactText(latestBuyer.bodyText, 130)}"`,
    );
  }
  if (latestAgent) {
    lines.push(`Latest agent reply: "${compactText(latestAgent.bodyText, 130)}"`);
  }

  if (caseSummary?.status === "On Hold") {
    lines.push(caseSummary.agentNote);
  } else if (ticket.status === "RESOLVED") {
    lines.push("Ticket is currently resolved; buyer reply will bring it back to To Do.");
  }

  return dedupe(lines).slice(0, 7);
}

export function formatHelpdeskDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  const now = new Date();
  const includeYear =
    date.toLocaleDateString("en-US", {
      timeZone: HELP_DESK_TIME_ZONE,
      year: "numeric",
    }) !==
    now.toLocaleDateString("en-US", {
      timeZone: HELP_DESK_TIME_ZONE,
      year: "numeric",
    });

  return date.toLocaleDateString("en-US", {
    timeZone: HELP_DESK_TIME_ZONE,
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
  });
}

function isCaseEvent(event: HelpdeskTimelineEvent): boolean {
  return (
    event.kind === "case" ||
    /^EBAY_(CASE|ITEM_NOT_RECEIVED|RETURN|BUYER_CANCEL|REFUND)/.test(event.action) ||
    /case|claim|return|item not received|refund|cancel/i.test(event.text)
  );
}

function isOpenCaseEvent(event: HelpdeskTimelineEvent): boolean {
  return (
    event.action === "EBAY_CASE_OPENED" ||
    event.action === "EBAY_ITEM_NOT_RECEIVED_CASE" ||
    event.action === "EBAY_RETURN_OPENED" ||
    /opened|item not received request/i.test(event.text)
  );
}

function isEscalatedCaseEvent(event: HelpdeskTimelineEvent): boolean {
  return event.action === "EBAY_CASE_ESCALATED" || /escalated|opened case on ebay/i.test(event.text);
}

function isReturnShippedEvent(event: HelpdeskTimelineEvent): boolean {
  return event.action === "EBAY_RETURN_BUYER_SHIPPED" || /buyer shipped item back/i.test(event.text);
}

function isReturnDeliveredEvent(event: HelpdeskTimelineEvent): boolean {
  return event.action === "EBAY_RETURN_DELIVERED" || /returned item delivered/i.test(event.text);
}

function isRefundDueEvent(event: HelpdeskTimelineEvent): boolean {
  return event.action === "EBAY_RETURN_REFUND_DUE" || /refund due/i.test(event.text);
}

function isReturnRefundedEvent(event: HelpdeskTimelineEvent): boolean {
  return (
    event.action === "EBAY_RETURN_REFUNDED" ||
    /refund issued for return|return case refunded/i.test(event.text)
  );
}

function isHoldCaseEvent(event: HelpdeskTimelineEvent): boolean {
  return event.action === "EBAY_CASE_ON_HOLD" || /on hold|put .*hold/i.test(event.text);
}

function isClosedCaseEvent(event: HelpdeskTimelineEvent): boolean {
  return event.action === "EBAY_CASE_CLOSED" || /closed/i.test(event.text);
}

function inferCaseTitle(events: HelpdeskTimelineEvent[], messages: ConversationMessage[]): string {
  const haystack = [
    ...events.map((event) => `${event.action} ${event.text}`),
    ...messages.map((message) => `${message.subject ?? ""} ${message.bodyText}`),
  ].join(" ");
  if (/item not received|INR/i.test(haystack)) return "Item Not Received Case";
  if (/return/i.test(haystack)) return "Return Case";
  if (/cancel/i.test(haystack)) return "Cancellation Request";
  if (/refund/i.test(haystack)) return "Refund Case";
  return "eBay Case";
}

function findHoldUntil(
  events: HelpdeskTimelineEvent[],
  messages: ConversationMessage[],
): string | null {
  const haystacks = [
    ...events.map((event) => event.text),
    ...messages.map((message) => `${message.subject ?? ""}\n${message.bodyText}`),
  ];
  for (const text of haystacks) {
    const match =
      /\bon hold until\s+([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})/i.exec(text) ??
      /\bupdate by\s+([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})/i.exec(text) ??
      /\buntil\s+([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})/i.exec(text);
    if (!match) continue;
    const parsed = new Date(match[1]);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toLocaleDateString("en-US", {
        timeZone: HELP_DESK_TIME_ZONE,
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  const eventHoldUntil = events
    .map((event) => event.holdUntil)
    .find((value): value is string => Boolean(value));
  if (eventHoldUntil) return normalizeHoldUntil(eventHoldUntil);
  return null;
}

function normalizeHoldUntil(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    timeZone: HELP_DESK_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function findDeadlineLabel(
  event: HelpdeskTimelineEvent | null,
  label: string,
): string | null {
  if (!event?.deadlineAt) return null;
  if (event.deadlineLabel && event.deadlineLabel !== label) return null;
  return formatHelpdeskDate(event.deadlineAt);
}

function firstEventByActions(
  events: HelpdeskTimelineEvent[],
  actions: string[],
): HelpdeskTimelineEvent | null {
  return events
    .filter((event) => actions.includes(event.action))
    .sort((a, b) => dateMs(a.at) - dateMs(b.at))[0] ?? null;
}

function latestMessage(
  messages: ConversationMessage[],
  direction: ConversationMessage["direction"],
): ConversationMessage | null {
  return last(
    messages
      .filter((message) => message.direction === direction && message.source !== "SYSTEM")
      .slice()
      .sort((a, b) => dateMs(a.sentAt) - dateMs(b.sentAt)),
  );
}

function compactText(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function dateMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function last<T>(items: T[]): T | null {
  return items.length ? items[items.length - 1] : null;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}
