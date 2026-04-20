/**
 * @mention extraction for help-desk notes.
 *
 * Format: @username where username is either the email local-part (the bit
 * before the @) or the user's name with whitespace dropped. We look up users
 * via case-insensitive matches and create HelpdeskNotification rows for any
 * matched user other than the author.
 */

import { db } from "@/lib/db";

const MENTION_RE = /(?:^|\s)@([A-Za-z0-9._-]{2,64})/g;

export function extractMentionHandles(body: string): string[] {
  const handles = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    handles.add(match[1].toLowerCase());
  }
  return Array.from(handles);
}

export interface MentionResult {
  matched: { userId: string; handle: string }[];
  unmatched: string[];
}

export async function resolveMentions(
  handles: string[],
): Promise<MentionResult> {
  if (handles.length === 0) return { matched: [], unmatched: [] };
  const all = await db.user.findMany({
    select: { id: true, email: true, name: true },
  });
  const byHandle: Record<string, string> = {}; // handle.toLowerCase() -> userId
  for (const u of all) {
    const local = u.email.split("@")[0].toLowerCase();
    if (local) byHandle[local] = u.id;
    if (u.name) {
      const compact = u.name.replace(/\s+/g, "").toLowerCase();
      if (compact && !byHandle[compact]) byHandle[compact] = u.id;
    }
  }
  const matched: { userId: string; handle: string }[] = [];
  const unmatched: string[] = [];
  for (const h of handles) {
    const userId = byHandle[h];
    if (userId) matched.push({ userId, handle: h });
    else unmatched.push(h);
  }
  return { matched, unmatched };
}

/**
 * Create HelpdeskNotification rows for matched mentioned users (skipping the
 * author). Safe to call inside a transaction-less context; we swallow per-user
 * errors so a single bad row doesn't lose every notification.
 */
export async function fanOutMentionNotifications(args: {
  ticketId: string;
  noteId: string;
  authorUserId: string;
  body: string;
  matched: { userId: string; handle: string }[];
}): Promise<{ created: number }> {
  const { ticketId, authorUserId, body, matched } = args;
  if (matched.length === 0) return { created: 0 };

  const ticket = await db.helpdeskTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, buyerName: true, buyerUserId: true, subject: true },
  });
  if (!ticket) return { created: 0 };

  const recipients = matched.filter((m) => m.userId !== authorUserId);
  if (recipients.length === 0) return { created: 0 };

  const subject =
    ticket.subject ?? `${ticket.buyerName ?? ticket.buyerUserId ?? "Buyer"}`;
  const preview = body.slice(0, 200);

  let created = 0;
  for (const r of recipients) {
    try {
      await db.helpdeskNotification.create({
        data: {
          recipientId: r.userId,
          ticketId,
          kind: "MENTION",
          bodyText: `@${r.handle} mentioned you on “${subject}”: ${preview}`,
          url: `/help-desk?ticket=${ticketId}`,
        },
      });
      created++;
    } catch {
      // best-effort
    }
  }
  return { created };
}
