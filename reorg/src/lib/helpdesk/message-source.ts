/**
 * Pure classifier for `HelpdeskMessageSource` on a freshly-synced eBay
 * message. Lives here (rather than inline in helpdesk-ebay-sync.ts) so it
 * can be unit-tested without spinning up Prisma or the sync runtime.
 *
 * Classification order matters — we check the most specific signal first:
 *   1. Inbound is always EBAY (buyer-facing).
 *   2. Outbound with our reorG envelope → EBAY (we sent it through the
 *      outbound queue, so the externalMessageID we wrote starts with
 *      "reorg:").
 *   3. Outbound whose eBay messageID was logged by the Auto Responder →
 *      AUTO_RESPONDER (overrides the EBAY_UI catch-all).
 *   4. Otherwise → EBAY_UI (sent on eBay's web UI by a human agent).
 *
 * The AR override step matters for two downstream behaviours:
 *   - The thread renders AR messages with a Bot avatar / dashed border so
 *     agents don't mistake them for human replies.
 *   - The status-change side of sync skips the WAITING transition for AR
 *     messages, since an automated welcome reply shouldn't be treated as
 *     "ball in buyer's court".
 */

import { HelpdeskMessageSource, HelpdeskMessageDirection } from "@prisma/client";

export interface MessageSourceInputs {
  direction: HelpdeskMessageDirection;
  /** eBay's stable message id (Trading API `MessageID`). */
  ebayMessageId: string | null | undefined;
  /**
   * `ExternalMessageID` from the Trading API. We stamp it with a
   * `reorg:<jobId>` prefix when our outbound worker sends a message,
   * which lets us recognise our own envelopes after the round-trip.
   */
  externalMessageId: string | null | undefined;
  /**
   * Set of eBay messageIds known to have been sent by the Auto Responder
   * (loaded once per batch from `AutoResponderSendLog`). May be empty if
   * the AR feature is disabled or the batch has no outbound messages.
   */
  autoResponderMessageIds: ReadonlySet<string>;
}

export function classifyMessageSource(
  input: MessageSourceInputs,
): HelpdeskMessageSource {
  if (input.direction === HelpdeskMessageDirection.INBOUND) {
    return HelpdeskMessageSource.EBAY;
  }
  if (input.externalMessageId && input.externalMessageId.startsWith("reorg:")) {
    return HelpdeskMessageSource.EBAY;
  }
  if (
    input.ebayMessageId &&
    input.autoResponderMessageIds.has(input.ebayMessageId)
  ) {
    return HelpdeskMessageSource.AUTO_RESPONDER;
  }
  return HelpdeskMessageSource.EBAY_UI;
}
