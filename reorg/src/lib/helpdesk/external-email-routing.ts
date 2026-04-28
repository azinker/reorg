import { createHmac, timingSafeEqual } from "crypto";

const REPLY_ADDRESS_PREFIX = "helpdesk";
const ROUTE_SIGNATURE_BYTES = 12;

export interface ParsedMailbox {
  name: string | null;
  address: string;
  local: string;
  domain: string;
}

export interface HelpdeskReplyRoute {
  ticketId: string;
  address: string;
  recipient: string;
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function helpdeskReplySecretFromEnv(): string | null {
  return process.env.HELPDESK_EMAIL_REPLY_SECRET ?? process.env.AUTH_SECRET ?? null;
}

export function helpdeskReplyDomainFromEnv(): string | null {
  const value = process.env.HELPDESK_RESEND_REPLY_DOMAIN;
  return value ? normalizeDomain(value) : null;
}

export function parseMailbox(value: string | null | undefined): ParsedMailbox | null {
  const raw = value?.trim();
  if (!raw) return null;

  const angleMatch = raw.match(/^(.*?)<([^<>@\s]+@[^<>@\s]+)>$/);
  const address = (angleMatch ? angleMatch[2] : raw)
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;

  const name = angleMatch?.[1]
    ? angleMatch[1].trim().replace(/^"|"$/g, "") || null
    : null;
  return {
    name,
    address,
    local: address.slice(0, at),
    domain: address.slice(at + 1),
  };
}

export function signHelpdeskReplyRoute(ticketId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`helpdesk-email-reply:${ticketId}`)
    .digest("hex")
    .slice(0, ROUTE_SIGNATURE_BYTES * 2);
}

export function verifyHelpdeskReplyRoute(
  ticketId: string,
  signature: string,
  secret: string,
): boolean {
  const expected = signHelpdeskReplyRoute(ticketId, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function buildHelpdeskReplyAddress(args: {
  ticketId: string;
  domain: string;
  secret: string;
}): string {
  const domain = normalizeDomain(args.domain);
  const signature = signHelpdeskReplyRoute(args.ticketId, args.secret);
  return `${REPLY_ADDRESS_PREFIX}-${args.ticketId}-${signature}@${domain}`;
}

export function buildHelpdeskReplyToHeader(args: {
  ticketId: string;
  domain: string;
  secret: string;
  displayName?: string | null;
}): string {
  const address = buildHelpdeskReplyAddress(args);
  const displayName = args.displayName?.trim() || "Sales";
  return `${displayName} <${address}>`;
}

export function findHelpdeskReplyRoute(args: {
  recipients: string[];
  secret: string;
  domain?: string | null;
}): HelpdeskReplyRoute | null {
  const allowedDomain = args.domain ? normalizeDomain(args.domain) : null;
  for (const recipient of args.recipients) {
    const mailbox = parseMailbox(recipient);
    if (!mailbox) continue;
    if (allowedDomain && mailbox.domain !== allowedDomain) continue;

    const match = mailbox.local.match(/^helpdesk-([a-z0-9]+)-([a-z0-9_-]+)$/i);
    if (!match) continue;

    const ticketId = match[1];
    const signature = match[2];
    if (!verifyHelpdeskReplyRoute(ticketId, signature, args.secret)) continue;

    return {
      ticketId,
      address: mailbox.address,
      recipient,
    };
  }
  return null;
}

export function stripQuotedEmailText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const quoteStart = lines.findIndex((line, index) => {
    if (index === 0) return false;
    const trimmed = line.trim();
    return (
      /^on .+wrote:$/i.test(trimmed) ||
      /^-----original message-----$/i.test(trimmed) ||
      /^from:\s.+@.+$/i.test(trimmed)
    );
  });
  const candidate = quoteStart > 0 ? lines.slice(0, quoteStart) : lines;
  while (candidate.length > 0) {
    const last = candidate[candidate.length - 1]?.trim() ?? "";
    if (last === "" || last.startsWith(">")) {
      candidate.pop();
      continue;
    }
    break;
  }
  return candidate.join("\n").trim();
}
