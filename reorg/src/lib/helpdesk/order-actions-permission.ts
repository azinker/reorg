const HELPDESK_ORDER_ACTION_ALLOWED_EMAILS = new Set([
  "adam@theperfectpart.net",
  "mlmaschi@icloud.com",
]);

export function canUseHelpdeskOrderActionsPermission(input: {
  email?: string | null;
  helpdeskOrderActionsEnabled?: boolean | null;
}) {
  const email = input.email?.trim().toLowerCase();
  return Boolean(input.helpdeskOrderActionsEnabled) || Boolean(email && HELPDESK_ORDER_ACTION_ALLOWED_EMAILS.has(email));
}
