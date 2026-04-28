import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHelpdeskReplyAddress,
  buildHelpdeskReplyToHeader,
  findHelpdeskReplyRoute,
  parseMailbox,
  stripQuotedEmailText,
  verifyHelpdeskReplyRoute,
} from "./external-email-routing";

const SECRET = "unit-test-secret";
const DOMAIN = "reply.theperfectpart.net";
const TICKET_ID = "cmf2ticketabc123";

describe("external email reply routing", () => {
  it("builds and verifies a ticket-specific reply address", () => {
    const address = buildHelpdeskReplyAddress({
      ticketId: TICKET_ID,
      domain: DOMAIN,
      secret: SECRET,
    });

    assert.match(
      address,
      /^helpdesk-cmf2ticketabc123-[a-z0-9_-]+@reply\.theperfectpart\.net$/,
    );

    const route = findHelpdeskReplyRoute({
      recipients: [`Sales <${address}>`],
      secret: SECRET,
      domain: DOMAIN,
    });

    assert.equal(route?.ticketId, TICKET_ID);
    assert.equal(route?.address, address);
  });

  it("rejects tampered ticket ids or signatures", () => {
    const address = buildHelpdeskReplyAddress({
      ticketId: TICKET_ID,
      domain: DOMAIN,
      secret: SECRET,
    });
    const mailbox = parseMailbox(address);
    assert.ok(mailbox);

    const badAddress = address.replace(TICKET_ID, "cmf2otherabc123");
    assert.equal(
      findHelpdeskReplyRoute({
        recipients: [badAddress],
        secret: SECRET,
        domain: DOMAIN,
      }),
      null,
    );

    assert.equal(
      verifyHelpdeskReplyRoute(TICKET_ID, "bad-signature", SECRET),
      false,
    );
  });

  it("ignores matching-looking addresses on the wrong inbound domain", () => {
    const address = buildHelpdeskReplyAddress({
      ticketId: TICKET_ID,
      domain: DOMAIN,
      secret: SECRET,
    }).replace(DOMAIN, "theperfectpart.net");

    assert.equal(
      findHelpdeskReplyRoute({
        recipients: [address],
        secret: SECRET,
        domain: DOMAIN,
      }),
      null,
    );
  });

  it("formats the Reply-To header with a friendly display name", () => {
    const header = buildHelpdeskReplyToHeader({
      ticketId: TICKET_ID,
      domain: DOMAIN,
      secret: SECRET,
      displayName: "Sales",
    });

    assert.match(header, /^Sales <helpdesk-/);
    assert.match(header, /@reply\.theperfectpart\.net>$/);
  });

  it("strips quoted reply history from plain text inbound emails", () => {
    const text = stripQuotedEmailText(`That worked, thank you!

On Tue, Apr 28, 2026 at 10:00 AM Sales wrote:
> Our previous message
> More quoted text`);

    assert.equal(text, "That worked, thank you!");
  });
});
